/**
 * 数据库大盘的展示件（纯展示，不取数）：KPI 卡、判决卡、DB Time、主机明细、存储、时间轴、任务表、知识条。
 * 视觉：dsh 原版 token（主蓝 / 灰阶 chrome / 语义色只上数据）+ 内容区字号体系（16 正文 · 18–24 区块题 · 13.5 meta）。
 */
import { useState } from 'react';
import { Sparkline, StackedBar, SEV, fmtValue, type Level, type Unit } from '@opendb-dsh/chart-kit';
import { digInSession, openSession, openTask } from './dig.ts';

export const T = {
  ink: 'var(--dsw-alias-label-primary)', sub: 'var(--dsw-alias-label-secondary)', dim: 'var(--dsw-alias-label-tertiary)',
  border: 'var(--dsw-alias-border-l1)', border2: 'var(--dsw-alias-border-l2)', fill: 'var(--dsw-alias-fill-l1, #F7F8FA)', fill2: '#F2F3F5',
  blue: '#4176E6', stale: '#9AA0A8',
};
const SOFT: Record<Level, string> = { ok: '#E8F5EC', notice: '#FAF3E5', warn: '#FDF0E3', critical: '#FDECEC' };
const CN: Record<Level, string> = { ok: '正常', notice: '注意', warn: '告警', critical: '严重' };
const card: React.CSSProperties = { border: `1px solid ${T.border2}`, borderRadius: 12, boxShadow: '0 4px 12px rgba(0,0,0,.02),0 2px 8px rgba(0,0,0,.04)', background: '#fff', padding: '16px 20px', minWidth: 0 };
const meta: React.CSSProperties = { fontSize: 13.5, color: T.dim };

export function levelColor(l: Level | null, stale = false): string { return stale ? T.stale : SEV[l ?? 'ok']; }
export function levelCn(l: Level | null): string { return l === null ? '—' : CN[l]; }
export function Chip({ level, stale, children }: { level?: Level; stale?: boolean; children: any }) {
  const bg = stale ? T.fill2 : level !== undefined ? SOFT[level] : T.fill2;
  const fg = stale ? T.stale : level !== undefined ? SEV[level] : T.sub;
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, borderRadius: 6, padding: '1px 9px', fontWeight: 500, whiteSpace: 'nowrap', background: bg, color: fg, lineHeight: 1.7 }}>{children}</span>;
}
export function H2({ children, m, right }: { children: any; m?: string; right?: any }) {
  return <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, margin: '28px 0 12px' }}><span style={{ fontSize: 18, fontWeight: 600 }}>{children}</span>{m !== undefined && <span style={meta}>{m}</span>}<span style={{ marginLeft: 'auto' }}>{right}</span></div>;
}

// ── 深挖链（三态） ──
export function Link({ onClick, children, busy, fail }: { onClick: () => void; children: any; busy?: boolean; fail?: boolean }) {
  return <button type="button" onClick={onClick} disabled={busy} style={{ font: 'inherit', fontSize: 12.5, color: fail ? SEV.critical : T.blue, background: 'none', border: 'none', padding: 0, cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}>{children}</button>;
}
export function DigLink({ prompt, label = '在会话里深挖' }: { prompt: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'fail'>('idle');
  return <Link busy={state === 'busy'} fail={state === 'fail'} onClick={() => { setState('busy'); digInSession(prompt).then(() => setState('idle')).catch(() => setState('fail')); }}>{state === 'busy' ? '开会话中…' : state === 'fail' ? '失败，重试' : `${label} →`}</Link>;
}
/** 看报告：有任务页就开任务页；没有就打开产出这份结论的会话。 */
export function ReportLink({ taskId, sessionId }: { taskId?: string; sessionId?: string }) {
  if (taskId !== undefined) return <Link onClick={() => { if (!openTask(taskId) && sessionId !== undefined) openSession(sessionId); }}>查看报告 →</Link>;
  if (sessionId !== undefined) return <Link onClick={() => openSession(sessionId)}>看会话 →</Link>;
  return null;
}

// ── KPI 卡 ──
const fmtKpi = (v: number | null, unit: Unit): string => {
  if (v === null) return '—';
  if (unit === 'per_s') return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  if (unit === 'ratio') return (v * 100).toFixed(v * 100 >= 10 ? 1 : 2);
  if (unit === 'x') return v.toFixed(2);
  if (unit === 'ms') return v >= 100 ? v.toFixed(0) : v.toFixed(1);
  return fmtValue(v, unit);
};
const unitLabel: Partial<Record<Unit, string>> = { count: '', ratio: '%', per_s: '/s', ms: 'ms', bytes: '', x: '×' };
const KPI_COLORS: Record<string, string> = { waiting_locks: '#C9862D', conn_used: '#3FA552', stmt_ms: '#8E6BD6', cache_hit: '#C9862D', phys_reads: '#2AA6B3', cpu_busy: '#4176E6', load_per_core: '#3FA552', mem_process: '#8E6BD6', io_wait: '#C9862D' };
export function KpiGrid({ items, node }: { items: any[]; node: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 12 }}>
      {items.map((k) => {
        const lvl: Level = k.level ?? 'ok';
        const color = KPI_COLORS[k.key] ?? T.blue;
        return (
          <div key={k.key} style={{ background: T.fill, borderRadius: 12, padding: '14px 16px 10px', minWidth: 0, borderLeft: `3px solid ${lvl !== 'ok' ? SEV[lvl] : 'transparent'}` }}>
            <div style={{ fontSize: 13, color: T.dim, display: 'flex', alignItems: 'center', gap: 8 }}>{k.label}{lvl !== 'ok' && <Chip level={lvl}>{CN[lvl]}</Chip>}{!k.available && <Chip>待补采集</Chip>}</div>
            <div style={{ fontSize: 26, fontWeight: 600, lineHeight: 1.25, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{k.available ? fmtKpi(k.value, k.unit) : '—'}<span style={{ fontSize: 13, fontWeight: 500, color: T.dim, marginLeft: 5 }}>{k.available ? (unitLabel[k.unit as Unit] ?? '') : ''}</span></div>
            <div style={{ marginTop: 6, overflow: 'hidden' }}>{k.series.length >= 2 ? <Sparkline points={k.series} width={260} height={44} color={k.available ? color : T.stale} unit={k.unit} /> : <div style={{ height: 44, borderBottom: `1px dashed ${T.border}` }} />}</div>
            <div style={{ fontSize: 12.5, color: T.dim, lineHeight: 1.5, marginTop: 4, display: 'flex', gap: 10, alignItems: 'baseline' }}>
              <span style={{ flex: 1, minWidth: 0 }}>{k.note}</span>
              {lvl !== 'ok' && k.available && <DigLink label="深挖" prompt={`【数据库大盘深挖】节点 ${node} · 指标「${k.label}」当前 ${fmtKpi(k.value, k.unit)}${(unitLabel[k.unit as Unit] ?? '')}（${CN[lvl]}）\n${k.note}\n任务：取最近 24 小时该指标与相关指标取证，给出判断、影响面与只读处置建议。不要反问。`} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── DB Time 构成 + 主机明细 ──
export function DbTimeCard({ dbTime, node }: { dbTime: any; node: string }) {
  const parts = (dbTime.parts as { name: string; share: number }[]).filter((p) => !p.name.startsWith('（'));
  const cpu = (dbTime.parts as { name: string; share: number }[]).find((p) => p.name.startsWith('（'));
  const items = parts.map((p) => ({ name: p.name, value: Math.round(p.share * 1000) / 10 }));
  return (
    <div style={card}>
      <div style={{ fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'baseline', gap: 10 }}>DB Time 构成 <span style={meta}>近 {dbTime.windowMin} 分钟 · instance_time 差分</span><span style={{ marginLeft: 'auto' }}><DigLink prompt={`【数据库大盘深挖】节点 ${node} · DB Time 构成\n${items.map((i) => `${i.name} ${i.value}%`).join('，')}${cpu ? `；其中 CPU 占 ${(cpu.share * 100).toFixed(0)}%` : ''}\n等待类型：${(dbTime.waits as any[]).map((w) => `${w.name} ${(w.share * 100).toFixed(0)}%`).join('，')}\n任务：判断负载是算力型还是等待型，找出占比最大的环节对应的 Top SQL / 等待事件，给只读建议。不要反问。`} /></span></div>
      <div style={{ marginTop: 12 }}>{items.length > 0 ? <StackedBar items={items} unit="count" height={22} /> : <span style={meta}>近 1 小时没有 instance_time 采样</span>}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: 13, color: T.sub, marginTop: 8 }}>{items.map((i) => <span key={i.name}>{i.name} <b style={{ color: T.ink, fontWeight: 600 }}>{i.value}%</b></span>)}{cpu && <span>其中 CPU <b style={{ color: T.ink, fontWeight: 600 }}>{(cpu.share * 100).toFixed(1)}%</b></span>}</div>
      <div style={{ marginTop: 14, fontSize: 14 }}>{(dbTime.waits as any[]).slice(0, 4).map((w, i) => (
        <div key={w.name} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 90px', gap: 12, alignItems: 'center', padding: '5px 0', borderBottom: `1px solid ${T.border}` }}><span style={{ color: T.sub }}>{i === 0 ? '等待类型' : ''}</span><div style={{ height: 8, borderRadius: 4, background: T.fill2, overflow: 'hidden' }}><i style={{ display: 'block', height: '100%', width: `${(w.share * 100).toFixed(1)}%`, background: ['#2AA6B3', '#8E6BD6', '#C9862D', '#7F8790'][i % 4] }} /></div><span style={{ textAlign: 'right', color: T.sub, fontSize: 13.5, fontVariantNumeric: 'tabular-nums' }}>{w.name} {(w.share * 100).toFixed(0)}%</span></div>
      ))}{(dbTime.waits as any[]).length === 0 && <span style={meta}>近 1 小时没有等待事件增量</span>}</div>
    </div>
  );
}
export function HostCard({ os, node }: { os: any[]; node: string }) {
  const by = (k: string) => os.find((x) => x.key === k);
  const cpu = by('cpu_busy'); const load = by('load_per_core'); const mem = by('mem_process'); const io = by('io_wait');
  const row = (label: string, share: number | null, text: string, color: string) => (
    <div key={label} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 120px', gap: 12, alignItems: 'center', padding: '5px 0', borderBottom: `1px solid ${T.border}`, fontSize: 14 }}><span style={{ color: T.sub }}>{label}</span><div style={{ height: 8, borderRadius: 4, background: T.fill2, overflow: 'hidden' }}><i style={{ display: 'block', height: '100%', width: `${Math.min(100, Math.max(0, (share ?? 0) * 100)).toFixed(1)}%`, background: color }} /></div><span style={{ textAlign: 'right', color: T.sub, fontSize: 13.5, fontVariantNumeric: 'tabular-nums' }}>{text}</span></div>
  );
  return (
    <div style={card}>
      <div style={{ fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'baseline', gap: 10 }}>主机资源明细 <span style={meta}>db.os.* 差分</span><span style={{ marginLeft: 'auto' }}><DigLink prompt={`【数据库大盘深挖】节点 ${node} · 主机资源\n${os.map((k) => `${k.label}：${k.available ? fmtKpi(k.value, k.unit) + (unitLabel[k.unit as Unit] ?? '') : '未采集'}（${k.note}）`).join('\n')}\n任务：判断主机是否成为瓶颈（CPU / 负载 / IO / 内存），关联到数据库侧的 DB Time 与等待，给只读建议。不要反问。`} /></span></div>
      <div style={{ marginTop: 12 }}>
        {row('CPU 忙', cpu?.value ?? null, cpu?.available ? `${fmtKpi(cpu.value, 'ratio')}%` : '未采集', '#4176E6')}
        {row('每核负载', load?.value !== null && load?.value !== undefined ? Math.min(1, load.value / 2) : null, load?.available ? `${fmtKpi(load.value, 'x')}×` : '未采集', '#3FA552')}
        {row('数据库进程内存', mem?.value ?? null, mem?.available ? `${fmtKpi(mem.value, 'ratio')}%` : '待补采集', '#8E6BD6')}
        {row('IO 等待占比', io?.value ?? null, io?.available ? `${fmtKpi(io.value, 'ratio')}%` : '未采集', '#C9862D')}
      </div>
      <div style={{ ...meta, marginTop: 10, lineHeight: 1.6 }}>{mem?.note}{mem?.available ? '' : '；磁盘吞吐 / 网络流量 openGauss 视图不提供，不做假数。'}</div>
    </div>
  );
}

// ── 五类判决卡 ──
const fmtAt = (iso: string | null): string => (iso === null ? '' : iso.replace('T', ' ').slice(5, 16));
export function VerdictCard({ v, node }: { v: any; node: string }) {
  const c = levelColor(v.level, v.stale);
  const digText = `【数据库大盘深挖】节点 ${node} · ${v.title}最近结论（${fmtAt(v.at)}）：${levelCn(v.level)}${v.stale ? `（${v.staleReason}）` : ''}\n${v.headline}\n关键数：${v.facts.map((f: any) => `${f.label} ${f.value}`).join('，')}\n任务：重新采集一次该维度最新数据，对照上次结论判断是否仍成立/是否恶化，给只读处置建议。不要反问。`;
  return (
    <div style={{ ...card, padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px 8px', borderTop: `4px solid ${c}` }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: T.sub }}>{v.title}</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: c, lineHeight: 1.2, marginTop: 2, display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', whiteSpace: 'nowrap' }}>
          {levelCn(v.level)}{v.stale && <Chip stale>{v.staleReason}</Chip>}<span style={{ fontSize: 12.5, color: T.dim, fontWeight: 400 }}>{fmtAt(v.at)}</span>
        </div>
      </div>
      <div style={{ padding: '2px 16px 12px', fontSize: 13.5, color: T.sub, lineHeight: 1.55, flex: 1 }}>
        {v.headline}
        {v.facts.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 8, fontSize: 12.5, color: T.dim }}>{v.facts.map((f: any) => <span key={f.label}>{f.label} <b style={{ color: T.ink, fontWeight: 600, fontSize: 14 }}>{f.value}</b></span>)}</div>}
      </div>
      <div style={{ padding: '9px 16px', borderTop: `1px solid ${T.border}`, display: 'flex', gap: 10, alignItems: 'center', fontSize: 12.5, color: T.dim }}>
        <Chip>{v.schedule.mode === 'cron' ? `cron ${v.schedule.cron}` : '手动'}</Chip>
        {v.schedule.overdueDays !== undefined && <Chip level="warn">逾期 {v.schedule.overdueDays} 天</Chip>}
        {v.schedule.mode === 'cron' && v.schedule.overdueDays === undefined && <Chip level="ok">按时</Chip>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 12 }}>{v.level !== null && <DigLink label="深挖" prompt={digText} />}<ReportLink taskId={v.taskId} sessionId={v.sessionId} /></span>
      </div>
    </div>
  );
}

// ── 存储与增长 ──
function GrowthChart({ points }: { points: [number, number][] }) {
  if (points.length < 2) return <div style={{ ...meta, height: 60, display: 'flex', alignItems: 'center' }}>容量采样不足两天，先看库大小</div>;
  const W = 560; const H = 150; const L = 48; const R = 12; const Tp = 10; const B = 26;
  const gb = points.map(([t, b]) => [t, b / 2 ** 30] as [number, number]);
  const max = Math.max(...gb.map((p) => p[1]), 1); const min = Math.min(...gb.map((p) => p[1]), max);
  const useLog = max / Math.max(min, 0.01) > 20;
  const yv = (v: number) => (useLog ? Math.log10(v + 1) / Math.log10(max + 1) : v / max);
  const ys = (v: number) => Tp + (1 - yv(v)) * (H - Tp - B);
  const xs = (i: number) => L + (i / (gb.length - 1)) * (W - L - R);
  const ticks = useLog ? [1, 10, 100, 1000].filter((g) => g < max * 1.5) : [max / 2, max];
  const pts = gb.map((p, i) => `${xs(i).toFixed(1)},${ys(p[1]).toFixed(1)}`).join(' ');
  const lastV = gb[gb.length - 1][1];
  const fmtD = (t: number) => new Date(t).toISOString().slice(5, 10);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 150, display: 'block', marginTop: 10 }}>
      <line x1={L} y1={H - B} x2={W - R} y2={H - B} stroke="rgba(0,0,0,.12)" />
      {ticks.map((g) => <g key={g}><line x1={L} y1={ys(g)} x2={W - R} y2={ys(g)} stroke="rgba(0,0,0,.06)" strokeDasharray="3 4" /><text x={L - 6} y={ys(g) + 4} fontSize="11" fill="#81858C" textAnchor="end">{g >= 10 ? g.toFixed(0) : g.toFixed(1)}</text></g>)}
      <polygon points={`${xs(0)},${H - B} ${pts} ${xs(gb.length - 1)},${H - B}`} fill="rgba(65,118,230,.08)" />
      <polyline points={pts} fill="none" stroke="#4176E6" strokeWidth="2" strokeLinejoin="round" />
      {gb.map((p, i) => (i % Math.ceil(gb.length / 6) === 0 || i === gb.length - 1) && <text key={p[0]} x={xs(i)} y={H - 8} fontSize="11" fill="#81858C" textAnchor="middle">{fmtD(p[0])}</text>)}
      <circle cx={xs(gb.length - 1)} cy={ys(lastV)} r="3.5" fill="#4176E6" />
      <text x={xs(gb.length - 1) - 6} y={ys(lastV) - 8} fontSize="12" fontWeight="600" fill="#0F1115" textAnchor="end">{lastV.toFixed(1)} GB</text>
      {useLog && <text x={L - 6} y={Tp + 6} fontSize="10.5" fill="#ADB2B8" textAnchor="end">对数轴</text>}
    </svg>
  );
}
export function StorageCard({ storage, node }: { storage: any; node: string }) {
  const total = storage.dbs.reduce((s: number, d: any) => s + d.bytes, 0) || 1;
  const bpd = storage.bytesPerDay as number | null;
  return (
    <div style={card}>
      <div style={{ fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'baseline', gap: 10 }}>存储与增长 <span style={meta}>容量采样 · 按天</span><span style={{ marginLeft: 'auto' }}><DigLink prompt={`【数据库大盘深挖】节点 ${node} · 存储与增长\n各库：${storage.dbs.map((d: any) => `${d.name} ${fmtValue(d.bytes, 'bytes')}`).join('，')}${bpd !== null ? `；增速 ${(bpd / 2 ** 30).toFixed(2)} GB/天` : ''}${storage.growthNote ? `（${storage.growthNote}）` : ''}\n任务：判断空间走势与主要占用（表/表空间/非表占用），是否有到阈值风险，给只读建议。不要反问。`} /></span></div>
      <GrowthChart points={storage.growth} />
      <div style={{ ...meta, marginTop: 6 }}>{bpd !== null ? `增速 ${(bpd / 2 ** 30).toFixed(2)} GB/天` : '增速待容量任务采样'}{storage.growthNote ? ` · ${storage.growthNote}` : ''}</div>
      <div style={{ marginTop: 12, fontSize: 14 }}>
        {storage.dbs.map((d: any, i: number) => (
          <div key={d.name} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 90px', gap: 12, alignItems: 'center', padding: '5px 0', borderBottom: `1px solid ${T.border}` }}><span>{d.name}</span><div style={{ height: 8, borderRadius: 4, background: T.fill2, overflow: 'hidden' }}><i style={{ display: 'block', height: '100%', width: `${Math.max(1, (d.bytes / total) * 100).toFixed(1)}%`, background: ['#4176E6', '#3FA552', '#C9862D', '#8E6BD6'][i % 4] }} /></div><span style={{ textAlign: 'right', color: T.sub, fontSize: 13.5, fontVariantNumeric: 'tabular-nums' }}>{fmtValue(d.bytes, 'bytes')}</span></div>
        ))}
        {storage.nonTableBytes !== null && <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 90px', gap: 12, alignItems: 'center', padding: '5px 0' }}><span style={{ color: T.dim }}>非表占用</span><div style={{ height: 8, borderRadius: 4, background: T.fill2, overflow: 'hidden' }}><i style={{ display: 'block', height: '100%', width: `${Math.max(1, (storage.nonTableBytes / total) * 100).toFixed(1)}%`, background: '#7F8790' }} /></div><span style={{ textAlign: 'right', color: T.sub, fontSize: 13.5 }}>{fmtValue(storage.nonTableBytes, 'bytes')}</span></div>}
      </div>
    </div>
  );
}

// ── 变更时间轴 ──
export function TimelineCard({ batches, node }: { batches: any[]; node: string }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'baseline', gap: 10 }}>变更时间轴 <span style={meta}>字典变更按批次聚合 · 近 14 天</span><span style={{ marginLeft: 'auto' }}><DigLink prompt={`【数据库大盘深挖】节点 ${node} · 结构变更\n${batches.slice(0, 6).map((b) => `${b.at} ${b.schema}：+${b.added} −${b.removed} ~${b.modified}（${b.kinds.join('/')}）`).join('\n')}\n任务：用 ddl_collect 复核这些批次，判断是否计划内、有无破坏性/高峰期变更，给只读建议。不要反问。`} /></span></div>
      <div style={{ marginTop: 8 }}>
        {batches.length === 0 && <span style={meta}>近 14 天没有结构变更</span>}
        {batches.map((b, i) => (
          <div key={`${b.at}-${b.schema}`} style={{ display: 'grid', gridTemplateColumns: '110px 12px 1fr', gap: 12, padding: '8px 0' }}>
            <div style={{ fontSize: 13, color: T.dim, fontVariantNumeric: 'tabular-nums' }}>{b.at.slice(5)}</div>
            <div style={{ position: 'relative' }}>{i < batches.length - 1 && <i style={{ position: 'absolute', left: 5, top: 8, width: 2, bottom: -16, background: T.border }} />}<i style={{ position: 'absolute', left: 1, top: 6, width: 10, height: 10, borderRadius: '50%', background: SEV[b.level as Level] === SEV.ok ? T.blue : SEV[b.level as Level] }} /></div>
            <div style={{ fontSize: 14 }}>
              <b style={{ fontWeight: 600 }}>{[b.added > 0 ? `+${b.added}` : '', b.removed > 0 ? `−${b.removed}` : '', b.modified > 0 ? `~${b.modified}` : ''].filter(Boolean).join(' ')} 对象</b> · {b.schema || '（无 schema）'}
              <span style={{ fontSize: 13, color: T.dim, display: 'block' }}>{b.kinds.join(' / ')} · {b.names.slice(0, 4).join('、')}{b.names.length > 4 ? ' …' : ''}{b.level === 'critical' ? ' · schema 级删除' : b.level === 'warn' ? ' · 含删除' : ''}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 定时任务表 ──
const th: React.CSSProperties = { textAlign: 'left', fontWeight: 500, color: T.dim, fontSize: 13, padding: '8px 10px', borderBottom: `1px solid ${T.border}` };
const td: React.CSSProperties = { padding: '9px 10px', borderBottom: `1px solid ${T.border}`, verticalAlign: 'top', fontSize: 14 };
export function TasksTable({ tasks }: { tasks: any[] }) {
  const lv = (s: string | null): Level | null => (s === 'ok' || s === 'notice' || s === 'warn' || s === 'critical' ? s : null);
  return (
    <div style={{ ...card, paddingTop: 8 }}>
      {tasks.length === 0 ? <div style={{ ...meta, padding: '10px 0' }}>还没有绑定本节点的任务 · 在会话里说一句就能建，例如「每天早上八点体检 og5」</div> : (
        <table className="odbTable" style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
          <thead><tr><th style={th}>任务</th><th style={th}>类型</th><th style={th}>计划</th><th style={th}>最近一次</th><th style={th}>结论</th><th style={th}>状态</th></tr></thead>
          <tbody>{tasks.map((t) => (
            <tr key={t.id} style={{ color: t.enabled ? undefined : T.dim, cursor: 'pointer' }} onClick={() => openTask(t.id)}>
              <td style={td}>{t.name}{t.lastSummary && <div style={{ fontSize: 12.5, color: T.dim }}>{t.lastSummary}</div>}</td>
              <td style={td}>{t.type}</td>
              <td style={{ ...td, fontFamily: '"JetBrains Mono","SF Mono",Menlo,monospace', fontSize: 13 }}>{t.cron || <span style={{ color: T.dim }}>手动</span>}</td>
              <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{t.lastFiredAt ? fmtAt(t.lastFiredAt) : '—'}</td>
              <td style={td}>{lv(t.lastLevel) !== null ? <Chip level={lv(t.lastLevel) as Level}>{CN[lv(t.lastLevel) as Level]}</Chip> : <span style={{ color: T.dim }}>—</span>}</td>
              <td style={td}>{!t.enabled ? <Chip>已停用</Chip> : t.overdueDays !== null ? <Chip level="warn">逾期 {t.overdueDays} 天</Chip> : t.cron ? <Chip level="ok">按时</Chip> : <Chip>手动</Chip>}</td>
            </tr>))}</tbody>
        </table>
      )}
    </div>
  );
}

// ── 知识条 ──
export function KnowledgeStrip({ k, node }: { k: any; node: string }) {
  const box = (v: number, d: string, link: any) => <div style={{ background: T.fill, borderRadius: 10, padding: '12px 14px', fontSize: 14 }}><div style={{ fontSize: 22, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{v}</div><div style={{ fontSize: 12.5, color: T.dim }}>{d}</div>{link}</div>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
      {box(k.memories, `条记忆提及 ${node}（任务报告沉淀为主）`, <DigLink label={`问问「${node} 最近有什么反复出现的问题」`} prompt={`用 memory_search 与 memory_graph 回顾节点 ${node} 最近两周的记忆，总结反复出现的问题、已给过的建议与未闭环项。不要反问。`} />)}
      {box(k.docs, '份知识文档（规范 / 手册 / 案例）', <DigLink label={`用 knowledge_search 找与 ${node} 相关的规范`} prompt={`用 knowledge_search 检索与节点 ${node}（${''}）相关的运维规范、手册与案例，列出每条的适用范围与要点。不要反问。`} />)}
      {box(k.kgEdges, '条确定性关系涉及本节点', <DigLink label="看图谱里的关系链" prompt={`用 kg_query 查与节点 ${node} 相关的实体（节点名、其上的库/表/作业），列出确定性关系链及来源。不要反问。`} />)}
    </div>
  );
}
