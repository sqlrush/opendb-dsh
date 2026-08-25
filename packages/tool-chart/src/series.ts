/**
 * 时间序列纯函数层（可单测，不碰连接）：
 * 指标库里的 TPS/QPS/CPU/缓存命中原料都是**累计计数器**，画图前必须在服务端差分——
 * 让模型拿到原始计数自己算，首个窗口不完整、计数器重置等坑它躲不掉（2026-08-24 截图里
 * 03:30→03:31 那根 3,311 就是半个窗口）。这里统一处理：差分、比例、对齐、降采样、统计。
 */

/** [毫秒时间戳, 值] */
export type Pt = [number, number];

/** 库里 recent() 返回新→旧，这里转成旧→新并去掉非有限值 */
export function toAsc(rows: { time: Date | string | number; value: number }[]): Pt[] {
  return rows
    .map((r): Pt => [new Date(r.time).getTime(), Number(r.value)])
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .sort((a, b) => a[0] - b[0]);
}

/**
 * 累计计数器 → 每秒速率。相邻两点 Δv/Δt；Δt ≤ 0 或 Δv < 0（计数器重置/实例重启）的点丢弃，
 * 不让一根负柱或一根天柱污染整张图。速率点的时间取区间右端（"截至此刻的最近一分钟"）。
 */
export function rate(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i < pts.length; i += 1) {
    const dt = (pts[i][0] - pts[i - 1][0]) / 1000;
    const dv = pts[i][1] - pts[i - 1][1];
    if (dt <= 0 || dv < 0) continue;
    out.push([pts[i][0], dv / dt]);
  }
  return out;
}

/** 两条序列按时间对齐（容差内取最近点），返回 [t, a, b] 三元组 */
export function align(a: Pt[], b: Pt[], toleranceMs = 30_000): [number, number, number][] {
  const out: [number, number, number][] = [];
  let j = 0;
  for (const [t, va] of a) {
    while (j + 1 < b.length && Math.abs(b[j + 1][0] - t) <= Math.abs(b[j][0] - t)) j += 1;
    if (b.length > 0 && Math.abs(b[j][0] - t) <= toleranceMs) out.push([t, va, b[j][1]]);
  }
  return out;
}

/**
 * 两个累计计数器的增量比：Δnum / (Δnum + Δden)。用于缓存命中率（hit/(hit+read)）、
 * CPU 使用率（busy/(busy+idle)）这类"两个计数器合起来是总量"的指标。窗口内两者都无增量则跳过。
 */
export function ratioDelta(num: Pt[], den: Pt[]): Pt[] {
  const al = align(num, den);
  const out: Pt[] = [];
  for (let i = 1; i < al.length; i += 1) {
    const dn = al[i][1] - al[i - 1][1];
    const dd = al[i][2] - al[i - 1][2];
    if (dn < 0 || dd < 0 || dn + dd <= 0) continue;
    out.push([al[i][0], dn / (dn + dd)]);
  }
  return out;
}

/** 两个累计计数器的增量商：Δnum / Δden（如 平均耗时 = Δ总耗时 / Δ调用次数） */
export function divDelta(num: Pt[], den: Pt[]): Pt[] {
  const al = align(num, den);
  const out: Pt[] = [];
  for (let i = 1; i < al.length; i += 1) {
    const dn = al[i][1] - al[i - 1][1];
    const dd = al[i][2] - al[i - 1][2];
    if (dn < 0 || dd <= 0) continue;
    out.push([al[i][0], dn / dd]);
  }
  return out;
}

/** 两个 gauge 序列逐点相除（如 每核负载 = load / num_cpus） */
export function divPoint(a: Pt[], b: Pt[]): Pt[] {
  return align(a, b).filter(([, , d]) => d > 0).map(([t, n, d]) => [t, n / d]);
}

/**
 * 降采样到 ≤ max 点：按时间等分桶取均值；每桶同时保留桶内最大值所在点（尖峰不能被抹平——
 * 用户看趋势图就是为了看尖峰）。点数本来就够少时原样返回。
 */
export function downsample(pts: Pt[], max: number): Pt[] {
  if (pts.length <= max || max < 4) return pts;
  const buckets = Math.max(2, Math.floor(max / 2));
  const t0 = pts[0][0]; const t1 = pts[pts.length - 1][0];
  const span = Math.max(1, t1 - t0);
  const groups: Pt[][] = Array.from({ length: buckets }, () => []);
  for (const p of pts) {
    const idx = Math.min(buckets - 1, Math.floor(((p[0] - t0) / span) * buckets));
    groups[idx].push(p);
  }
  const out: Pt[] = [];
  for (const g of groups) {
    if (g.length === 0) continue;
    const avgT = g.reduce((s, p) => s + p[0], 0) / g.length;
    const avgV = g.reduce((s, p) => s + p[1], 0) / g.length;
    const peak = g.reduce((m, p) => (p[1] > m[1] ? p : m), g[0]);
    out.push([avgT, avgV]);
    if (g.length > 1 && peak[1] > avgV * 1.15) out.push(peak);   // 明显高于均值的尖峰单独保留
  }
  return out.sort((a, b) => a[0] - b[0]);
}

export interface SeriesStats { min: number; max: number; avg: number; last: number; n: number; maxAt?: number }

export function stats(pts: Pt[]): SeriesStats {
  if (pts.length === 0) return { min: 0, max: 0, avg: 0, last: 0, n: 0 };
  let min = Infinity; let max = -Infinity; let sum = 0; let maxAt = pts[0][0];
  for (const [t, v] of pts) { if (v < min) min = v; if (v > max) { max = v; maxAt = t; } sum += v; }
  return { min, max, avg: sum / pts.length, last: pts[pts.length - 1][1], n: pts.length, maxAt };
}

/** 数值保留 4 位有效小数，payload 里不带一长串浮点尾巴 */
export const round4 = (v: number): number => Math.round(v * 10000) / 10000;
