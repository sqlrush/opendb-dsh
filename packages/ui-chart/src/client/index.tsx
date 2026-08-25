/**
 * ui-chart — 会话内图表卡（client-only）。接管 metrics_chart / chart_render 两个工具在会话流里的渲染：
 * 纯 SVG 折线 / 面积 / 柱状，坐标轴 + 网格 + 多序列图例 + 阈值虚线 + hover 十字线与数值提示 +
 * min/avg/max/last 统计行。无图表库（bundle 体积、CSP、与 dsh 视觉统一三方面都更稳）。
 * user 2026-08-24：曲线/趋势/对比图在会话里展示是 opendb 核心功能——此前模型只能用 ▇ 字符画柱子。
 *
 * 机制同 ui-task-inline：dsh 的 `tool.call.toolview` 键控槽位，key = 工具名。
 * payload 契约见 tool-chart：{ v, kind, xType, t0, t1, categories?, title, charts:[{label, unit, series:[{name, points:[[x,v]], stats}], thresholds}], notes }
 * time 轴的 x = 距 t0 的秒数（紧凑）；category 轴的 x = categories 下标。
 */
import { useEffect, useRef, useState } from 'react';

export const inject = ['slots'];

const T = {
  ink: '#0f1115', sub: '#61666b', dim: '#81858c', blue: '#4176e6',
  line: 'rgba(0,0,0,.08)', grid: 'rgba(0,0,0,.06)', fill: '#f7f8fa',
  lvl: { notice: '#c9862d', warn: '#e07a1f', critical: '#d64545' } as Record<string, string>,
};
const PALETTE = ['#4176e6', '#e07a1f', '#3fa552', '#7c5cbf', '#2a9d8f', '#d64545', '#a0714f', '#61666b'];
const mono = '"JetBrains Mono","SF Mono",Menlo,monospace';
const font = '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
const shell: any = {
  border: `1px solid ${T.line}`, borderRadius: 10, overflow: 'hidden', margin: '6px 0 2px', background: '#fff',
  boxShadow: '0 4px 12px rgba(0,0,0,.02),0 2px 8px rgba(0,0,0,.04)', maxWidth: 860, fontFamily: font, color: T.ink,
};

// ── 工具结果解析（与 ui-task-inline 同口径：`--` 注释头 + JSON）───────────────
function resultText(block: any): string {
  return ((block?.content ?? []) as any[]).map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
}
function parsePayload(block: any): any | undefined {
  const text = resultText(block);
  const i = text.indexOf('{');
  if (i < 0) return undefined;
  try { return JSON.parse(text.slice(i)); } catch { return undefined; }
}

// ── 数值/时间格式 ─────────────────────────────────────────────────────────────
function fmtVal(v: number, unit: string): string {
  if (!Number.isFinite(v)) return '—';
  switch (unit) {
    case 'ratio': return `${(v * 100).toFixed(v * 100 >= 10 ? 1 : 2)}%`;
    case 'bytes': return v >= 1 << 30 ? `${(v / (1 << 30)).toFixed(2)} GB` : v >= 1 << 20 ? `${(v / (1 << 20)).toFixed(1)} MB` : v >= 1024 ? `${(v / 1024).toFixed(0)} KB` : `${v.toFixed(0)} B`;
    case 'ms': return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(v >= 10 ? 0 : 2)} ms`;
    case 'per_s': return `${compact(v)}/s`;
    case 'count': return compact(v);
    default: return v >= 100 ? v.toFixed(0) : v.toFixed(2);
  }
}
function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  if (a >= 100) return v.toFixed(0);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
const pad = (n: number) => String(n).padStart(2, '0');
function fmtTime(ms: number, spanMs: number): string {
  const d = new Date(ms);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return spanMs > 36 * 3600_000 ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}` : hm;
}
function fmtTimeFull(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
/** 好看的刻度：1/2/5 × 10^n */
function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

// ── 单张图 ───────────────────────────────────────────────────────────────────
interface Series { name: string; points: [number, number][]; stats: { min: number; max: number; avg: number; last: number; n: number; maxAt?: number } }
interface Chart { key: string; label: string; unit: string; desc?: string; computed?: boolean; series: Series[]; thresholds: { label: string; value: number; level: string }[] }
interface Payload { v: number; kind: string; xType: 'time' | 'category'; t0?: number; t1?: number; categories?: string[]; title: string; charts: Chart[]; notes?: string[] }

function useWidth(ref: { current: HTMLDivElement | null }, fallback = 760): number {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () => setW(Math.max(320, Math.floor(el.getBoundingClientRect().width)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return w;
}

function SvgChart({ chart, payload }: { chart: Chart; payload: Payload }) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const width = useWidth(wrap);
  const [hover, setHover] = useState<{ x: number } | null>(null);
  const H = 230; const ML = 56; const MR = 18; const MT = 14; const MB = 30;
  const iw = Math.max(50, width - ML - MR); const ih = H - MT - MB;
  const isCat = payload.xType === 'category';
  const isBar = payload.kind === 'bar';
  const isArea = payload.kind === 'area';

  // x 域
  const allX = chart.series.flatMap((s) => s.points.map((p) => p[0]));
  const xMin = isCat ? -0.5 : Math.min(...allX);
  const xMax = isCat ? (payload.categories?.length ?? 1) - 0.5 : Math.max(...allX);
  const xSpan = Math.max(1e-9, xMax - xMin);
  // y 域：数据 ∪ 阈值线，留 6% 头部余量；下界优先 0（比例/计数从 0 起更好读）
  const allY = [...chart.series.flatMap((s) => s.points.map((p) => p[1])), ...chart.thresholds.map((t) => t.value)];
  let yMin = Math.min(...allY); let yMax = Math.max(...allY);
  if (yMin >= 0) yMin = 0;
  if (!(yMax > yMin)) yMax = yMin + 1;
  yMax += (yMax - yMin) * 0.06;
  const X = (x: number) => ML + ((x - xMin) / xSpan) * iw;
  const Y = (y: number) => MT + ih - ((y - yMin) / (yMax - yMin)) * ih;
  const yTicks = niceTicks(yMin, yMax, 4);
  const t0 = payload.t0 ?? 0;
  const spanMs = ((payload.t1 ?? 0) - t0) || (xSpan * 1000);
  const xTicks: { x: number; label: string }[] = isCat
    ? (payload.categories ?? []).map((c, i) => ({ x: i, label: c }))
    : niceTicks(xMin, xMax, Math.max(3, Math.min(8, Math.floor(iw / 110)))).map((sec) => ({ x: sec, label: fmtTime(t0 + sec * 1000, spanMs) }));

  // hover：找最近的 x
  const hoverInfo = (() => {
    if (hover === null) return null;
    const xv = xMin + ((hover.x - ML) / iw) * xSpan;
    const rows = chart.series.map((s, i) => {
      let best = s.points[0]; let bd = Infinity;
      for (const p of s.points) { const d = Math.abs(p[0] - xv); if (d < bd) { bd = d; best = p; } }
      return { name: s.name, color: PALETTE[i % PALETTE.length], v: best?.[1], x: best?.[0] };
    });
    const ax = rows[0]?.x ?? xv;
    return { px: X(ax), label: isCat ? (payload.categories?.[Math.round(ax)] ?? '') : fmtTimeFull(t0 + ax * 1000), rows };
  })();

  const nSeries = Math.max(1, chart.series.length);
  const barW = isBar ? Math.max(2, (iw / Math.max(1, isCat ? (payload.categories?.length ?? 1) : allX.length / nSeries)) * 0.7 / nSeries) : 0;

  return (
    <div ref={wrap} style={{ position: 'relative', width: '100%' }}>
      <svg width={width} height={H} style={{ display: 'block', fontFamily: font }}
        onMouseMove={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const x = e.clientX - r.left; if (x >= ML && x <= ML + iw) setHover({ x }); else setHover(null); }}
        onMouseLeave={() => setHover(null)}>
        {/* 网格 + y 轴刻度 */}
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line x1={ML} x2={ML + iw} y1={Y(v)} y2={Y(v)} stroke={T.grid} strokeWidth={1} />
            <text x={ML - 8} y={Y(v) + 4} textAnchor="end" fontSize={11} fill={T.dim} fontFamily={mono}>{fmtVal(v, chart.unit)}</text>
          </g>
        ))}
        {/* x 轴刻度 */}
        <line x1={ML} x2={ML + iw} y1={MT + ih} y2={MT + ih} stroke={T.line} />
        {xTicks.map((t, i) => (
          <text key={`x${i}`} x={X(t.x)} y={MT + ih + 18} textAnchor="middle" fontSize={11} fill={T.dim} fontFamily={mono}>{t.label}</text>
        ))}
        {/* 阈值线 */}
        {chart.thresholds.map((th) => (
          <g key={th.label}>
            <line x1={ML} x2={ML + iw} y1={Y(th.value)} y2={Y(th.value)} stroke={T.lvl[th.level] ?? T.dim} strokeWidth={1} strokeDasharray="5 4" />
            <text x={ML + iw - 4} y={Y(th.value) - 4} textAnchor="end" fontSize={10.5} fill={T.lvl[th.level] ?? T.dim} fontWeight={600}>{th.label} {fmtVal(th.value, chart.unit)}</text>
          </g>
        ))}
        {/* 序列 */}
        {chart.series.map((s, i) => {
          const c = PALETTE[i % PALETTE.length];
          if (isBar) {
            return s.points.map((p, j) => {
              const cx = X(p[0]) - (barW * nSeries) / 2 + i * barW;
              return <rect key={j} x={cx} y={Y(p[1])} width={barW} height={Math.max(0, MT + ih - Y(p[1]))} fill={c} rx={2} opacity={0.9} />;
            });
          }
          const d = s.points.map((p, j) => `${j === 0 ? 'M' : 'L'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ');
          return (
            <g key={s.name}>
              {isArea && s.points.length > 1 && <path d={`${d} L${X(s.points[s.points.length - 1][0]).toFixed(1)},${MT + ih} L${X(s.points[0][0]).toFixed(1)},${MT + ih} Z`} fill={c} opacity={0.12} />}
              <path d={d} fill="none" stroke={c} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
              {/* 峰值标记 */}
              {s.stats.maxAt !== undefined && !isCat && <circle cx={X(s.stats.maxAt)} cy={Y(s.stats.max)} r={3} fill="#fff" stroke={c} strokeWidth={1.8} />}
              {s.points.length === 1 && <circle cx={X(s.points[0][0])} cy={Y(s.points[0][1])} r={3.5} fill={c} />}
            </g>
          );
        })}
        {/* hover 十字线 + 点 */}
        {hoverInfo !== null && (
          <g>
            <line x1={hoverInfo.px} x2={hoverInfo.px} y1={MT} y2={MT + ih} stroke={T.sub} strokeWidth={1} strokeDasharray="3 3" />
            {hoverInfo.rows.map((r) => r.v !== undefined && r.x !== undefined && <circle key={r.name} cx={X(r.x)} cy={Y(r.v)} r={3.5} fill={r.color} stroke="#fff" strokeWidth={1.5} />)}
          </g>
        )}
      </svg>
      {hoverInfo !== null && (
        <div style={{
          position: 'absolute', top: MT + 6, left: hoverInfo.px + 12 + 180 > width ? hoverInfo.px - 190 : hoverInfo.px + 12,
          background: 'rgba(15,17,21,.92)', color: '#fff', borderRadius: 8, padding: '7px 10px', fontSize: 12, pointerEvents: 'none', minWidth: 150, lineHeight: 1.6,
        }}>
          <div style={{ color: 'rgba(255,255,255,.7)', fontFamily: mono, fontSize: 11 }}>{hoverInfo.label}</div>
          {hoverInfo.rows.map((r) => (
            <div key={r.name} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: r.color, display: 'inline-block' }} />
              <span style={{ flex: 1 }}>{r.name}</span>
              <b style={{ fontFamily: mono }}>{fmtVal(Number(r.v), chart.unit)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Legend({ chart, t0 }: { chart: Chart; t0: number }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', padding: '6px 4px 2px', fontSize: 12.5, color: T.sub }}>
      {chart.series.map((s, i) => (
        <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 3, borderRadius: 2, background: PALETTE[i % PALETTE.length], display: 'inline-block' }} />
          <span style={{ color: T.ink, fontWeight: 500 }}>{s.name}</span>
          <span style={{ fontFamily: mono, fontSize: 12 }}>
            最新 <b style={{ color: T.ink }}>{fmtVal(s.stats.last, chart.unit)}</b> · 均 {fmtVal(s.stats.avg, chart.unit)} · 峰 {fmtVal(s.stats.max, chart.unit)}
            {s.stats.maxAt !== undefined ? <span style={{ color: T.dim }}>（{fmtTime(t0 + s.stats.maxAt * 1000, 0)}）</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

function ChartPanel({ chart, payload }: { chart: Chart; payload: Payload }) {
  const over = chart.thresholds.length > 0
    ? chart.series.some((s) => chart.thresholds.some((th) => (th.level === 'critical' || th.level === 'warn') && s.stats.max >= th.value))
    : false;
  return (
    <div style={{ padding: '10px 14px 8px', borderTop: `1px solid ${T.line}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 14.5, fontWeight: 600 }}>{chart.label}</span>
        {chart.desc ? <span style={{ fontSize: 12, color: T.dim }}>{chart.desc}</span> : null}
        {over && <span style={{ marginLeft: 'auto', fontSize: 12, color: T.lvl.warn, fontWeight: 600 }}>▲ 窗口内越过阈值线</span>}
      </div>
      <SvgChart chart={chart} payload={payload} />
      <Legend chart={chart} t0={payload.t0 ?? 0} />
    </div>
  );
}

function Running({ label }: { label: string }) {
  return (
    <div style={{ ...shell, display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px' }}>
      <span style={{ width: 9, height: 9, borderRadius: 5, background: T.blue, display: 'inline-block' }} />
      <span style={{ fontSize: 13.5, color: T.sub }}>{label}…（服务端取数、差分、降采样中）</span>
    </div>
  );
}

function ChartCard({ block }: { block: any; toolName: string }) {
  if (block?.kind !== 'tool-result') return <Running label="生成图表" />;
  const p = parsePayload(block) as Payload | undefined;
  if (p === undefined || !Array.isArray(p.charts) || p.charts.length === 0) {
    return (
      <div style={shell}>
        <div style={{ padding: '10px 16px', fontSize: 13.5, color: T.sub, whiteSpace: 'pre-wrap' }}>{resultText(block).slice(0, 500) || '图表工具未返回内容'}</div>
      </div>
    );
  }
  const spanText = p.xType === 'time' && p.t0 !== undefined && p.t1 !== undefined ? `${fmtTimeFull(p.t0)} → ${fmtTimeFull(p.t1)}` : `${p.categories?.length ?? 0} 个分类`;
  return (
    <div style={shell}>
      <div style={{ background: 'linear-gradient(135deg,#4176e6,#2f5fc4)', color: '#fff', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 15 }}>{p.title}</b>
        <span style={{ fontSize: 12, background: 'rgba(255,255,255,.18)', borderRadius: 6, padding: '1px 9px' }}>{p.kind === 'bar' ? '柱状' : p.kind === 'area' ? '面积' : '折线'} · {p.charts.length} 张</span>
        <span style={{ marginLeft: 'auto', fontSize: 12.5, opacity: 0.9, fontFamily: mono }}>{spanText}</span>
      </div>
      {p.charts.map((c) => <ChartPanel key={c.key} chart={c} payload={p} />)}
      <div style={{ display: 'flex', gap: 14, padding: '8px 16px', borderTop: `1px solid ${T.line}`, background: T.fill, fontSize: 12.5, color: T.dim, flexWrap: 'wrap' }}>
        <span>{p.charts.some((c) => c.computed) ? '速率/比例由累计计数器服务端差分得到 · ' : ''}悬停查看各点数值 · 虚线为当前生效的平台阈值</span>
        {(p.notes ?? []).length > 0 ? <span style={{ marginLeft: 'auto', color: T.lvl.notice }}>⚠ {p.notes!.length} 条采集提示</span> : null}
      </div>
      {(p.notes ?? []).length > 0 && (
        <div style={{ padding: '4px 16px 10px', background: T.fill, fontSize: 12, color: T.sub }}>
          {p.notes!.slice(0, 4).map((n, i) => <div key={i}>· {n}</div>)}
        </div>
      )}
    </div>
  );
}

export function apply(ctx: any): void {
  ctx.slots.inject('tool.call.toolview', () => {
    for (const tool of ['metrics_chart', 'chart_render']) {
      ctx.slots.register({ name: 'tool.call.toolview', key: tool }, ChartCard);
    }
  });
}
