/** k8s 集群状态面板共用：设计 token（dsh 原生实测值）+ 格式化。纯函数，无 React。 */
export const T = {
  ink: '#0f1115', sub: '#61666b', dim: '#81858c', blue: '#4176e6',
  line: 'rgba(0,0,0,.08)', fill: '#f7f8fa', fill2: '#f2f3f5', rest: '#dde0e5',
  ext: '#e0963f',
  lv: {
    ok: '#3fa552', notice: '#c9862d', warn: '#e07a1f', crit: '#d64545', off: '#dde0e5', unknown: '#adb2b8',
  } as Record<string, string>,
  soft: {
    ok: '#e8f5ec', notice: '#faf3e5', warn: '#fdf0e3', crit: '#fdecec', off: '#f2f3f5', unknown: '#f2f3f5',
  } as Record<string, string>,
};
export const LVCN: Record<string, string> = { ok: '正常', notice: '关注', warn: '告警', crit: '严重', off: '离线', unknown: '未巡检' };
/** 严重度排序：坏的排前面 */
export const RANK: Record<string, number> = { crit: 0, warn: 1, off: 2, notice: 3, unknown: 4, ok: 5 };
export const BAD = new Set(['crit', 'warn', 'off']);

export const mono = '"JetBrains Mono","SF Mono",Menlo,Consolas,monospace';
export const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
export const tnum: any = { fontVariantNumeric: 'tabular-nums' };

/**
 * 毫核 → 展示（1500m → 1.5 核）。四舍五入到 0 的一律显示 <1m：
 * metrics-server 的采样精度到毫核，空闲 Pod 真的会回 0，写 "0m" 会被读成"没在跑"。
 */
export const fmtCpu = (m: number): string => {
  if (m >= 1000) return `${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 2)} 核`;
  const r = Math.round(m);
  return r === 0 ? '<1m' : `${r}m`;
};
/** MiB → 展示 */
export const fmtMem = (mib: number): string => (mib >= 1024 ? `${(mib / 1024).toFixed(1)}Gi` : `${Math.round(mib)}Mi`);
export const fmtPct = (r: number): string => `${(r * 100).toFixed(r >= 0.1 ? 0 : 1)}%`;
export const fmtInt = (n: number): string => Math.round(Number(n ?? 0)).toLocaleString('en-US');

const pad = (n: number) => String(n).padStart(2, '0');
export const hhmm = (ts: string | number | null): string => { if (ts === null) return '—'; const d = new Date(ts); return Number.isNaN(d.getTime()) ? '—' : `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const mmddhhmm = (ts: string | number | null): string => { if (ts === null) return '—'; const d = new Date(ts); return Number.isNaN(d.getTime()) ? '—' : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm(ts)}`; };
/** 运行时长：3.2 小时 / 12 天 */
export const age = (ts: string | null): string => {
  if (ts === null) return '—';
  const ms = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const h = ms / 3600_000;
  return h < 1 ? `${Math.max(1, Math.round(ms / 60_000))} 分钟` : h < 48 ? `${h.toFixed(1)} 小时` : `${Math.round(h / 24)} 天`;
};
/** 显示名：k8s 真名含 ReplicaSet 哈希不可改，面板统一显示「组件-序号」（同组件多副本按名字排序编号） */
export function displayNames(pods: { name: string; comp: string }[]): Map<string, string> {
  const byComp = new Map<string, string[]>();
  for (const p of pods) byComp.set(p.comp, [...(byComp.get(p.comp) ?? []), p.name]);
  const out = new Map<string, string>();
  for (const [comp, names] of byComp) {
    const sorted = names.slice().sort();
    for (const [i, n] of sorted.entries()) {
      // StatefulSet 真名本身就是稳定序号（postgres-0），直接沿用
      const sts = /-(\d+)$/.exec(n);
      out.set(n, sts !== null ? `${comp}-${sts[1]}` : `${comp}-${i + 1}`);
    }
  }
  return out;
}
