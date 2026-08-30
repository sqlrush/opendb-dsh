/**
 * task-ddl client 面板（R2，2026-08-30 user 定稿 docs/prototypes/ddl-r2.html）：
 * 状态带 + 摘要卡 → 结构演进图（主干版本 + schema/表生命线，点线段看该生命时段的结构差异，点节点看那次变更）→
 * 版本比较（GitHub compare：任选两版，逐对象列/索引级 diff）→ 变更时间轴（按日）→ 规范扫描（含通过项、深挖）→
 * 变更故事线 / 处置优先级（模型）→ 检查历史。数字全部来自采集存档 run.collect；diff 在前端按定义时间线算（history.ts 纯函数）。
 */
import { useEffect, useMemo, useState } from 'react';
import { compareVersions, stateAt, diffDefinition } from '../history.ts';
import type { Version, Lane, SubLane, ObjectHistory, DdlEvent, ObjectDiff } from '../history.ts';
import { T, sev, mono, FONT, tnum, card, keyChip, codeBlock, LANE_COLORS, changeColor, CHANGE_CN, SRC_CN, hhmm, mmdd, mmddhhmm, ymd, oneLine } from './format.ts';

export const inject = ['slots', 'connection', 'workspaces', 'sessions'];

const ORDER: Record<string, number> = { critical: 3, warn: 2, notice: 1, ok: 0 };
const ms = (t: string) => new Date(t).getTime();
/** 对象名：表不带 kind 前缀，其它带；审计里的 schema 级事件没有 sch（"建 schema ddl_lab"，不是 ".ddl_lab"） */
const objName = (e: { kind: string; sch: string; name: string; change: string }) => (e.change === 'user' ? e.name : `${e.kind !== 'table' ? `${e.kind} ` : ''}${e.sch !== '' ? `${e.sch}.` : ''}${e.name}`);

// ───────────────────────────────────────────── 小件
function H2({ children, hint, tight }: { children: any; hint?: string; tight?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: tight ? '0 0 10px' : '28px 0 12px', flexWrap: 'wrap' }}>
      <span style={{ fontSize: tight ? 16 : 18, fontWeight: 600, color: T.ink }}>{children}</span>
      {hint !== undefined ? <span style={{ fontSize: 13.5, color: T.dim }}>{hint}</span> : null}
    </div>
  );
}
function Sw({ color, size = 10 }: { color: string; size?: number }) { return <i style={{ display: 'inline-block', width: size, height: size, borderRadius: 3, background: color, flex: 'none', fontStyle: 'normal' }} />; }
function Chip({ level, children, small }: { level: string; children: any; small?: boolean }) {
  const s = sev(level);
  return <span style={{ display: 'inline-flex', gap: 5, fontSize: small ? 12 : 13.5, fontWeight: 500, color: s.c, background: s.soft, borderRadius: 6, padding: small ? '0 8px' : '2px 10px', whiteSpace: 'nowrap' }}>{children}</span>;
}
function Src({ s }: { s: string }) { return <span style={{ fontSize: 11, borderRadius: 4, padding: '0 6px', background: T.fill2, color: T.sub, whiteSpace: 'nowrap' }}>{SRC_CN[s] ?? s}</span>; }
function Link({ onClick, children, busy, fail, title }: { onClick: () => void; children: any; busy?: boolean; fail?: boolean; title?: string }) {
  return <button type="button" onClick={onClick} disabled={busy} title={title} style={{ font: 'inherit', fontSize: 12.5, color: fail ? T.sev.critical.c : T.blue, background: 'none', border: 'none', padding: 0, cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}>{children}</button>;
}
let clientCtx: any;
async function digInSession(text: string): Promise<string> {
  if (clientCtx === undefined) throw new Error('客户端上下文未就绪');
  const ws = clientCtx.workspaces?.list?.getSnapshot?.()?.items?.[0];
  const sessionId: string = await clientCtx.sessions.create(ws?.workspaceId !== undefined ? { workspaceId: ws.workspaceId } : {});
  const bridge = (window as any).__opendbHarness__;
  if (typeof bridge?.openSession === 'function') bridge.openSession(sessionId); else clientCtx.sessions.open(sessionId);
  const r = await clientCtx.connection.rpc.call('/api', 'session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  if (r?.ok === false) throw new Error(String(r.error?.message ?? 'prompt rejected'));
  return sessionId;
}
function DigLink({ prompt, label }: { prompt: string; label: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'fail'>('idle');
  return <Link busy={state === 'busy'} fail={state === 'fail'} title="直接新建会话并把本条数据作为背景发出" onClick={() => { setState('busy'); digInSession(prompt).then(() => setState('idle')).catch(() => setState('fail')); }}>{state === 'busy' ? '开会话中…' : state === 'fail' ? '失败，重试' : `${label} →`}</Link>;
}
const windowLine = (c: any) => `节点 ${String(c.node)} · 回溯 ${Number(c.windowHours)} 小时（${mmddhhmm(String(c.since))} → ${mmddhhmm(String(c.until))}）`;
const DIG_TAIL = '任务：先用工具取证（ddl_collect 同一窗口、db_describe 看对象现状、db_query 只读），再给出：1) 这次变更做了什么、是否计划内、风险（下游依赖 / 数据量 / 锁）；2) 建议的处置或跟踪方式。本平台只读，不执行任何变更。不要向我反问，直接给结论。';

// ───────────────────────────────────────────── 摘要卡
function Stats({ s, c }: { s: any; c: any }) {
  const n = (v: any) => Number(v ?? 0);
  const cells: [string, any, string, string?][] = [
    ['变更事件', n(s.events), `${n(s.structural)} 次结构 · ${n(s.account)} 次账号权限`],
    ['涉及对象', n(s.objects), `表 ${n(s.tables)} · 共 ${n(s.objects)} 个对象`],
    ['操作者', (s.users ?? []).length, `${(s.users ?? []).slice(0, 3).join(' · ') || '无'}${n(s.unattributed) > 0 ? ` · 未归因 ${n(s.unattributed)}` : ''}`],
    ['破坏性变更', n(s.destructive), n(s.destructive) > 0 ? 'DROP TABLE / SCHEMA' : '无', n(s.destructive) > 0 ? T.sev.warn.c : undefined],
    ['业务时段变更', n(s.businessHours), '09:00–20:00 内执行', n(s.businessHours) > 0 ? T.sev.notice.c : undefined],
    ['结构版本', n(s.versions), `${n(s.schemas)} 个 schema 有变化`],
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
      {cells.map(([l, v, d, color]) => (
        <div key={l} style={{ background: T.fill, borderRadius: 8, padding: '11px 13px', minWidth: 0 }}>
          <div style={{ fontSize: 12.5, color: T.dim, whiteSpace: 'nowrap' }}>{l}</div>
          <div style={{ fontSize: 21, fontWeight: 600, lineHeight: 1.3, marginTop: 2, color, ...tnum }}>{String(v)}</div>
          <div style={{ fontSize: 12, color: T.dim, lineHeight: 1.45 }}>{d}</div>
        </div>
      ))}
    </div>
  );
}

// ───────────────────────────────────────────── 演进图
type Sel = { type: 'version'; v: Version } | { type: 'segment'; lane: Lane; sub?: SubLane; from: string; to: string; fromLabel: string; toLabel: string } | { type: 'event'; e: DdlEvent };
function Graph({ c, sel, onSel }: { c: any; sel: Sel | undefined; onSel: (s: Sel) => void }) {
  const versions: Version[] = c.versions ?? []; const lanes: Lane[] = c.lanes ?? []; const events: DdlEvent[] = c.events ?? [];
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(lanes.filter((l) => l.subs.length > 0 && l.subs.length <= 8).map((l) => [l.id, true])));
  const [tip, setTip] = useState<{ x: number; y: number; html: any } | undefined>();
  const W = 800, L = 200, R = 24, TOP = 34, LH = 40, SUB_H = 30;
  // 时间轴：缩放到结构事件的跨度（窗口很长而事件集中时看得清），至少 1 小时；更早的账号类事件贴到左缘并标 ◂
  const structural = versions.filter((v) => v.kind !== 'user').map((v) => ms(v.time));
  const times = structural.length > 0 ? structural : versions.map((v) => ms(v.time));
  const until = ms(String(c.until)); const since = ms(String(c.since));
  const first = times.length > 0 ? Math.min(...times) : since;
  const span = Math.max(3600_000, until - first);
  const t0 = Math.max(since, first - span * 0.08); const t1 = until;
  const x = (t: number) => L + (Math.max(t0, Math.min(t1, t)) - t0) / (t1 - t0) * (W - L - R);
  const clamped = (t: number) => t < t0;
  const rows: { lane: Lane; sub?: SubLane; y: number; h: number }[] = [];
  let y = TOP + LH;
  for (const lane of lanes) { rows.push({ lane, y, h: LH }); y += LH; if (open[lane.id]) for (const s of lane.subs) { rows.push({ lane, sub: s, y, h: SUB_H }); y += SUB_H; } }
  const H = y + 10;
  const trunkY = TOP + 8;
  const versionAt = (id: string) => versions.find((v) => v.v === id);
  const ticks: number[] = []; const stepMs = (t1 - t0) > 5 * 86400_000 ? 86400_000 * Math.ceil((t1 - t0) / 86400_000 / 6) : (t1 - t0) > 6 * 3600_000 ? 3600_000 * Math.ceil((t1 - t0) / 3600_000 / 6) : 600_000 * Math.ceil((t1 - t0) / 600_000 / 6);
  for (let t = Math.ceil(t0 / stepMs) * stepMs; t <= t1; t += stepMs) ticks.push(t);
  const showTip = (e: any, html: any) => setTip({ x: e.clientX + 14, y: e.clientY + 14, html });
  const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length];
  return (
    <div style={{ position: 'relative', minWidth: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMinYMin meet" style={{ width: '100%', height: 'auto', display: 'block', fontFamily: FONT }}>
        {ticks.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={TOP - 6} y2={H - 6} stroke="#eef0f3" /><text x={x(t)} y={TOP - 12} textAnchor="middle" fontSize={10.5} fill={T.dim}>{stepMs >= 86400_000 ? mmdd(new Date(t).toISOString()) : hhmm(new Date(t).toISOString())}</text></g>)}
        <text x={8} y={trunkY + 4} fontSize={12} fontWeight={600} fill={T.ink}>主干 · 库级结构版本</text>
        <line x1={x(t0)} x2={W - R} y1={trunkY} y2={trunkY} stroke={T.ink} strokeWidth={3} strokeLinecap="round" />
        {versions.map((v, i) => (
          <g key={v.v} style={{ cursor: 'pointer' }} onClick={() => onSel({ type: 'version', v })} onMouseMove={(e) => showTip(e, <><b>{v.v} · {mmddhhmm(v.time)}</b> · {v.who || '未归因'}<br />{v.label}</>)} onMouseLeave={() => setTip(undefined)}>
            <circle cx={x(ms(v.time))} cy={trunkY} r={sel?.type === 'version' && sel.v.v === v.v ? 7.5 : 6} fill="#fff" stroke={changeColor(v.kind === 'add' ? 'added' : v.kind === 'del' ? 'removed' : v.kind === 'user' ? 'user' : 'modified')} strokeWidth={2.5} />
            {(versions.length <= 12 || i % 2 === 0 || i === versions.length - 1) ? <text x={x(ms(v.time))} y={trunkY - 11} textAnchor="middle" fontSize={10} fill={T.sub} fontFamily={mono}>{clamped(ms(v.time)) ? `◂${v.v}` : v.v}</text> : null}
          </g>
        ))}
        {rows.map((row, ri) => {
          const li = lanes.indexOf(row.lane); const color = row.lane.kind === 'account' ? T.user : laneColor(li);
          const cy = row.y + 8;
          const isSub = row.sub !== undefined;
          const evs: { t: number; change: string; who: string; versionId: string; e?: DdlEvent }[] = isSub
            ? row.sub!.events.map((e) => ({ t: ms(e.time), change: e.change, who: e.who, versionId: e.versionId }))
            : row.lane.kind === 'account'
              ? events.filter((e) => e.change === 'user').map((e) => ({ t: ms(e.time), change: 'user', who: e.who, versionId: '', e }))
              : row.lane.versionIds.map((id) => versionAt(id)).filter((v): v is Version => v !== undefined).map((v) => ({ t: ms(v.time), change: v.kind === 'add' ? 'added' : v.kind === 'del' ? 'removed' : 'modified', who: v.who, versionId: v.v }));
          const born = isSub ? row.sub!.born : row.lane.born; const died = isSub ? row.sub!.died : row.lane.died;
          const xs = born !== null ? x(ms(born)) : x(t0); const xe = died !== null ? x(ms(died)) : W - R;
          const pts = [{ t: born !== null ? ms(born) : t0, x: xs, first: true }, ...evs.filter((e) => (born === null || e.t > ms(born)) && (died === null || e.t < ms(died))).sort((a, b) => a.t - b.t).map((e) => ({ t: e.t, x: x(e.t), ev: e })), { t: died !== null ? ms(died) : t1, x: xe, last: true }];
          const segLabel = (p: any) => (p.first ? (born !== null ? `建立 ${mmddhhmm(born)}` : '窗口起（此前已存在）') : p.last ? (died !== null ? `删除 ${mmddhhmm(died)}` : '至今') : `${p.ev.versionId || ''} ${mmddhhmm(new Date(p.t).toISOString())}`);
          return (
            <g key={ri}>
              <text x={isSub ? 18 : 8} y={cy - 3} fontSize={isSub ? 11 : 12} fill={isSub ? T.sub : T.ink} fontWeight={isSub ? 400 : 600} style={{ cursor: !isSub && row.lane.subs.length > 0 ? 'pointer' : 'default' }} onClick={() => { if (!isSub && row.lane.subs.length > 0) setOpen({ ...open, [row.lane.id]: !open[row.lane.id] }); }}>{isSub ? `└ ${row.sub!.kind === 'table' ? '' : row.sub!.kind + ' '}${row.sub!.name}` : `${row.lane.subs.length > 0 ? (open[row.lane.id] ? '▾ ' : '▸ ') : ''}${row.lane.id}`}</text>
              <text x={isSub ? 18 : 8} y={cy + 9} fontSize={10} fill={T.dim}>{isSub ? `${row.sub!.events.length} 次变更` : row.lane.kind === 'account' ? row.lane.note : `${row.lane.tables} 表 · ${row.lane.note}`}</text>
              {born !== null && !isSub ? <path d={`M ${xs} ${trunkY} C ${xs} ${trunkY + 14}, ${xs} ${cy - 14}, ${xs} ${cy}`} fill="none" stroke={color} strokeWidth={2} strokeDasharray="3 3" /> : null}
              {isSub ? <path d={`M ${xs} ${cy - SUB_H + 12} L ${xs} ${cy}`} fill="none" stroke={color} strokeWidth={1.2} strokeDasharray="2 3" opacity={0.6} /> : null}
              {pts.slice(0, -1).map((a, i) => {
                const b = pts[i + 1]; if (b.x - a.x < 1) return null;
                const selected = sel?.type === 'segment' && sel.lane.id === row.lane.id && (sel.sub?.key ?? '') === (row.sub?.key ?? '') && sel.from === new Date(a.t).toISOString();
                return <line key={i} x1={a.x} x2={b.x} y1={cy} y2={cy} stroke={color} strokeWidth={selected ? 9 : isSub ? 2.5 : 5} strokeLinecap="round" strokeDasharray={born === null && i === 0 ? '6 5' : undefined} opacity={isSub ? 0.65 : 0.85} style={{ cursor: 'pointer' }}
                  onMouseMove={(e) => showTip(e, <><b>{isSub ? row.sub!.name : row.lane.id}</b> 生命时段<br />{segLabel(a)} → {segLabel(b)}<br /><span style={{ color: T.blue }}>点击查看该时段内的结构变化</span></>)} onMouseLeave={() => setTip(undefined)}
                  onClick={() => onSel({ type: 'segment', lane: row.lane, sub: row.sub, from: new Date(a.t).toISOString(), to: new Date(b.t).toISOString(), fromLabel: segLabel(a), toLabel: segLabel(b) })} />;
              })}
              {evs.map((e, i) => (
                <g key={i} style={{ cursor: 'pointer' }} onClick={() => { const v = versionAt(e.versionId); if (v !== undefined) onSel({ type: 'version', v }); else if (e.e !== undefined) onSel({ type: 'event', e: e.e }); }} onMouseMove={(ev) => showTip(ev, <><b>{e.versionId ? `${e.versionId} · ` : ''}{mmddhhmm(new Date(e.t).toISOString())}</b> · {e.who || '未归因'}<br />{CHANGE_CN[e.change] ?? e.change}{isSub ? ` ${row.sub!.name}` : ''}{e.e !== undefined ? ` ${oneLine(e.e.sql).slice(0, 80)}` : ''}</>)} onMouseLeave={() => setTip(undefined)}>
                  <circle cx={x(e.t)} cy={cy} r={isSub ? 4.5 : 5.5} fill={changeColor(e.change)} stroke="#fff" strokeWidth={2} />
                </g>
              ))}
              {died !== null ? <path d={`M ${xe - 5} ${cy - 5} L ${xe + 5} ${cy + 5} M ${xe + 5} ${cy - 5} L ${xe - 5} ${cy + 5}`} stroke={T.del} strokeWidth={2.5} /> : row.lane.kind !== 'account' ? <path d={`M ${xe - 8} ${cy - 5} L ${xe} ${cy} L ${xe - 8} ${cy + 5}`} fill="none" stroke={color} strokeWidth={2} /> : null}
            </g>
          );
        })}
      </svg>
      {tip !== undefined ? <div style={{ position: 'fixed', left: tip.x, top: tip.y, pointerEvents: 'none', background: '#fff', border: `1px solid ${T.line}`, borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,.12)', padding: '8px 12px', fontSize: 12.5, lineHeight: 1.55, maxWidth: 360, zIndex: 9 }}>{tip.html}</div> : null}
    </div>
  );
}

// ───────────────────────────────────────────── diff 渲染
function DiffRows({ rows }: { rows: { k: string; t: string }[] }) {
  return (
    <div style={{ font: `12.5px/1.65 ${mono}` }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '22px minmax(0,1fr)', padding: '0 12px 0 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: r.k === 'add' ? T.addSoft : r.k === 'del' ? T.delSoft : r.k === 'mod' ? T.modSoft : undefined }}>
          <span style={{ color: r.k === 'add' ? T.add : r.k === 'del' ? T.del : r.k === 'mod' ? T.mod : T.dim }}>{r.k === 'add' ? '+' : r.k === 'del' ? '−' : r.k === 'mod' ? '~' : ' '}</span><span>{r.t}</span>
        </div>
      ))}
    </div>
  );
}
function DiffCard({ d, open, onToggle }: { d: ObjectDiff; open: boolean; onToggle: () => void }) {
  const a = d.rows.filter((r) => r.k === 'add').length, del = d.rows.filter((r) => r.k === 'del').length, m = d.rows.filter((r) => r.k === 'mod').length;
  const level = d.change === 'del' ? 'warn' : d.change === 'add' ? 'ok' : 'notice';
  return (
    <div style={{ border: `1px solid ${T.line}`, borderRadius: 8, marginTop: 10, overflow: 'hidden' }}>
      <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', background: T.fill, fontSize: 13.5, cursor: 'pointer' }}>
        <span style={{ fontFamily: mono, fontWeight: 600 }}>{d.kind !== 'table' ? `${d.kind} ` : ''}{d.sch}.{d.name}</span>
        <span style={{ fontFamily: mono, fontSize: 12 }}><span style={{ color: T.add }}>+{a}</span> <span style={{ color: T.del }}>−{del}</span> <span style={{ color: T.mod }}>~{m}</span></span>
        {d.unknown ? <span style={{ fontSize: 12, color: T.dim }}>· 该时段定义未完整观测</span> : null}
        <span style={{ marginLeft: 'auto' }}><Chip level={level} small>{d.change === 'add' ? '新建' : d.change === 'del' ? '删除' : '修改'}</Chip></span>
      </div>
      {open ? <div style={{ borderTop: `1px solid ${T.line}`, padding: '6px 0' }}><DiffRows rows={d.rows} /></div> : null}
    </div>
  );
}

// ───────────────────────────────────────────── 右侧面板
function SidePanel({ c, sel, data }: { c: any; sel: Sel | undefined; data: any }) {
  const objects: Record<string, ObjectHistory> = c.objects ?? {}; const events: DdlEvent[] = c.events ?? [];
  const notes = new Map<string, string>(((data?.versionNotes ?? []) as any[]).map((n) => [String(n.v), String(n.note ?? '')]));
  const box: any = { borderLeft: `1px solid ${T.line}`, paddingLeft: 20, minHeight: 320, fontSize: 13.5, minWidth: 0 };
  const kv = (rows: [string, any][]) => <div style={{ display: 'grid', gridTemplateColumns: '72px minmax(0,1fr)', gap: '4px 10px', fontSize: 13, margin: '8px 0' }}>{rows.map(([l, v]) => <div key={l} style={{ display: 'contents' }}><span style={{ color: T.dim }}>{l}</span><span>{v}</span></div>)}</div>;
  if (sel === undefined) {
    const vs: Version[] = c.versions ?? [];
    return <div style={box}><div style={{ fontSize: 13, color: T.dim, marginBottom: 6 }}>点左侧线段或节点</div><h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 6px' }}>{String(c.node)} · {Number(c.windowHours)} 小时结构演进</h3><div style={{ color: T.sub }}>主干 {vs.length} 个版本 · {(c.lanes ?? []).length} 条生命线。点 <b>线段</b>：看该对象在这段生命周期里列 / 索引怎么变；点 <b>节点</b>：看那一次变更的原文与来源；点 schema 名可展开/折叠表级子线。</div>{vs.length > 0 ? <div style={{ ...codeBlock, marginTop: 10 }}>{vs.slice(0, 12).map((v) => `${v.v} ${mmddhhmm(v.time)} ${v.label}`).join('\n')}{vs.length > 12 ? `\n… 共 ${vs.length} 版` : ''}</div> : <div style={{ color: T.dim, marginTop: 8 }}>窗口内没有结构变更。</div>}</div>;
  }
  if (sel.type === 'version') {
    const v = sel.v; const evs = events.filter((e) => v.eventIds.includes(e.id));
    return <div style={box}><div style={{ fontSize: 13, color: T.dim, marginBottom: 6 }}>主干版本</div><h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 6px' }}>{v.v} · {v.label}</h3>
      {kv([['时间', mmddhhmm(v.time)], ['操作者', v.who || '未归因'], ['对象数', v.objs], ['来源', <span style={{ display: 'inline-flex', gap: 4 }}>{[...new Set(evs.flatMap((e) => e.sources))].map((s) => <Src key={s} s={s} />)}</span>]])}
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>{evs.slice(0, 40).map((e) => <div key={e.id} style={{ fontSize: 12.5, padding: '3px 0', borderTop: `1px solid ${T.line}` }}><Sw color={changeColor(e.change)} size={8} /> <span style={{ fontFamily: mono }}>{CHANGE_CN[e.change] ?? e.change} {objName(e)}</span>{e.sql !== '' ? <div style={{ ...codeBlock, margin: '4px 0' }}>{e.sql}</div> : e.change !== 'user' && e.defUnknown ? <span style={{ color: T.dim }}> · 仅时间戳，定义差异未观测</span> : null}</div>)}{evs.length > 40 ? <div style={{ color: T.dim }}>… 共 {evs.length} 条</div> : null}</div>
      {notes.has(v.v) && notes.get(v.v) !== '' ? <div style={{ marginTop: 8 }}><b style={{ fontWeight: 500 }}>解读（模型）</b>：{notes.get(v.v)}</div> : null}
      <div style={{ display: 'flex', gap: 14, justifyContent: 'flex-end', marginTop: 8 }}><DigLink prompt={[`【表结构变更深挖】${windowLine(c)} · 版本 ${v.v} · ${mmddhhmm(v.time)} · 操作者 ${v.who || '未归因'}`, `变更：${v.label}`, ...evs.slice(0, 20).map((e) => `- ${CHANGE_CN[e.change] ?? e.change} ${e.sch !== '' ? `${e.sch}.` : ''}${e.name}${e.sql !== '' ? `：${oneLine(e.sql).slice(0, 200)}` : ''}`), DIG_TAIL].join('\n')} label="在会话里深挖" /></div></div>;
  }
  if (sel.type === 'event') {
    const e = sel.e;
    return <div style={box}><div style={{ fontSize: 13, color: T.dim, marginBottom: 6 }}>账号 / 权限变更</div><h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 6px' }}>{mmddhhmm(e.time)} · {e.who}</h3><div style={codeBlock}>{e.sql || `${e.kind} ${e.name}`}</div>{kv([['来源', <span style={{ display: 'inline-flex', gap: 4 }}>{e.sources.map((s) => <Src key={s} s={s} />)}</span>]])}</div>;
  }
  // 线段：该 lane（或子线）里对象在 from → to 之间的结构差异
  const keys = sel.sub !== undefined ? [sel.sub.key] : Object.keys(objects).filter((k) => objects[k].sch === sel.lane.id);
  const subset: Record<string, ObjectHistory> = Object.fromEntries(keys.filter((k) => objects[k] !== undefined).map((k) => [k, objects[k]]));
  const cmp = compareVersions(subset, sel.from, sel.to);
  const inRange = events.filter((e) => (sel.sub !== undefined ? `${e.kind === 'index' ? 'index' : e.kind} ${e.sch}.${e.name}` === sel.sub.key || (e.sch === sel.sub.sch && e.name === sel.sub.name) : e.sch === sel.lane.id) && ms(e.time) > ms(sel.from) && ms(e.time) <= ms(sel.to));
  return <div style={box}><div style={{ fontSize: 13, color: T.dim, marginBottom: 6 }}>生命时段 · {sel.sub !== undefined ? `${sel.sub.sch}.${sel.sub.name}` : sel.lane.id}</div><h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 6px' }}>{sel.fromLabel} → {sel.toLabel}</h3>
    {kv([['对象', sel.sub !== undefined ? `${sel.sub.kind} ${sel.sub.name}` : `${sel.lane.tables} 表 · ${sel.lane.objects} 个对象`], ['时段内事件', `${inRange.length} 条`], ['结构差异', `+${cmp.summary.add} 新建 · ~${cmp.summary.mod} 修改 · −${cmp.summary.del} 删除${cmp.summary.unknown > 0 ? ` · ${cmp.summary.unknown} 个定义未完整观测` : ''}`]])}
    {cmp.objects.length === 0 ? <div style={{ color: T.sub }}>该时段内{sel.sub !== undefined ? '此对象' : '该 schema'}结构无变化{inRange.length > 0 ? `（${inRange.length} 次变更只有时间戳，签名未变——授权 / 统计类）` : ''}。</div> : cmp.objects.slice(0, 12).map((d) => <div key={d.key} style={{ margin: '6px 0' }}><div style={{ fontSize: 12.5, color: T.sub, fontFamily: mono }}>{d.change === 'add' ? '+ ' : d.change === 'del' ? '− ' : '~ '}{d.kind !== 'table' ? `${d.kind} ` : ''}{d.name}</div><div style={{ background: T.fill, borderRadius: 8, padding: '4px 0' }}><DiffRows rows={d.rows.filter((r) => r.k !== 'same')} /></div></div>)}
    {cmp.objects.length > 12 ? <div style={{ color: T.dim }}>… 共 {cmp.objects.length} 个对象，见下方版本比较</div> : null}
    <div style={{ display: 'flex', gap: 14, justifyContent: 'flex-end', marginTop: 8 }}><DigLink prompt={[`【表结构变更深挖】${windowLine(c)} · ${sel.sub !== undefined ? `对象 ${sel.sub.kind} ${sel.sub.sch}.${sel.sub.name}` : `schema ${sel.lane.id}`} · 生命时段 ${sel.fromLabel} → ${sel.toLabel}`, `结构差异：${cmp.objects.slice(0, 8).map((d) => `${d.change} ${d.sch}.${d.name}（${d.rows.filter((r) => r.k !== 'same').map((r) => `${r.k === 'add' ? '+' : r.k === 'del' ? '-' : '~'} ${r.t}`).join('；')}）`).join('\n') || '无'}`, DIG_TAIL].join('\n')} label="在会话里深挖" /></div></div>;
}

// ───────────────────────────────────────────── 版本比较
function CompareSection({ c }: { c: any }) {
  const versions: Version[] = c.versions ?? []; const objects: Record<string, ObjectHistory> = c.objects ?? {};
  // 版本的结构 = 该批次最后一个事件之后（until）
  const opts = useMemo(() => [{ id: 'start', label: `窗口起点 · ${mmddhhmm(String(c.since))}`, time: String(c.since) }, ...versions.map((v) => ({ id: v.v, label: `${v.v} · ${mmddhhmm(v.time)} · ${v.label.slice(0, 48)}`, time: v.until ?? v.time })), { id: 'now', label: `当前 · ${mmddhhmm(String(c.until))}`, time: String(c.until) }], [c]);
  const [base, setBase] = useState(opts[0].id); const [cmpId, setCmp] = useState(opts[opts.length - 1].id);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const A = opts.find((o) => o.id === base) ?? opts[0]; const B = opts.find((o) => o.id === cmpId) ?? opts[opts.length - 1];
  const result = useMemo(() => compareVersions(objects, A.time, B.time), [objects, A.time, B.time]);
  const s = result.summary;
  const selStyle: any = { font: 'inherit', fontSize: 13.5, border: `1px solid ${T.line}`, borderRadius: 8, padding: '4px 8px', background: '#fff', color: T.ink, maxWidth: 440 };
  const quick: [string, string, string][] = versions.length >= 2 ? [['start', 'now', '窗口起点 → 当前'], [versions[0].v, versions[versions.length - 1].v, `${versions[0].v} → ${versions[versions.length - 1].v}`], ...(versions.length >= 3 ? [[versions[versions.length - 2].v, versions[versions.length - 1].v, `最近两版`] as [string, string, string]] : [])] : [['start', 'now', '窗口起点 → 当前']];
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13.5 }}>
        <span style={{ color: T.dim }}>base</span><select value={base} onChange={(e) => setBase(e.target.value)} style={selStyle}>{opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
        <button type="button" onClick={() => { setBase(cmpId); setCmp(base); }} title="交换" style={{ font: 'inherit', border: `1px solid ${T.line}`, borderRadius: 8, padding: '3px 9px', color: T.sub, cursor: 'pointer', background: '#fff' }}>⇄</button>
        <span style={{ color: T.dim }}>compare</span><select value={cmpId} onChange={(e) => setCmp(e.target.value)} style={selStyle}>{opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 12.5, marginTop: 10, alignItems: 'center', color: T.dim }}>常用对比：{quick.map(([a, b, l]) => <button key={l} type="button" onClick={() => { setBase(a); setCmp(b); }} style={{ font: 'inherit', fontSize: 12.5, border: `1px solid ${base === a && cmpId === b ? T.blue : T.line}`, borderRadius: 6, padding: '1px 10px', color: base === a && cmpId === b ? '#fff' : T.sub, background: base === a && cmpId === b ? T.blue : '#fff', cursor: 'pointer' }}>{l}</button>)}</div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '14px 0 6px', fontSize: 13.5, color: T.sub, ...tnum }}>
        <span><b style={{ color: T.ink }}>{A.id === 'start' ? '窗口起点' : A.id === 'now' ? '当前' : A.id}</b> → <b style={{ color: T.ink }}>{B.id === 'start' ? '窗口起点' : B.id === 'now' ? '当前' : B.id}</b></span>
        <span>对象：<b style={{ color: T.add }}>+{s.add} 新建</b> · <b style={{ color: T.mod }}>~{s.mod} 修改</b> · <b style={{ color: T.del }}>−{s.del} 删除</b></span>
        <span>列：<b style={{ color: T.add }}>+{s.cols.add}</b> <b style={{ color: T.del }}>−{s.cols.del}</b> <b style={{ color: T.mod }}>~{s.cols.mod}</b></span>
        <span>索引/视图：<b style={{ color: T.add }}>+{s.idx.add}</b> <b style={{ color: T.del }}>−{s.idx.del}</b> <b style={{ color: T.mod }}>~{s.idx.mod}</b></span>
        {s.unknown > 0 ? <span style={{ color: T.dim }}>· {s.unknown} 个对象定义未完整观测</span> : null}
        <span style={{ marginLeft: 'auto', color: T.dim }}>只列有变化的对象</span>
      </div>
      {result.objects.length === 0 ? <div style={{ color: T.dim, fontSize: 13.5, marginTop: 8 }}>两个时点的结构完全一致。</div> : result.objects.slice(0, 60).map((d) => <DiffCard key={d.key} d={d} open={open[d.key] ?? d.change === 'mod'} onToggle={() => setOpen({ ...open, [d.key]: !(open[d.key] ?? d.change === 'mod') })} />)}
      {result.objects.length > 60 ? <div style={{ color: T.dim, fontSize: 13, marginTop: 8 }}>… 共 {result.objects.length} 个对象有变化，只显示前 60</div> : null}
    </div>
  );
}

// ───────────────────────────────────────────── 时间轴 / 规范 / 历史 / 旧版
function Timeline({ c, versions }: { c: any; versions: Version[] }) {
  const events: DdlEvent[] = (c.events ?? []).slice().sort((a: DdlEvent, b: DdlEvent) => ms(b.time) - ms(a.time));
  const versionOf = new Map<string, string>(); for (const v of versions) for (const id of v.eventIds) versionOf.set(id, v.v);
  const byDay = new Map<string, DdlEvent[]>(); for (const e of events) { const d = ymd(e.time); byDay.set(d, [...(byDay.get(d) ?? []), e]); }
  const [limit, setLimit] = useState(40); let shown = 0;
  return (
    <div style={card}>
      {events.length === 0 ? <div style={{ color: T.dim, fontSize: 13.5 }}>窗口内没有变更。</div> : null}
      {[...byDay.entries()].map(([d, evs]) => shown >= limit ? null : (
        <div key={d} style={{ marginTop: 10 }}>
          <div style={{ fontSize: 13, color: T.dim, marginBottom: 4 }}>{d} · {evs.length} 条</div>
          {evs.map((e) => { if (shown >= limit) return null; shown += 1; return (
            <div key={e.id} style={{ display: 'grid', gridTemplateColumns: '48px 10px 44px 90px minmax(0,1fr) auto', gap: 10, alignItems: 'start', padding: '6px 0', borderTop: `1px solid ${T.line}`, fontSize: 13.5 }}>
              <span style={{ fontFamily: mono, fontSize: 12.5, color: T.sub }}>{hhmm(e.time)}</span><i style={{ width: 8, height: 8, borderRadius: 4, marginTop: 8, background: changeColor(e.change), fontStyle: 'normal' }} /><span style={{ fontFamily: mono, fontSize: 12, color: T.dim }}>{versionOf.get(e.id) ?? ''}</span><span style={{ fontSize: 12.5, color: T.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.who || '未归因'}</span>
              <div style={{ minWidth: 0 }}>{CHANGE_CN[e.change] ?? e.change} <span style={{ fontFamily: mono }}>{objName(e)}</span>{e.sql !== '' ? <div style={{ fontSize: 12.5, color: T.dim, fontFamily: mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.sql}>{oneLine(e.sql)}</div> : null}</div>
              <span style={{ display: 'inline-flex', gap: 4 }}>{e.sources.map((s) => <Src key={s} s={s} />)}</span>
            </div>); })}
        </div>))}
      {events.length > limit ? <div style={{ marginTop: 8 }}><Link onClick={() => setLimit(limit + 80)}>显示更多（共 {events.length} 条）</Link></div> : null}
    </div>
  );
}
const RULE_LABEL: Record<string, string> = { DDLR00: 'DROP SCHEMA', DDLR01: '表被删除', DDLR02: 'TRUNCATE', DDLR03: 'DROP COLUMN / CONSTRAINT', DDLR04: '业务时段变更', DDLR05: '同一对象反复变更', DDLR06: '账号权限提升', DDLR07: '无主键新表', DDLR90: '归因缺失' };
function Rules({ c, notes }: { c: any; notes: Map<string, string> }) {
  const findings: any[] = (c.ruleFindings ?? []).slice().sort((a: any, b: any) => (ORDER[String(b.level)] ?? 0) - (ORDER[String(a.level)] ?? 0));
  const hit = new Set(findings.map((f) => String(f.rule)));
  const passed = ['DDLR00', 'DDLR01', 'DDLR02', 'DDLR03', 'DDLR04', 'DDLR05', 'DDLR90'].filter((r) => !hit.has(r));
  return (
    <div style={{ ...card, padding: '4px 20px' }}>
      {findings.map((f, i) => { const lv = String(f.level); const note = notes.get(`${String(f.rule)}|${String(f.object)}`) ?? notes.get(String(f.rule)) ?? ''; return (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '8px 100px minmax(0,1fr) 110px', gap: 12, alignItems: 'start', padding: '10px 0', borderTop: i === 0 ? 'none' : `1px solid ${T.line}`, fontSize: 14 }}>
          <i style={{ width: 8, height: 8, borderRadius: 4, marginTop: 9, background: sev(lv).c, fontStyle: 'normal' }} /><span style={keyChip}>{String(f.rule)}</span>
          <div style={{ minWidth: 0 }}>{String(f.problem)}{String(f.object ?? '') !== '' ? <span style={{ fontFamily: mono, fontSize: 12.5, color: T.sub }}> · {String(f.object)}</span> : null}
            <div style={{ fontSize: 12.5, color: T.dim }}>{String(f.time ?? '') !== '' ? `${mmddhhmm(String(f.time))} · ` : ''}{String(f.evidence ?? '')}{String(f.advice ?? '') !== '' ? ` · 建议：${String(f.advice)}` : ''}</div>
            {note !== '' ? <div style={{ fontSize: 13.5, color: T.sub, marginTop: 2 }}>解读：{note}</div> : null}</div>
          <span>{lv !== 'ok' ? <DigLink prompt={[`【表结构变更规范发现深挖】${windowLine(c)} · ${String(f.rule)}（${sev(lv).cn}）· ${String(f.problem)} · 对象 ${String(f.object)} · 时间 ${String(f.time)}`, `证据：${String(f.evidence)}`, note !== '' ? `报告里的解读：${note}` : '', DIG_TAIL].filter((s) => s !== '').join('\n')} label="在会话里深挖" /> : null}</span>
        </div>); })}
      {passed.map((r, i) => (
        <div key={r} style={{ display: 'grid', gridTemplateColumns: '8px 100px minmax(0,1fr) 110px', gap: 12, alignItems: 'start', padding: '10px 0', borderTop: findings.length + i === 0 ? 'none' : `1px solid ${T.line}`, fontSize: 14 }}>
          <i style={{ width: 8, height: 8, borderRadius: 4, marginTop: 9, background: T.sev.ok.c, fontStyle: 'normal' }} /><span style={keyChip}>{r}</span><div>{r === 'DDLR90' ? '全部变更均已归因到操作者' : `无 ${RULE_LABEL[r] ?? r}`}</div><span />
        </div>))}
    </div>
  );
}
function RunStrip({ runs, selId, onSel }: { runs: any[]; selId: string; onSel: (id: string) => void }) {
  const cells = runs.slice(0, 30).reverse();
  if (cells.length === 0) return null;
  return (
    <div style={card}>
      <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 26 }}>
        {cells.map((r: any) => { const lv = String(r.collect?.det?.worst ?? r.report?.data?.det?.worst ?? (r.status === 'succeeded' ? 'ok' : 'notice')); const usable = r.report !== undefined || r.collect !== undefined; return (
          <i key={String(r.id)} title={`${String(r.firedAt).replace('T', ' ').slice(0, 16)} · ${lv}`} onClick={() => usable && onSel(String(r.id))} style={{ flex: 1, maxWidth: 16, height: '100%', borderRadius: 3, background: sev(lv).c, cursor: usable ? 'pointer' : 'default', fontStyle: 'normal', outline: r.id === selId ? `2px solid ${T.ink}` : 'none', outlineOffset: 1, opacity: usable ? 1 : 0.35 }} />); })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: T.dim, marginTop: 6 }}><span>{String(cells[0]?.firedAt ?? '').slice(5, 10)}</span><span>最新 ▲ · 点格子查看当次报告</span></div>
    </div>
  );
}
function LegacyView({ data }: { data: any }) {
  const tl: any[] = data?.timeline ?? []; const rf: any[] = data?.ruleFindings ?? [];
  return (
    <>
      <div style={{ fontSize: 13.5, color: T.sev.notice.c, background: T.sev.notice.soft, borderRadius: 8, padding: '8px 14px', marginBottom: 12 }}>这份报告由旧版生成（没有结构历史存档），只能显示模型抄录的时间轴；重新运行任务后即为演进图 + 版本比较大盘。</div>
      {rf.filter((f) => String(f.level) !== 'ok').map((f, i) => <div key={i} style={{ ...card, borderLeft: `3px solid ${sev(String(f.level)).c}`, marginBottom: 8, fontSize: 14 }}><span style={keyChip}>{String(f.rule)}</span> {String(f.problem)}</div>)}
      <div style={card}>{tl.slice(0, 40).map((e, i) => <div key={i} style={{ fontSize: 13.5, padding: '4px 0', borderTop: i === 0 ? 'none' : `1px solid ${T.line}` }}><span style={{ fontFamily: mono, color: T.sub }}>{String(e.time).replace('T', ' ').slice(0, 16)}</span> · {String(e.user || '未归因')} · {String(e.action)} {String(e.object)}</div>)}</div>
      {String(data?.rootCause ?? '') !== '' ? <div style={{ ...card, background: T.fill, border: 'none', marginTop: 12, fontSize: 15, color: T.sub }}>{String(data.rootCause)}</div> : null}
    </>
  );
}

// ───────────────────────────────────────────── 面板
export function DdlPanel({ task, runId, call }: { task: any; runId?: string; call: (endpoint: string, payload?: unknown) => Promise<any> }) {
  const [runs, setRuns] = useState<any[]>([]);
  const [selId, setSelId] = useState('');
  useEffect(() => { setSelId(typeof runId === 'string' ? runId : ''); }, [runId]);
  const [error, setError] = useState('');
  const [sel, setSel] = useState<Sel | undefined>();
  useEffect(() => {
    let alive = true;
    const load = () => { call('runs/list', { taskId: task.id }).then((v) => { if (alive) { setRuns(v?.runs ?? []); setError(''); } }).catch((e) => { if (alive) setError(String(e?.message ?? e)); }); };
    load(); const timer = setInterval(load, 30000);
    return () => { alive = false; clearInterval(timer); };
  }, [task.id]);
  const usable = runs.filter((r) => r.report !== undefined || r.collect !== undefined);
  const current = usable.find((r) => r.id === selId) ?? usable[0];
  const data = current?.report?.data; const c = current?.collect;
  const findingNotes = useMemo(() => new Map<string, string>(((data?.findings ?? []) as any[]).flatMap((f) => [[`${String(f.rule)}|${String(f.object ?? '')}`, String(f.note ?? '')], [String(f.rule), String(f.note ?? '')]])), [data]);
  if (error !== '') return <div style={{ fontSize: 16, color: T.dim, padding: 16 }}>加载失败：{error}</div>;
  if (current === undefined) return <div style={{ fontSize: 16, color: T.dim, padding: 16 }}>还没有表结构变更报告——任务触发后（cron 或在会话里说一声）报告会出现在这里。</div>;
  const worst = String(c?.det?.worst ?? data?.det?.worst ?? 'ok');
  if (c === undefined || String(c.scope) !== 'ddl-trace' || Number(c.version ?? 1) < 2) {
    return <div style={{ fontFamily: FONT, color: T.ink, lineHeight: 1.75 }}><div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}><span style={{ fontSize: 18, fontWeight: 600, color: sev(worst).c }}>变更态势：{sev(worst).cn}</span><span style={{ fontSize: 14, color: T.sub }}>{String(current.report?.summary ?? '')}</span></div>{data !== undefined ? <LegacyView data={data} /> : null}<H2 hint="一格一次运行 · 点格子查看当次报告">检查历史</H2><RunStrip runs={runs} selId={String(current.id)} onSel={setSelId} /></div>;
  }
  const versions: Version[] = c.versions ?? []; const priorities: any[] = data?.priorities ?? [];
  return (
    <div style={{ fontFamily: FONT, color: T.ink, lineHeight: 1.75 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontSize: 18, fontWeight: 600, color: sev(worst).c }}>变更态势：{sev(worst).cn}</span>
        <Chip level="ok">✓ 时间 / 操作者 / 结构差异全部来自字典直读 · 规则由脚本判定 · 模型只做解读</Chip>
        <span style={{ fontSize: 13.5, color: T.dim }}>{String(c.node)} · 采集 {mmddhhmm(String(c.collectedAt))} · 三源：平台字典快照（列/索引定义）{c.pgObjectAvailable ? ' · pg_object（建/改时间、创建者）' : ''}{c.auditAvailable ? ' · 审计 pg_query_audit（DDL 原文与执行者）' : ' · 审计不可用'}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: T.dim, marginBottom: 14, flexWrap: 'wrap' }}>
        回溯窗口 <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${T.line}`, borderRadius: 8, padding: '3px 10px', color: T.ink, background: '#fff' }}><b>{Number(c.windowHours)} 小时</b> · {mmddhhmm(String(c.since))} → {mmddhhmm(String(c.until))}</span>
        关注 <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${T.line}`, borderRadius: 8, padding: '3px 10px', color: T.ink, background: '#fff' }}>{(c.schemasFilter ?? []).length > 0 ? `schema ${(c.schemasFilter as string[]).join(', ')}` : '全部非系统 schema'}</span>
        <span>换窗口或只看某个 schema / 表，在会话里说一句</span>
      </div>
      {String(data?.situation ?? current.report?.summary ?? '') !== '' ? <div style={{ fontSize: 15, color: T.sub, marginBottom: 12 }}>{String(data?.situation ?? '') !== '' ? String(data.situation) : String(current.report?.summary ?? '')}</div> : null}
      <Stats s={c.summary ?? {}} c={c} />

      <H2 hint="主干 = 库级结构版本（每个 DDL 批次记一版）· 分支 = schema 与表的生命线（从建立分出，删除处封口）· 点节点看那次变更，点线段看该生命时段里表结构变了什么 · 点 schema 名展开/折叠表级子线">结构演进图</H2>
      <div style={card}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 340px', gap: 20 }}>
          <div style={{ minWidth: 0 }}>
            <Graph c={c} sel={sel} onSel={setSel} />
            <div style={{ display: 'flex', gap: 16, fontSize: 12.5, color: T.sub, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span><Sw color={T.ink} /> 主干版本</span><span><Sw color={T.add} /> 新建</span><span><Sw color={T.mod} /> 修改（列 / 索引 / 授权）</span><span><Sw color={T.del} /> 删除</span><span><Sw color={T.user} /> 账号 / 权限</span>
            </div>
          </div>
          <SidePanel c={c} sel={sel} data={data} />
        </div>
      </div>

      <H2 hint="GitHub compare 式：任选两个结构版本，逐对象给出列与索引的差异 · 只列有变化的对象 · 点卡片展开/折叠">版本比较</H2>
      <CompareSection c={c} />

      <H2 hint="什么时间 · 由哪个用户 · 做过什么变更 · 按日分组（新→旧）· 来源芯片可追溯">变更时间轴</H2>
      <Timeline c={c} versions={versions} />

      <H2 hint="DDLR 规则脚本判定 · 级别不可被解读下调 · 每条可直接深挖">规范扫描</H2>
      <Rules c={c} notes={findingNotes} />

      {(String(data?.rootCause ?? '') !== '' || priorities.length > 0) ? (
        <>
          <H2 hint="模型解读 · 引用的对象与时间均有出处">变更故事线与处置优先级</H2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 12 }}>
            {String(data?.rootCause ?? '') !== '' ? <div style={{ ...card, background: T.fill, border: 'none' }}><div style={{ fontSize: 13.5, color: T.dim, fontWeight: 500, marginBottom: 4 }}>变更故事线</div><div style={{ fontSize: 15, color: T.sub }}>{String(data.rootCause)}</div></div> : null}
            {priorities.length > 0 ? <div style={card}><div style={{ fontSize: 13.5, color: T.dim, fontWeight: 500, marginBottom: 4 }}>处置优先级</div><div style={{ display: 'grid', gap: 8 }}>{priorities.map((p, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: '34px minmax(0,1fr)', gap: 10, alignItems: 'start', fontSize: 15 }}><span style={{ font: `600 13px ${mono}`, background: T.fill2, borderRadius: 6, textAlign: 'center', padding: '2px 0', marginTop: 4 }}>P{String(p.p).replace(/^P/i, '')}</span><div>{String(p.action)} {(p.refs ?? []).length > 0 ? <span style={{ display: 'inline-flex', gap: 4, marginLeft: 6, verticalAlign: 'middle', flexWrap: 'wrap' }}>{(p.refs as any[]).map((r, k) => <span key={k} style={keyChip}>{String(r)}</span>)}</span> : null}</div></div>)}</div></div> : null}
          </div>
        </>
      ) : null}

      <H2 hint="一格一次运行 · 点格子查看当次报告">检查历史</H2>
      <RunStrip runs={runs} selId={String(current.id)} onSel={setSelId} />
      <div style={{ fontSize: 13.5, color: T.dim, border: `1px dashed ${T.line}`, borderRadius: 8, padding: '8px 14px', marginTop: 16 }}>
        📋 采集说明：结构版本 = 每个 DDL 批次（相邻一分钟内的变更合并）记一版；版本内容 = 平台字典快照里各对象的列/索引定义（采集前先做一次快照），快照之间的精确时刻与创建者取 pg_object；审计有 DDL 原文时补执行账号与语句。
        {[...(c.collectionNotes ?? []), ...(data?.collectionNotes ?? [])].map((n: any, i: number) => <div key={i}>{String(n)}</div>)}
      </div>
    </div>
  );
}

function registerPanel(key: string, Comp: any): void {
  if (typeof window === 'undefined') return;
  const w = window as any;
  if (w.__opendbHarness__?.registerTaskPanel !== undefined) { w.__opendbHarness__.registerTaskPanel(key, Comp); return; }
  w.__opendbHarness__ = w.__opendbHarness__ ?? {};
  w.__opendbHarness__.__pending = [...(w.__opendbHarness__.__pending ?? []), { kind: 'task', key, comp: Comp }];
}
export function apply(ctx: any): void {
  clientCtx = ctx;
  registerPanel('ddl', DdlPanel);
}
