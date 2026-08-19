/**
 * opendb-harness 主区页面壳（shell.overlay）：view != 'chat' 时全屏覆盖，
 * 批次1 = 任务页（列表/运行历史/审批箱）、数据库页（节点卡片）、资源页（占位+概况）。
 * 批次2/3 再图表化与实时拓扑。
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getState, setState, subscribe } from './state.ts';

export function makeOverlay(ctx: any, call: (endpoint: string, payload?: unknown) => Promise<any>) {
  const S: Record<string, React.CSSProperties> = {
    shade: { position: 'fixed', inset: 0, background: 'var(--dsw-alias-bg-layer-0, #111)', zIndex: 60, display: 'flex', flexDirection: 'column', color: 'var(--dsw-alias-label-primary)' },
    head: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
    title: { fontSize: 16, fontWeight: 600 },
    body: { flex: 1, overflow: 'auto', padding: 20 },
    btn: { background: 'var(--dsw-alias-interactive-bg-hover)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, color: 'var(--dsw-alias-label-primary)', padding: '4px 10px', fontSize: 13, cursor: 'pointer' },
    table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 },
    th: { textAlign: 'left' as const, padding: '6px 8px', color: 'var(--dsw-alias-label-tertiary)', borderBottom: '1px solid var(--dsw-alias-border-l2)', fontWeight: 500 },
    td: { padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)', verticalAlign: 'top' as const },
    dim: { color: 'var(--dsw-alias-label-tertiary)' },
    card: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, padding: 14, minWidth: 220 },
    cards: { display: 'flex', gap: 12, flexWrap: 'wrap' as const },
    h2: { fontSize: 14, fontWeight: 600, margin: '18px 0 8px' },
    input: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, color: 'var(--dsw-alias-label-primary)', padding: '4px 8px', fontSize: 13 },
  };
  const sevColor = (s?: string) => s === 'critical' ? 'var(--dsw-alias-state-error-primary)' : s === 'warn' ? '#c9862d' : 'var(--dsw-alias-label-secondary)';

  function TasksPage() {
    const [tasks, setTasks] = useState<any[]>([]);
    const [approvals, setApprovals] = useState<any[]>([]);
    const [runsFor, setRunsFor] = useState<{ id: string; runs: any[] } | null>(null);
    const [comment, setComment] = useState<Record<string, string>>({});
    const refresh = async () => {
      try {
        setTasks((await call('tasks/list', {})).tasks);
        setApprovals((await call('approvals/list', { status: 'pending' })).approvals);
      } catch { /* retry next poll */ }
    };
    useEffect(() => { void refresh(); const t = setInterval(() => void refresh(), 20_000); return () => clearInterval(t); }, []);
    return (
      <div>
        <div style={S.h2}>任务</div>
        <table style={S.table}>
          <thead><tr><th style={S.th}>名称</th><th style={S.th}>类型</th><th style={S.th}>cron</th><th style={S.th}>状态</th><th style={S.th}>最近运行</th><th style={S.th}></th></tr></thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td style={S.td}>{t.name}</td>
                <td style={S.td}><span style={S.dim}>{t.type}</span></td>
                <td style={S.td}>{t.cron ?? <span style={S.dim}>手动</span>}</td>
                <td style={S.td}>{t.enabled ? '启用' : <span style={S.dim}>停用</span>}</td>
                <td style={S.td}>
                  {t.lastRun === undefined ? <span style={S.dim}>-</span> : (
                    <span>{t.lastRun.status}{t.lastReport !== undefined && <span style={{ color: sevColor(t.lastReport.severity) }}> · {t.lastReport.severity} · {t.lastReport.summary}</span>}</span>
                  )}
                </td>
                <td style={S.td}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button style={S.btn} onClick={() => void call('tasks/runNow', { id: t.id }).then(refresh)}>立即运行</button>
                    <button style={S.btn} onClick={() => void call('runs/list', { taskId: t.id }).then((r) => setRunsFor({ id: t.id, runs: r.runs }))}>历史</button>
                    <button style={S.btn} onClick={() => void call('tasks/update', { id: t.id, patch: { enabled: !t.enabled } }).then(refresh)}>{t.enabled ? '停用' : '启用'}</button>
                  </div>
                </td>
              </tr>
            ))}
            {tasks.length === 0 && <tr><td style={S.td} colSpan={6}><span style={S.dim}>还没有任务——在会话里让 opendb-harness 帮你建，或去 设置→OpenDB</span></td></tr>}
          </tbody>
        </table>

        {runsFor !== null && (
          <div>
            <div style={S.h2}>运行历史 <button style={S.btn} onClick={() => setRunsFor(null)}>收起</button></div>
            <table style={S.table}>
              <thead><tr><th style={S.th}>时间</th><th style={S.th}>触发</th><th style={S.th}>状态</th><th style={S.th}>报告</th></tr></thead>
              <tbody>
                {runsFor.runs.map((r) => (
                  <tr key={r.id}>
                    <td style={S.td}>{String(r.firedAt).replace('T', ' ').slice(0, 19)}</td>
                    <td style={S.td}><span style={S.dim}>{r.triggerKind}</span></td>
                    <td style={S.td}>{r.status}{r.error ? <span style={{ color: sevColor('critical') }}> {r.error}</span> : null}</td>
                    <td style={S.td}>{r.report !== undefined ? <span style={{ color: sevColor(r.report.severity) }}>{r.report.severity} · {r.report.summary}</span> : <span style={S.dim}>-</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={S.h2}>审批箱（待签收 {approvals.length}）</div>
        <table style={S.table}>
          <thead><tr><th style={S.th}>事项</th><th style={S.th}>摘要</th><th style={S.th}>意见</th><th style={S.th}></th></tr></thead>
          <tbody>
            {approvals.map((a) => (
              <tr key={a.id}>
                <td style={S.td}>{a.subject}</td>
                <td style={S.td}><span style={S.dim}>{a.payload?.summary ?? ''}</span></td>
                <td style={S.td}><input style={S.input} placeholder="可选意见" value={comment[a.id] ?? ''} onChange={(e) => setComment({ ...comment, [a.id]: e.target.value })} /></td>
                <td style={S.td}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button style={S.btn} onClick={() => void call('approvals/decide', { id: a.id, decision: 'approved', comment: comment[a.id] ?? '' }).then(refresh)}>签收</button>
                    <button style={S.btn} onClick={() => void call('approvals/decide', { id: a.id, decision: 'rejected', comment: comment[a.id] ?? '' }).then(refresh)}>驳回</button>
                  </div>
                </td>
              </tr>
            ))}
            {approvals.length === 0 && <tr><td style={S.td} colSpan={4}><span style={S.dim}>没有待签收事项</span></td></tr>}
          </tbody>
        </table>
      </div>
    );
  }

  function DatabasesPage() {
    const [nodes, setNodes] = useState<any[]>([]);
    const refresh = async () => { try { setNodes((await call('nodes/list', {})).nodes); } catch { /* retry */ } };
    useEffect(() => { void refresh(); const t = setInterval(() => void refresh(), 20_000); return () => clearInterval(t); }, []);
    return (
      <div>
        <div style={S.h2}>数据库节点</div>
        <div style={S.cards}>
          {nodes.map((n) => (
            <div key={n.id} style={S.card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: n.status === 'online' ? '#3fa552' : n.status === 'offline' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)' }}>●</span>
                <b>{n.name}</b>
                <span style={S.dim}>{n.engine}</span>
              </div>
              <div style={{ marginTop: 6, fontSize: 12 }}>{n.host}:{n.port}/{n.dbname}</div>
              <div style={{ marginTop: 4, fontSize: 12 }}>状态：{n.status}</div>
              <div style={{ marginTop: 8 }}><span style={S.dim}>节点监控大盘（批次 2 上线）</span></div>
            </div>
          ))}
          {nodes.length === 0 && <span style={S.dim}>还没有节点——去 设置→OpenDB 添加</span>}
        </div>
      </div>
    );
  }

  function ResourcesPage() {
    const [agents, setAgents] = useState<any[]>([]);
    useEffect(() => { void call('agents/list', {}).then((a) => setAgents(a.agents)).catch(() => {}); }, []);
    return (
      <div>
        <div style={S.h2}>平台资源（批次 3 将展示实时 pod 拓扑 / k8s 逻辑架构 / 模型用量）</div>
        <div style={S.cards}>
          <div style={S.card}><b>逻辑 agent</b><div style={{ marginTop: 6 }}>{agents.length} 个</div></div>
          <div style={S.card}><b>运行形态</b><div style={{ marginTop: 6, fontSize: 12 }}>Host ×1 · Runtime 池 ×2 · Collector ×1<br />PG(Timescale+pgvector) · MinIO · Ollama(bge-m3)</div></div>
          <div style={S.card}><b>记忆层</b><div style={{ marginTop: 6, fontSize: 12 }}>PG 真相 + 向量语义检索<br />报告自动入记忆 · 会话自动注入</div></div>
        </div>
      </div>
    );
  }

  return function HarnessOverlay() {
    const hs = useSyncExternalStore(subscribe, getState);
    if (hs.view === 'chat') return null;
    const title = hs.view === 'tasks' ? '任务' : hs.view === 'databases' ? '数据库' : '资源';
    return (
      <div style={S.shade}>
        <div style={S.head}>
          <span style={S.title}>{title}</span>
          <span style={S.dim}>agent：{hs.agentName || '…'}</span>
          <button style={{ ...S.btn, marginLeft: 'auto' }} onClick={() => setState({ view: 'chat' })}>返回会话 ✕</button>
        </div>
        <div style={S.body}>
          {hs.view === 'tasks' && <TasksPage />}
          {hs.view === 'databases' && <DatabasesPage />}
          {hs.view === 'resources' && <ResourcesPage />}
        </div>
      </div>
    );
  };
}
