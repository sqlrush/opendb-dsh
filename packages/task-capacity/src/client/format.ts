/** 容量面板共用：设计 token（dsh 原生实测值）+ 格式化。纯函数，无 React。 */
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
export const PALETTE = ['#4176e6', '#8b6be0', '#2fa79a', '#e0963f', '#d9607a', '#7a8aa6', '#b9c2d0', '#5ba95b', '#4fa3d9', '#b08a5a'];

export const GIB = 1024 ** 3;
/** pg_size_pretty 口径（二进制），面板统一 */
export const fmtBytes = (b: number): string => {
  const v = Number(b ?? 0);
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v); const sign = v < 0 ? '−' : '';
  if (a >= GIB) return `${sign}${(a / GIB).toFixed(a >= 100 * GIB ? 0 : 1)} GB`;
  if (a >= 1024 ** 2) return `${sign}${(a / 1024 ** 2).toFixed(0)} MB`;
  if (a >= 1024) return `${sign}${(a / 1024).toFixed(0)} KB`;
  return `${sign}${a} B`;
};
export const fmtGbPerDay = (b: number): string => `${b >= 0 ? '+' : '−'}${(Math.abs(b) / GIB).toFixed(2)} GB/天`;
export const fmtPct = (r: number): string => `${(Number(r ?? 0) * 100).toFixed(Number(r) >= 0.1 ? 0 : 1)}%`;
export const fmtInt = (n: number): string => Math.round(Number(n ?? 0)).toLocaleString('en-US');
const pad = (n: number) => String(n).padStart(2, '0');
export const hhmm = (ts: string | number): string => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const mmdd = (ts: string | number): string => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? '' : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const mmddhhmm = (ts: string | number): string => `${mmdd(ts)} ${hhmm(ts)}`;
/** never / 08-29 21:49 */
export const whenOrNever = (ts: string | undefined): string => (ts === undefined || ts === '' ? 'never' : mmddhhmm(ts));
