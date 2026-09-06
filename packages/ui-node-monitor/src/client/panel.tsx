/**
 * 数据库大盘页（每个节点的专属页）——取数 + 布局。设计稿 docs/prototypes/node-r1.html（user 2026-09-06 批准）：
 * 页头（身份 + 综合结论）→ 现在（8 项数据库 KPI）→ 主机（OS 层 4 项）→ DB Time 构成 / 主机明细 → 五类巡检最近结论
 * → 存储与增长 / 变更时间轴 → 本节点定时任务 → 关于这个库平台记住了什么。零按钮，只有深挖 / 看报告文字链。
 */
import { useEffect, useState } from 'react';
import { SEV, type Level } from '@opendb-dsh/chart-kit';
import { T, H2, Chip, KpiGrid, DbTimeCard, HostCard, VerdictCard, StorageCard, TimelineCard, TasksTable, KnowledgeStrip, DigLink, levelCn } from './sections.tsx';

type Call = (endpoint: string, payload?: unknown) => Promise<any>;
const REFRESH_MS = 60_000;

function ago(iso: string | null): string {
  if (iso === null) return '—';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 90 ? `${s} 秒前` : s < 5400 ? `${Math.round(s / 60)} 分钟前` : `${Math.round(s / 3600)} 小时前`;
}
function days(iso: string | null): string { return iso === null ? '—' : `${Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000))} 天`; }

export function NodeDashboardPage({ nodeId, call }: { nodeId: string; call: Call }) {
  const [hours, setHours] = useState<24 | 168>(24);
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try { const v = await call('nodes/dashboard', { nodeId, hours }); if (alive) { setD(v); setErr(''); } } catch (e) { if (alive) setErr(String((e as Error).message ?? e)); }
    };
    setD(null); void refresh();
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => { alive = false; clearInterval(t); };
  }, [nodeId, hours]);
  if (err !== '') return <div style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 14 }}>大盘取数失败：{err}</div>;
  if (d === null) return <div style={{ color: T.dim, fontSize: 14 }}>加载中…</div>;
  const { node, kpis, os, dbTime, verdicts, composite, storage, timeline, tasks, knowledge, range } = d;
  const cl = composite.level as Level;
  const name = String(node.name);
  return (
    <div style={{ fontSize: 16, lineHeight: 1.75, maxWidth: 1240 }}>
      {/* 页头 + 综合结论 */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 24, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ width: 10, height: 10, borderRadius: '50%', background: node.status === 'online' ? SEV.ok : SEV.critical, flex: 'none' }} />{name}<span style={{ fontSize: 14, fontWeight: 400, color: T.dim }}>{node.engine}</span></div>
          <div style={{ fontSize: 13.5, color: T.dim, marginTop: 2 }}><b style={{ color: T.sub, fontWeight: 500 }}>{node.host}:{node.port}</b>/{node.dbname} · {node.status} · 采集 <b style={{ color: T.sub, fontWeight: 500 }}>{ago(node.lastSampleAt)}</b>{node.agentName ? <> · 绑定智能体 <b style={{ color: T.sub, fontWeight: 500 }}>{node.agentName}</b></> : null} · 已监控 <b style={{ color: T.sub, fontWeight: 500 }}>{days(node.firstSeenAt)}</b></div>
        </div>
        <div style={{ marginLeft: 'auto', border: `1px solid ${T.border2}`, borderRadius: 12, padding: '10px 16px', display: 'flex', gap: 16, alignItems: 'center', background: '#fff', boxShadow: '0 4px 12px rgba(0,0,0,.02),0 2px 8px rgba(0,0,0,.04)', maxWidth: 620 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: SEV[cl], display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}><i style={{ width: 12, height: 12, borderRadius: 3, background: SEV[cl] }} />{levelCn(cl)}</div>
          <div style={{ fontSize: 13.5, color: T.sub, lineHeight: 1.5 }}>{composite.why}</div>
        </div>
      </div>

      <H2 m={`采集间隔 1 分钟 · 迷你曲线为 ${range.hours >= 168 ? '7 天' : '24 小时'} · 左侧色条 = 阈值档位`} right={
        <span style={{ fontSize: 13.5, color: T.dim, display: 'flex', gap: 14 }}>
          {([24, 168] as const).map((h) => <span key={h} onClick={() => setHours(h)} style={{ cursor: 'pointer', paddingBottom: 2, color: hours === h ? T.ink : T.dim, borderBottom: hours === h ? `2px solid ${T.blue}` : '2px solid transparent' }}>{h === 24 ? '24 小时' : '7 天'}</span>)}
        </span>
      }>现在</H2>
      <KpiGrid items={kpis} node={name} />

      <H2 m="数据库视角的 db.os.* 计数器差分 · 同样迷你曲线">主机（OS 层）</H2>
      <KpiGrid items={os} node={name} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 14, marginTop: 14 }}>
        <DbTimeCard dbTime={dbTime} node={name} />
        <HostCard os={os} node={name} />
      </div>

      <H2 m="数字来自采集存档，叙述来自模型报告；过期结论灰显、不进综合">五类巡检最近结论</H2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 }}>
        {verdicts.map((v: any) => <VerdictCard key={v.type} v={v} node={name} />)}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 14, marginTop: 14 }}>
        <StorageCard storage={storage} node={name} />
        <TimelineCard batches={timeline} node={name} />
      </div>

      <H2 m="来自任务表 · 逾期 = 按 cron 应触发而未触发">本节点的定时任务</H2>
      <TasksTable tasks={tasks} />

      <H2 m="记忆 = 平台自身经历；知识 = 导入的规范 / 案例" right={<DigLink label={`问问 ${name} 最近有什么异常`} prompt={`【数据库大盘深挖】节点 ${name} · 综合\n综合结论：${levelCn(cl)}（${composite.why}）\n任务：把五类巡检的最新结论串起来，判断当前最值得先处理的一件事，给只读处置建议。不要反问。`} />}>关于这个库，平台记住了什么</H2>
      <KnowledgeStrip k={knowledge} node={name} />
      <div style={{ fontSize: 12.5, color: T.dim, marginTop: 18 }}>{verdicts.some((v: any) => v.stale) && <Chip stale>灰显 = 过期结论</Chip>}</div>
    </div>
  );
}
