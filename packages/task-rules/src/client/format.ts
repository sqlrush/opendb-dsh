/** 规则目录面板的视觉 token 与小工具（对齐 dsh 原生：主蓝 #4176E6、严重度四色）。 */
export const T = {
  ink: '#0f1115', sub: '#61666b', dim: '#81858c', blue: '#4176e6',
  line: 'rgba(0,0,0,.08)', fill: '#f7f8fa', fill2: '#f2f3f5', rest: '#dde0e5',
  sev: {
    critical: { c: '#d64545', soft: '#fdecec' },
    warn: { c: '#e07a1f', soft: '#fdf0e3' },
    notice: { c: '#c9862d', soft: '#faf3e5' },
    ok: { c: '#3fa552', soft: '#e8f5ec' },
    plain: { c: '#61666b', soft: '#f2f3f5' },
  } as Record<string, { c: string; soft: string }>,
};
export const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
export const mono = '"JetBrains Mono","SF Mono",Menlo,Consolas,monospace';
export const tnum: any = { fontVariantNumeric: 'tabular-nums' };
export const card: any = {
  background: '#fff', border: `1px solid ${T.line}`, borderRadius: 10,
  boxShadow: '0 4px 12px rgba(0,0,0,.02),0 2px 8px rgba(0,0,0,.04)', minWidth: 0,
};
/** 插件配色：与集群页的类型着色同一套语言（每个插件一个稳定色） */
export const PLUGIN_COLOR: Record<string, string> = {
  health: '#2fa79a', sqlreview: '#4176e6', wdr: '#8b6be0', ddl: '#c9862d', capacity: '#d6604d',
};
export const PLUGIN_CN: Record<string, string> = {
  health: '健康检查', sqlreview: 'SQL 审核', wdr: 'WDR 窗口', ddl: 'DDL 追溯', capacity: '容量与增长',
};
/** 阈值数值按单位还原成人读文本（与阈值配置面板同口径） */
export function fmtThreshold(v: number, unit: string): string {
  switch (unit) {
    case 'ratio': return `${Math.round(v * 1000) / 10}%`;
    case 'bytes': return v >= 1024 ** 3 ? `${Math.round((v / 1024 ** 3) * 10) / 10}GiB` : v >= 1024 ** 2 ? `${Math.round(v / 1024 ** 2)}MiB` : `${Math.round(v / 1024)}KiB`;
    case 'ms': return `${v}ms`;
    case 's': return `${v}s`;
    case 'hour': return `${v}h`;
    default: return String(v);
  }
}
export const mmdd = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
