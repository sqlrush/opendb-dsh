/** DDL 面板共用：设计 token（dsh 原生实测值）+ 格式化。纯函数，无 React。 */
export const T = {
  ink: '#0f1115', sub: '#61666b', dim: '#81858c', blue: '#4176e6',
  line: 'rgba(0,0,0,.08)', fill: '#f7f8fa', fill2: '#f2f3f5', rest: '#dde0e5',
  add: '#2e9e5b', addSoft: '#e6f6ec', del: '#d64545', delSoft: '#fdecec', mod: '#c9862d', modSoft: '#fff4de', user: '#7a8aa6',
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
export const codeBlock: any = { font: `12.5px/1.7 ${mono}`, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: T.ink, background: T.fill, borderRadius: 8, padding: '10px 12px', margin: '6px 0 10px' };
export const LANE_COLORS = ['#4176e6', '#8b6be0', '#2fa79a', '#e0963f', '#d9607a', '#5ba95b', '#4fa3d9', '#b08a5a'];
export const changeColor = (c: string): string => (c === 'added' || c === 'add' ? T.add : c === 'removed' || c === 'del' ? T.del : c === 'user' ? T.user : T.mod);
export const CHANGE_CN: Record<string, string> = { added: '建', removed: '删', modified: '改', user: '账号' };
export const SRC_CN: Record<string, string> = { dict: '字典', pg_object: 'pg_object', audit: '审计' };

const pad = (n: number) => String(n).padStart(2, '0');
export const hhmm = (ts: string): string => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? String(ts).slice(11, 16) : `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const mmdd = (ts: string): string => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? String(ts).slice(5, 10) : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const mmddhhmm = (ts: string): string => `${mmdd(ts)} ${hhmm(ts)}`;
export const ymd = (ts: string): string => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? String(ts).slice(0, 10) : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
export const fmtCount = (v: number): string => (v >= 1e4 ? `${(v / 1e3).toFixed(1)}k` : Math.round(v).toLocaleString());
