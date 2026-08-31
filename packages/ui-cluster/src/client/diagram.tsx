/**
 * 架构图：k8s 边界框（Pod 全量展示、按类型着色、每层居中）+ Pod 间调用关系连线 + 框外被管数据库舰队。
 * 连线画在框内的 svg 上（框有半透明底，画在外层会被盖住——R2 实测踩过）；跨层的 host→postgres 走左侧总线绕开执行面。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { T, mono, tnum, fmtCpu, fmtMem, LVCN } from './format.ts';
import type { Pod } from './types.ts';

/** 调用关系：[调用方, 被调方, 是否读写(虚线), 线上标注] —— 组件级，渲染时按实际 Pod 展开 */
export const CALLS: [string, string, boolean, string][] = [
  ['host', 'runtime', false, '派发轮次'],
  ['host', 'collector', false, '调度采集'],
  ['host', 'postgres', true, '会话 · 队列'],
  ['runtime', 'postgres', true, '存档 · 日志'],
  ['collector', 'postgres', true, '采样 · 字典'],
  ['runtime', 'redis', true, ''],
  ['runtime', 'minio', true, ''],
  ['runtime', 'qdrant', true, ''],
  ['runtime', 'ollama', true, ''],
];
const LANE_IX: Record<string, number> = { ctrl: 0, exec: 1, data: 2 };
/** 同层内的排列顺序：按在架构里的地位，不按字母（否则 postgres 会排到 minio/ollama 后面） */
const ORDER = ['host', 'runtime', 'collector', 'postgres', 'redis', 'minio', 'qdrant', 'ollama'];
const LANES: { key: 'ctrl' | 'exec' | 'data'; label: string }[] = [
  { key: 'ctrl', label: '控制面' }, { key: 'exec', label: '执行面' }, { key: 'data', label: '数据面' },
];

const pct = (v: number, cap: number) => Math.max(1.5, Math.min(100, cap > 0 ? (v / cap) * 100 : 0));

function PodCard({ p, name, selected, onSelect }: { p: Pod; name: string; selected: boolean; onSelect: () => void }) {
  const cpuCap = p.cpuLim > 0 ? p.cpuLim : 18000;
  const memCap = p.memLim > 0 ? p.memLim : 64 * 1024;
  const bad = p.ready !== true || p.restarts > 5;
  return (
    <div
      data-pod={p.name} onClick={onSelect} title={`k8s 真实名：${p.name}`}
      style={{
        position: 'relative', width: 166, borderRadius: 8, padding: '7px 9px 6px', cursor: 'pointer',
        background: `${p.hue}12`, border: `1px solid ${selected ? T.blue : `${p.hue}55`}`,
        boxShadow: selected ? `0 0 0 2px ${T.blue}29` : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <span style={{ width: 17, height: 17, borderRadius: 4, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#fff', fontWeight: 700, background: p.hue }}>{p.comp.slice(0, 1).toUpperCase()}</span>
        <span style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: mono }}>{name}</span>
        <span style={{ width: 6, height: 6, borderRadius: 3, marginLeft: 'auto', flex: 'none', background: bad ? T.lv.notice : T.lv.ok }} />
      </div>
      <span style={{ fontSize: 11.5, fontWeight: 500, borderRadius: 4, padding: '0 6px', display: 'inline-block', marginTop: 4, background: `${p.hue}22`, color: p.hue }}>{p.role}</span>
      <div style={{ display: 'flex', gap: 3, marginTop: 4, alignItems: 'center' }}>
        {[[p.cpu, cpuCap], [p.mem, memCap]].map(([v, cap], i) => (
          <div key={i} style={{ flex: 1, height: 3, borderRadius: 2, background: `${p.hue}1f`, position: 'relative', overflow: 'hidden' }}>
            <i style={{ position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 2, width: `${pct(v, cap)}%`, background: p.hue }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 5, fontSize: 10.5, color: T.dim, fontFamily: mono }}>
        <span style={{ background: T.fill2, borderRadius: 3, padding: '0 4px' }}>{p.node}</span>
        <span>{fmtCpu(p.cpu)}</span><span>{fmtMem(p.mem)}</span>
      </div>
    </div>
  );
}

export function Diagram({ pods, names, selected, onSelectPod, fleetSlot, poolRef }: {
  pods: Pod[]; names: Map<string, string>; selected: string;
  onSelectPod: (name: string) => void;
  fleetSlot: React.ReactNode;
  poolRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [inner, setInner] = useState('');
  const [outer, setOuter] = useState('');

  const draw = useCallback(() => {
    const box = boxRef.current?.getBoundingClientRect();
    if (box === undefined) return;
    const rc = (el: Element | null) => { if (el === null) return null; const r = el.getBoundingClientRect(); return { t: r.top - box.top, b: r.bottom - box.top, cx: r.left - box.left + r.width / 2 }; };
    const byComp = new Map<string, Element[]>();
    for (const el of boxRef.current!.querySelectorAll('[data-pod]')) {
      const p = pods.find((x) => x.name === el.getAttribute('data-pod'));
      if (p !== undefined) byComp.set(p.comp, [...(byComp.get(p.comp) ?? []), el]);
    }
    const laneOfComp = (c: string) => LANE_IX[pods.find((p) => p.comp === c)?.kind ?? 'data'] ?? 2;
    const hueOfComp = (c: string) => pods.find((p) => p.comp === c)?.hue ?? '#7A8AA6';
    const marks = new Map<string, string>();
    const parts: string[] = [];
    for (const [from, to, dash, label] of CALLS) {
      const srcs = byComp.get(from) ?? []; const dsts = byComp.get(to) ?? [];
      if (srcs.length === 0 || dsts.length === 0) continue;
      const hue = hueOfComp(from); const id = `m${hue.slice(1)}`; marks.set(id, hue);
      const cross = laneOfComp(to) - laneOfComp(from) > 1;
      srcs.forEach((s, si) => dsts.forEach((d, di) => {
        const A = rc(s); const B = rc(d); if (A === null || B === null) return;
        const stroke = `stroke="${hue}" stroke-width="1.5" opacity="0.55"${dash ? ' stroke-dasharray="5 4"' : ''} marker-end="url(#${id})"`;
        const showLabel = label !== '' && si === 0 && di === 0;
        if (cross) {   // 跨层：走左侧总线，避免穿过中间那层的卡片
          const x = 12; const r = 9; const down = A.b + 14;
          const path = `M${A.cx} ${A.b} V${down - r} q0 ${r} -${r} ${r} H${x + r} q-${r} 0 -${r} ${r} V${B.t - 16 - r} q0 ${r} ${r} ${r} H${B.cx - r} q${r} 0 ${r} ${r} V${B.t}`;
          parts.push(`<path d="${path}" fill="none" ${stroke}/>`);
          if (showLabel) { const y = (down + B.t) / 2; parts.push(`<text x="${x + 6}" y="${y}" font-size="10.5" fill="${hue}" opacity="0.95" text-anchor="start" transform="rotate(-90 ${x + 6} ${y})">${label}</text>`); }
          return;
        }
        const m = (A.b + B.t) / 2;
        parts.push(`<path d="M${A.cx} ${A.b} C ${A.cx} ${m}, ${B.cx} ${m}, ${B.cx} ${B.t}" fill="none" ${stroke}/>`);
        if (showLabel) parts.push(`<text x="${(A.cx + B.cx) / 2}" y="${m - 4}" font-size="10.5" fill="${hue}" opacity="0.95" text-anchor="middle">${label}</text>`);
      }));
    }
    const defs = [...marks].map(([id, c]) => `<marker id="${id}" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 1 L6 4 L0 7 z" fill="${c}" opacity="0.85"/></marker>`).join('');
    setInner(`<defs>${defs}</defs>${parts.join('')}`);

    // 集群 → 当前选中的被管节点（框外只画这一条）
    const stage = stageRef.current?.getBoundingClientRect();
    const pick = poolRef.current?.querySelector('[data-picked]');
    if (stage !== undefined && pick != null) {
      const s = (el: Element) => { const r = el.getBoundingClientRect(); return { t: r.top - stage.top, b: r.bottom - stage.top, cx: r.left - stage.left + r.width / 2 }; };
      const K = s(boxRef.current!); const P = s(pick);
      setOuter(`<defs><marker id="ah-ext" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 1 L6 4 L0 7 z" fill="${T.ext}" opacity="0.85"/></marker></defs>`
        + `<path d="M${K.cx} ${K.b} C ${K.cx} ${K.b + 26}, ${P.cx} ${P.t - 26}, ${P.cx} ${P.t}" fill="none" stroke="${T.ext}" stroke-width="1.8" opacity="0.65" stroke-dasharray="6 4" marker-end="url(#ah-ext)"/>`
        + `<text x="${(K.cx + P.cx) / 2}" y="${K.b + 21}" font-size="11" fill="${T.ext}" text-anchor="middle">只读连接 · 巡检 / 报告</text>`);
    } else setOuter('');
  }, [pods, poolRef]);

  useLayoutEffect(() => { draw(); }, [draw, selected, names]);
  useEffect(() => {
    const on = () => draw();
    window.addEventListener('resize', on);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(on);
    if (ro !== null && stageRef.current !== null) ro.observe(stageRef.current);
    return () => { window.removeEventListener('resize', on); ro?.disconnect(); };
  }, [draw]);

  const running = pods.filter((p) => p.phase !== 'Succeeded');
  const nodeCount = new Set(running.map((p) => p.node)).size;
  return (
    <div
      ref={stageRef}
      style={{
        position: 'relative', padding: '16px 18px', minWidth: 0,
        background: 'linear-gradient(90deg, rgba(0,0,0,.022) 1px, transparent 1px) 0 0/22px 22px, linear-gradient(rgba(0,0,0,.022) 1px, transparent 1px) 0 0/22px 22px, #FCFCFD',
      }}
    >
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 0 }} dangerouslySetInnerHTML={{ __html: outer }} />
      <div ref={boxRef} style={{ position: 'relative', zIndex: 1, border: '1.5px solid #C9D6F2', borderRadius: 12, background: 'rgba(255,255,255,.86)', padding: '10px 14px 12px' }}>
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 0 }} dangerouslySetInnerHTML={{ __html: inner }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: T.sub, marginBottom: 10, flexWrap: 'wrap', position: 'relative', zIndex: 1 }}>
          <b style={{ fontSize: 13.5, fontWeight: 600, color: T.ink }}>k8s 集群</b>
          <span style={{ background: '#EEF3FF', color: '#2F55B3', borderRadius: 5, padding: '0 7px', fontSize: 11.5, fontFamily: mono }}>opendb-dsh</span>
          <span>{nodeCount} 节点 · {running.length} Pod · {running.filter((p) => p.ready).length} 就绪</span>
          <span style={{ marginLeft: 'auto', fontSize: 12 }}>Pod 全量展示 · 显示名为规范名，真名见卡片悬停与详情</span>
        </div>
        {LANES.map(({ key, label }) => {
          const list = running.filter((p) => p.kind === key).sort((a, b) => (ORDER.indexOf(a.comp) + 1 || 99) - (ORDER.indexOf(b.comp) + 1 || 99) || a.name.localeCompare(b.name));
          if (list.length === 0) return null;
          return (
            <div key={key} style={{ display: 'grid', gridTemplateColumns: '64px minmax(0,1fr)', gap: 10, alignItems: 'center', marginBottom: 42, position: 'relative', zIndex: 1 }}>
              <div style={{ fontSize: 11.5, color: T.dim, textAlign: 'right', paddingRight: 8, borderRight: `2px solid ${T.fill2}`, alignSelf: 'stretch', display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>{label}</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
                {list.map((p) => <PodCard key={p.name} p={p} name={names.get(p.name) ?? p.name} selected={selected === p.name} onSelect={() => onSelectPod(p.name)} />)}
              </div>
            </div>
          );
        })}
      </div>
      {fleetSlot}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: T.sub, padding: '10px 2px 0', alignItems: 'center', position: 'relative', zIndex: 1 }}>
        {[...new Map(running.map((p) => [p.role, p.hue])).entries()].map(([role, hue]) => (
          <span key={role}><i style={{ width: 9, height: 9, borderRadius: 3, display: 'inline-block', marginRight: 5, verticalAlign: 'middle', background: hue }} />{role}</span>
        ))}
        <span><i style={{ width: 9, height: 9, borderRadius: 3, display: 'inline-block', marginRight: 5, verticalAlign: 'middle', background: T.ext }} />被管数据库</span>
        <span><i style={{ display: 'inline-block', width: 16, borderTop: `2px solid ${T.blue}`, verticalAlign: 'middle', marginRight: 5 }} />调用 / 派发</span>
        <span><i style={{ display: 'inline-block', width: 16, borderTop: `2px dashed ${T.lv.ok}`, verticalAlign: 'middle', marginRight: 5 }} />读写数据</span>
        <span style={{ color: T.dim }}>线色 = 调用方 · 点任意 Pod 或节点格看右侧详情</span>
      </div>
    </div>
  );
}

/** 详情面板里共用的资源水位条 */
export function Meter({ label, used, req, lim, unit }: { label: string; used: number; req: number; lim: number; unit: 'm' | 'Mi' }) {
  const cap = lim > 0 ? lim : (unit === 'm' ? 18000 : 64 * 1024);
  const p = Math.min(100, (used / cap) * 100);
  const r = req > 0 ? Math.min(100, (req / cap) * 100) : -1;
  const color = p >= 85 ? T.lv.crit : p >= 60 ? T.lv.warn : T.lv.ok;
  const fmt = (v: number) => (unit === 'm' ? `${v}m` : fmtMem(v));
  return (
    <div style={{ margin: '7px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: T.sub, marginBottom: 3 }}>
        <span>{label}</span>
        <span><b style={{ fontWeight: 600, color: T.ink, ...tnum }}>{fmt(used)}</b> {lim > 0 ? `/ limit ${fmt(lim)}` : <span style={{ color: T.dim }}>无 limit</span>}</span>
      </div>
      <div style={{ height: 7, borderRadius: 4, background: T.fill2, position: 'relative', overflow: 'hidden' }}>
        <i style={{ position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 4, width: `${p.toFixed(1)}%`, background: color }} />
        {r >= 0 ? <span style={{ position: 'absolute', top: -2, bottom: -2, width: 2, background: T.blue, left: `${r.toFixed(1)}%` }} /> : null}
      </div>
      <div style={{ fontSize: 11.5, color: T.dim, marginTop: 2 }}>
        {req > 0 ? `蓝线 = request ${fmt(req)} · ` : ''}{lim > 0 ? `用量为 limit 的 ${p.toFixed(1)}%` : '无 limit，按节点容量折算'}
      </div>
    </div>
  );
}

export { LVCN };
