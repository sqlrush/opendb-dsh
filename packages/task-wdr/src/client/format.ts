/** WDR 面板共用：设计 token（dsh 原生实测值）+ 数字格式化。纯函数，无 React。 */
export const T = {
  ink: '#0f1115', sub: '#61666b', dim: '#81858c', blue: '#4176e6',
  line: 'rgba(0,0,0,.08)', fill: '#f7f8fa', fill2: '#f2f3f5', rest: '#dde0e5',
  sev: {
    ok: { c: '#3fa552', soft: '#e8f5ec', cn: '正常' },
    notice: { c: '#c9862d', soft: '#faf3e5', cn: '关注' },
    warn: { c: '#e07a1f', soft: '#fdf0e3', cn: '告警' },
    critical: { c: '#d64545', soft: '#fdecec', cn: '严重' },
  } as Record<string, { c: string; soft: string; cn: string }>,
};
export const sev = (l: string) => T.sev[l] ?? T.sev.ok;
export const mono = '"JetBrains Mono","SF Mono",Menlo,Consolas,monospace';
export const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
export const tnum: any = { fontVariantNumeric: 'tabular-nums' };
export const card: any = { background: '#fff', border: `1px solid ${T.line}`, borderRadius: 8, padding: '16px 20px', boxShadow: '0 4px 12px rgba(0,0,0,.02),0 2px 8px rgba(0,0,0,.04)', minWidth: 0 };
export const keyChip: any = { font: `600 12px ${mono}`, background: T.fill, border: `1px solid ${T.line}`, borderRadius: 5, padding: '1px 7px', color: T.sub, whiteSpace: 'nowrap' };

/** DB Time 构成 / 等待类颜色（与设计稿 wdr-r2.html 一致） */
export const CLASS_COLOR: Record<string, string> = { CPU: '#4176e6', IO: '#e0963f', 网络: '#4fa3d9', '解析/计划': '#b08a5a', PL: '#8b6be0', 其他等待: '#c9ccd2' };
export const WAIT_COLOR: Record<string, string> = { IO_EVENT: '#e0963f', LWLOCK_EVENT: '#8b6be0', LOCK_EVENT: '#d9607a', STATUS: '#9aa3ad' };
export const WAIT_CN: Record<string, string> = { IO_EVENT: 'IO', LWLOCK_EVENT: 'LWLock', LOCK_EVENT: '锁', STATUS: '状态' };
export const ATTR_BADGE: Record<string, { t: string; c: string; bg: string }> = {
  tmp: { t: 'tmp', c: '#6b4fc7', bg: '#f1ecfb' },
  cpu: { t: 'cpu', c: '#2f55b3', bg: '#eef3ff' },
  io: { t: 'io', c: '#e07a1f', bg: '#fdf0e3' },
  blk: { t: 'blk', c: '#d64545', bg: '#fdecec' },
  other: { t: '混合', c: '#61666b', bg: '#f2f3f5' },
};

export const fmtUs = (us: number): string => {
  if (!(us > 0)) return '0';
  if (us >= 3600e6) return `${(us / 3600e6).toFixed(1)} h`;
  if (us >= 60e6) return `${(us / 60e6).toFixed(1)} min`;
  if (us >= 1e6) return `${(us / 1e6).toFixed(us >= 10e6 ? 1 : 2)} s`;
  if (us >= 1e3) return `${(us / 1e3).toFixed(us < 10e3 ? 2 : 0)} ms`;
  return `${Math.round(us)} µs`;
};
/** 秒数直读：≥ 1 s 一律用秒（AWR 口径，不换算成 min/h——08-29 实拍等待事件 "232 s / 1.6 min / 1.5 min" 混排难比大小） */
export const fmtS = (us: number): string => {
  if (us >= 100e6) return `${Math.round(us / 1e6).toLocaleString()} s`;
  if (us >= 10e6) return `${(us / 1e6).toFixed(1)} s`;
  if (us >= 1e6) return `${(us / 1e6).toFixed(2)} s`;
  return fmtUs(us);
};
export const fmtCount = (v: number): string => {
  if (!(v > 0)) return '0';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 1 : 2)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  return Math.round(v).toLocaleString();
};
export const fmtBytes = (b: number): string => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(0)} KB` : `${Math.round(b)} B`);
export const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2)} s` : ms >= 1 ? `${ms.toFixed(ms < 10 ? 2 : 0)} ms` : `${(ms * 1000).toFixed(0)} µs`);
export const fmtLp = (unit: string, v: number): string => (unit === 'us' ? fmtS(v) : unit === 'bytes' ? fmtBytes(v) : fmtCount(v));
/** 检查清单的实测值 / 阈值按判定项换成人话：字节 → GB/MB，比率 → %（采集器给的是原始数，如 19338140760 / 0.9356） */
export function fmtCheckNum(code: string, raw: string): string {
  const m = /^([<>=]*)\s*([0-9.]+)(.*)$/.exec(String(raw).trim());
  if (m === null) return raw;
  const [, cmp, num, rest] = m; const v = Number(num);
  if (Number.isNaN(v) || rest.trim() !== '') return raw;
  const pre = cmp !== '' ? `${cmp} ` : '';
  if (code === 'WDR_TEMP_SPILL') return `${pre}${fmtBytes(v)}`;
  if (code === 'WDR_CACHE_LOW' || code === 'WDR_ROLLBACK_HIGH' || code === 'WDR_CKPT_REQ' || code === 'WDR_SQL_BLOCKED') return v <= 1 ? `${pre}${(v * 100).toFixed(code === 'WDR_CACHE_LOW' ? 2 : 0)}%` : `${pre}${num}`;
  return `${pre}${num}`;
}
export const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
export const hhmm = (ts: string): string => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts).slice(11, 16);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
export const mmdd = (ts: string): string => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts).slice(5, 10);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const mmddhhmm = (ts: string): string => `${mmdd(ts)} ${hhmm(ts)}`;

/**
 * 摘要卡箭头：与上一窗口比。tone：bad = 朝坏的方向变（橙）、good = 朝好的方向变（绿）、flat = 变化 <10%（灰）。
 * kind=ratio 比倍数（≥1.5 倍写 ×n，否则写 ±%）；kind=pt 比百分点（命中率）。badWhenUp=false 表示升高是好事。
 */
export type Tone = 'bad' | 'good' | 'flat';
export function changeText(cur: number, prev: number | null, opts: { kind: 'ratio' | 'pt'; unit?: string; fmt?: (v: number) => string; badWhenUp?: boolean }): { text: string; tone: Tone } {
  const f = opts.fmt ?? ((v: number) => v.toLocaleString());
  if (prev === null || prev === undefined) return { text: '无上一窗口', tone: 'flat' };
  const badUp = opts.badWhenUp !== false;
  if (opts.kind === 'pt') {
    const d = (cur - prev) * 100;
    if (Math.abs(d) < 0.5) return { text: `持平 · 上窗 ${f(prev)}`, tone: 'flat' };
    return { text: `${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)} pt · 上窗 ${f(prev)}`, tone: (d > 0) === badUp ? 'bad' : 'good' };
  }
  if (prev <= 0) return { text: cur > 0 ? `▲ 上窗 ${f(prev)}${opts.unit ?? ''}` : `持平 · 上窗 ${f(prev)}${opts.unit ?? ''}`, tone: cur > 0 && badUp ? 'bad' : 'flat' };
  const r = cur / prev;
  if (Math.abs(r - 1) < 0.1) return { text: `${r >= 1 ? '▲' : '▼'} ${Math.abs(Math.round((r - 1) * 100))}% · 上窗 ${f(prev)}${opts.unit ?? ''}`, tone: 'flat' };
  const label = r >= 1.5 ? `×${r >= 10 ? r.toFixed(0) : r.toFixed(1)}` : `${r >= 1 ? '+' : '−'}${Math.abs(Math.round((r - 1) * 100))}%`;
  return { text: `${r >= 1 ? '▲' : '▼'} ${label} · 上窗 ${f(prev)}${opts.unit ?? ''}`, tone: (r > 1) === badUp ? 'bad' : 'good' };
}
