/**
 * chart-kit：任务面板 / 会话渲染共用的 SVG 图表原语（2026-08-26 健康报告改造引入）。
 * 纯 React + SVG，零第三方依赖；视觉 token 对齐 dsh 原生（主蓝 #4176E6、严重度四色）。
 *   <Bars>  横向柱状图（分布 / TopN，支持阈值刻度）
 *   <Pie>   环形饼图（构成占比）
 *   <Gauge> 阈值水位（0-1 占比 + notice/warn/critical 刻度，标出实测落档）
 *   <Line>  折线（时间序列，可叠阈值虚线，悬停读数）
 */
import { useRef, useState } from 'react';

export type Level = 'ok' | 'notice' | 'warn' | 'critical';
export const SEV: Record<Level, string> = { ok: '#3fa552', notice: '#c9862d', warn: '#e07a1f', critical: '#d64545' };
export const PALETTE = ['#4176e6', '#3fa552', '#c9862d', '#8e6bd6', '#2aa6b3', '#e07a1f', '#d64545', '#7f8790'];
const INK = '#0f1115'; const DIM = '#81858c'; const LINE = 'rgba(0,0,0,.08)';
const MONO = '"JetBrains Mono","SF Mono",Menlo,monospace';

export type Unit = 'ratio' | 'count' | 'ms' | 's' | 'bytes' | 'x' | 'per_s' | 'text';

export function fmtValue(v: number, unit: Unit): string {
  if (!Number.isFinite(v)) return '—';
  switch (unit) {
    case 'ratio': return `${(v * 100).toFixed(Math.abs(v * 100) >= 10 ? 0 : 1)}%`;
    case 'ms': return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(v >= 10 ? 0 : 1)}ms`;
    case 's': return v >= 3600 ? `${(v / 3600).toFixed(1)}h` : v >= 60 ? `${Math.floor(v / 60)}m${Math.round(v % 60)}s` : `${Math.round(v)}s`;
    case 'bytes': return v >= 2 ** 30 ? `${(v / 2 ** 30).toFixed(1)}GB` : v >= 2 ** 20 ? `${(v / 2 ** 20).toFixed(0)}MB` : v >= 1024 ? `${(v / 1024).toFixed(0)}KB` : `${Math.round(v)}B`;
    case 'x': return `${v.toFixed(2)}`;
    case 'per_s': return `${v >= 100 ? v.toFixed(0) : v.toFixed(2)}/s`;
    default: return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
}

export interface Item { name: string; value: number; level?: Level }

// ───────────────────────────────────────────── Bars
export function Bars({ items, unit, max, height = 22, colorOf, ticks }: {
  items: Item[]; unit: Unit; max?: number; height?: number;
  colorOf?: (item: Item, i: number) => string;
  /** 阈值刻度（与 items 同单位） */
  ticks?: { value: number; level: Level }[];
}) {
  const top = Math.max(max ?? 0, ...items.map((i) => i.value), 1e-9);
  const scale = (v: number) => `${Math.max(0, Math.min(100, (v / top) * 100))}%`;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(80px,38%) 1fr', rowGap: 6, columnGap: 10, alignItems: 'center', fontSize: 12.5 }}>
      {items.map((it, i) => (
        <div key={i} style={{ display: 'contents' }}>
          <div title={it.name} style={{ color: '#61666b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: /[一-龥]/.test(it.name) ? undefined : MONO }}>{it.name}</div>
          <div style={{ position: 'relative', height, background: '#f1f3f6', borderRadius: 4 }}>
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: scale(it.value), background: colorOf?.(it, i) ?? (it.level !== undefined ? SEV[it.level] : PALETTE[i % PALETTE.length]), borderRadius: 4, transition: 'width .3s' }} />
            {(ticks ?? []).map((t, k) => (
              <div key={k} title={`${t.level} ${fmtValue(t.value, unit)}`} style={{ position: 'absolute', top: -2, bottom: -2, left: scale(t.value), width: 2, background: SEV[t.level] }} />
            ))}
            <span style={{ position: 'absolute', right: 6, top: 0, lineHeight: `${height}px`, fontFamily: MONO, fontSize: 11.5, color: INK }}>{fmtValue(it.value, unit)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ───────────────────────────────────────────── Pie（环形）
export function Pie({ items, unit, size = 120 }: { items: Item[]; unit: Unit; size?: number }) {
  const total = items.reduce((s, i) => s + Math.max(0, i.value), 0);
  const R = size / 2; const r = R * 0.62; const cx = R; const cy = R;
  let angle = -Math.PI / 2;
  const arcs = items.map((it, i) => {
    const frac = total > 0 ? Math.max(0, it.value) / total : 0;
    const a0 = angle; const a1 = angle + frac * 2 * Math.PI; angle = a1;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (a: number, rad: number) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
    const [x0, y0] = p(a0, R); const [x1, y1] = p(a1, R); const [x2, y2] = p(a1, r); const [x3, y3] = p(a0, r);
    const d = frac >= 0.9999
      ? `M ${cx + R} ${cy} A ${R} ${R} 0 1 1 ${cx - R} ${cy} A ${R} ${R} 0 1 1 ${cx + R} ${cy} M ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy}`
      : `M ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${r} ${r} 0 ${large} 0 ${x3} ${y3} Z`;
    return { d, frac, color: it.level !== undefined ? SEV[it.level] : PALETTE[i % PALETTE.length], it };
  });
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flex: 'none' }}>
        {arcs.map((a, i) => a.frac > 0 ? <path key={i} d={a.d} fill={a.color} fillRule="evenodd"><title>{a.it.name} · {fmtValue(a.it.value, unit)} · {(a.frac * 100).toFixed(1)}%</title></path> : null)}
        {total === 0 ? <circle cx={cx} cy={cy} r={(R + r) / 2} fill="none" stroke="#e5e8ee" strokeWidth={R - r} /> : null}
      </svg>
      <div style={{ display: 'grid', gap: 4, fontSize: 12.5, minWidth: 150 }}>
        {arcs.map((a, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <i style={{ width: 9, height: 9, borderRadius: 2, background: a.color, flex: 'none' }} />
            <span title={a.it.name} style={{ color: '#61666b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{a.it.name}</span>
            <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 11.5, color: INK }}>{(a.frac * 100).toFixed(a.frac >= 0.1 ? 0 : 1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────── Gauge（阈值水位）
export function Gauge({ value, tiers, cmp = '>=', level, unit = 'ratio', max }: {
  value: number; tiers: Partial<Record<Exclude<Level, 'ok'>, number>>; cmp?: '>=' | '<'; level: Level; unit?: Unit; max?: number;
}) {
  const top = max ?? (unit === 'ratio' ? 1 : Math.max(value, ...Object.values(tiers).filter((v): v is number => typeof v === 'number'), 1e-9) * 1.15);
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / top) * 100))}%`;
  const marks = (Object.entries(tiers) as [Exclude<Level, 'ok'>, number][]).filter(([, v]) => typeof v === 'number').sort((a, b) => a[1] - b[1]);
  // 刻度文字：相邻两档离得近（<12% 宽）时交替上下两行摆放，避免像 "<95%<99%" 叠在一起
  const rows = marks.map(([, v], i) => (i > 0 && (v - marks[i - 1][1]) / top < 0.12 ? (i % 2) : 0));
  // 靠右的刻度文字向左对齐、靠左的向右对齐，其余居中——不让文字溢出水位条
  const shift = (v: number) => (v / top > 0.86 ? 'translateX(-100%)' : v / top < 0.1 ? 'none' : 'translateX(-50%)');
  return (
    <div style={{ position: 'relative', height: 10, borderRadius: 5, background: '#eceef3', margin: '10px 0 26px', maxWidth: 420 }}>
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: pct(value), background: SEV[level], borderRadius: 5 }} />
      {marks.map(([l, v], i) => (
        <div key={l} style={{ position: 'absolute', left: pct(v), top: -4, bottom: -4, width: 2, background: SEV[l] }}>
          <span style={{ position: 'absolute', top: 14 + rows[i] * 12, left: 0, fontSize: 10.5, color: SEV[l], whiteSpace: 'nowrap', fontFamily: MONO, transform: shift(v) }}>{cmp}{fmtValue(v, unit)}</span>
        </div>
      ))}
      <span style={{ position: 'absolute', left: pct(value), top: -20, transform: 'translateX(-50%)', fontSize: 11.5, fontFamily: MONO, color: SEV[level], whiteSpace: 'nowrap' }}>▼ {fmtValue(value, unit)}</span>
    </div>
  );
}

// ───────────────────────────────────────────── Line（时间序列）
export interface Series { name: string; points: [number, number][]; color?: string }
function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  const span = max - min; const raw = span / count; const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count + 1) ?? raw;
  const out: number[] = []; for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}
const fmtTime = (ms: number, spanMs: number) => { const d = new Date(ms); const hh = String(d.getHours()).padStart(2, '0'); const mm = String(d.getMinutes()).padStart(2, '0'); return spanMs > 36e5 * 26 ? `${d.getMonth() + 1}-${d.getDate()} ${hh}:${mm}` : `${hh}:${mm}`; };

export function Line({ series, unit, thresholds = [], height = 170, width = 720, yMin }: {
  series: Series[]; unit: Unit; thresholds?: { label: string; value: number; level?: Level }[]; height?: number; width?: number; yMin?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ x: number; t: number; vals: { name: string; v: number; color: string }[] } | null>(null);
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) return <div style={{ fontSize: 12.5, color: DIM }}>窗口内无数据</div>;
  const pad = { l: 48, r: 12, t: 12, b: 24 };
  const W = width; const H = height; const iw = W - pad.l - pad.r; const ih = H - pad.t - pad.b;
  const t0 = Math.min(...all.map((p) => p[0])); const t1 = Math.max(...all.map((p) => p[0]));
  const vs = [...all.map((p) => p[1]), ...thresholds.map((t) => t.value)];
  let lo = yMin ?? Math.min(...vs); let hi = Math.max(...vs);
  if (unit === 'ratio') { lo = Math.min(lo, 0); hi = Math.max(hi, Math.min(1, hi * 1.05)); }
  if (hi === lo) { hi = lo + 1; }
  const x = (t: number) => pad.l + (t1 > t0 ? ((t - t0) / (t1 - t0)) * iw : iw / 2);
  const y = (v: number) => pad.t + ih - ((v - lo) / (hi - lo)) * ih;
  const yt = niceTicks(lo, hi); const xt = niceTicks(t0, t1, 5);
  const onMove = (e: any) => {
    const rect = ref.current?.getBoundingClientRect(); if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W; const t = t0 + ((px - pad.l) / iw) * (t1 - t0);
    const vals = series.map((s, i) => { let best = s.points[0]; for (const p of s.points) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p; return { name: s.name, v: best[1], color: s.color ?? PALETTE[i % PALETTE.length], t: best[0] }; });
    setHover({ x: x(vals[0]?.t ?? t), t: vals[0]?.t ?? t, vals });
  };
  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {yt.map((v) => <g key={`y${v}`}><line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke={LINE} /><text x={pad.l - 6} y={y(v) + 4} fontSize={10.5} textAnchor="end" fill={DIM} fontFamily={MONO}>{fmtValue(v, unit)}</text></g>)}
        {xt.map((t) => <text key={`x${t}`} x={x(t)} y={H - 6} fontSize={10.5} textAnchor="middle" fill={DIM} fontFamily={MONO}>{fmtTime(t, t1 - t0)}</text>)}
        {thresholds.map((th, i) => th.value >= lo && th.value <= hi ? (
          <g key={`th${i}`}><line x1={pad.l} x2={W - pad.r} y1={y(th.value)} y2={y(th.value)} stroke={SEV[th.level ?? 'warn']} strokeDasharray="5 4" strokeWidth={1.2} />
            <text x={W - pad.r - 2} y={y(th.value) - 3} fontSize={10.5} textAnchor="end" fill={SEV[th.level ?? 'warn']} fontFamily={MONO}>{th.label} {fmtValue(th.value, unit)}</text></g>
        ) : null)}
        {series.map((s, i) => {
          const color = s.color ?? PALETTE[i % PALETTE.length];
          const d = s.points.map((p, k) => `${k === 0 ? 'M' : 'L'} ${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join(' ');
          return <path key={s.name} d={d} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" />;
        })}
        {hover ? <line x1={hover.x} x2={hover.x} y1={pad.t} y2={pad.t + ih} stroke="#9aa0a8" strokeDasharray="3 3" /> : null}
        {hover ? hover.vals.map((v, i) => <circle key={i} cx={hover.x} cy={y(v.v)} r={3.5} fill="#fff" stroke={v.color} strokeWidth={2} />) : null}
      </svg>
      {hover ? (
        <div style={{ position: 'absolute', left: `${Math.min(88, (hover.x / W) * 100)}%`, top: 4, transform: 'translateX(8px)', background: 'rgba(15,17,21,.92)', color: '#fff', borderRadius: 6, padding: '6px 9px', fontSize: 11.5, fontFamily: MONO, pointerEvents: 'none', whiteSpace: 'nowrap' }}>
          <div style={{ opacity: 0.75 }}>{fmtTime(hover.t, 36e5 * 30)}</div>
          {hover.vals.map((v, i) => <div key={i}><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: v.color, marginRight: 6 }} />{v.name} {fmtValue(v.v, unit)}</div>)}
        </div>
      ) : null}
      {series.length > 1 ? (
        <div style={{ display: 'flex', gap: 12, fontSize: 12, color: '#61666b', marginTop: 4, flexWrap: 'wrap' }}>
          {series.map((s, i) => <span key={s.name}><i style={{ display: 'inline-block', width: 10, height: 3, background: s.color ?? PALETTE[i % PALETTE.length], marginRight: 5, verticalAlign: 'middle' }} />{s.name}</span>)}
        </div>
      ) : null}
    </div>
  );
}
