/**
 * 负载趋势（hero）：最近 N 个快照窗口的 AAS 堆叠柱（CPU / IO / 其他等待），分析窗口加框标数，
 * CPU 核数在量程内画参考虚线（AAS 超过核数 = 饱和），否则在图上注一句。纯 SVG（React），不引图表库。
 */
import { T, CLASS_COLOR, hhmm, mmdd } from './format.ts';

export interface TrendPointLike { beginSnap: number; endSnap: number; beginTs: string; endTs: string; secs: number; aas: number; cpu: number; io: number }

export function AasTrend({ points, beginSnap, endSnap, cores }: { points: TrendPointLike[]; beginSnap: number; endSnap: number; cores: number }) {
  if (points.length === 0) return <div style={{ fontSize: 13.5, color: T.dim }}>趋势不可得（instance_time 快照缺失）。</div>;
  const W = 820; const H = 230; const L = 44; const R = 12; const TOP = 14; const B = 34;
  const ih = H - TOP - B; const iw = W - L - R;
  const maxAas = Math.max(...points.map((p) => p.aas), 0.01);
  const max = maxAas * 1.15;
  const step = max > 8 ? 4 : max > 3 ? 1 : max > 1 ? 0.5 : 0.1;
  const y = (v: number) => TOP + ih - (v / max) * ih;
  const bw = iw / points.length;
  const grid: number[] = [];
  for (let v = 0; v <= max; v += step) grid.push(Math.round(v * 100) / 100);
  const inWin = (p: TrendPointLike) => p.beginSnap >= beginSnap && p.endSnap <= endSnap;
  const first = points[0]; const last = points[points.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: 'block' }}>
      {grid.map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#eef0f3" strokeWidth={1} />
          <text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill={T.dim}>{v}</text>
        </g>
      ))}
      {cores > 0 && cores <= max
        ? <line x1={L} x2={W - R} y1={y(cores)} y2={y(cores)} stroke={T.ink} strokeWidth={1} strokeDasharray="5 4" />
        : cores > 0 ? <text x={L + 6} y={TOP + 4} fontSize={11} fill={T.dim}>CPU 核数 {cores}：AAS 最高 {maxAas.toFixed(2)}，未饱和</text> : null}
      {points.map((p, i) => {
        const x = L + i * bw + 3; const width = Math.max(2, bw - 6);
        const other = Math.max(0, p.aas - p.cpu - p.io);
        const segs: [number, string][] = [[p.cpu, CLASS_COLOR.CPU], [p.io, CLASS_COLOR.IO], [other, CLASS_COLOR.其他等待]];
        let cur = TOP + ih;
        const sel = inWin(p);
        return (
          <g key={`${p.beginSnap}-${p.endSnap}`}>
            <title>{`${hhmm(p.beginTs)}–${hhmm(p.endTs)} · AAS ${p.aas}（CPU ${p.cpu} · IO ${p.io} · 其他 ${Math.round(other * 100) / 100}）`}</title>
            {segs.map(([v, c], k) => { const h = (v / max) * ih; cur -= h; return <rect key={k} x={x} y={cur} width={width} height={Math.max(0, h)} fill={c} rx={2} />; })}
            {sel ? <rect x={x - 3} y={TOP - 6} width={width + 6} height={ih + 12} fill="none" stroke={T.ink} strokeWidth={1.5} rx={4} /> : null}
            {sel || p.aas === maxAas ? <text x={x + width / 2} y={y(p.aas) - 8} textAnchor="middle" fontSize={sel ? 12 : 10.5} fontWeight={sel ? 700 : 400} fill={sel ? T.ink : T.sub}>{p.aas.toFixed(2)}</text> : null}
            {i % 3 === 0 || i === points.length - 1 ? <text x={x + width / 2} y={H - 14} textAnchor="middle" fontSize={10.5} fill={T.dim}>{hhmm(p.beginTs)}</text> : null}
          </g>
        );
      })}
      <text x={L} y={H - 2} fontSize={10.5} fill={T.dim}>{mmdd(first.beginTs)}</text>
      <text x={W - R} y={H - 2} textAnchor="end" fontSize={10.5} fill={T.dim}>{mmdd(last.endTs)}</text>
    </svg>
  );
}
