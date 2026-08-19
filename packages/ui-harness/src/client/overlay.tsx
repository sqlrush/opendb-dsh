/**
 * opendb-harness 主区页面（user 定案：所有资源交互都在右边主区，不单开页面）：
 * 容器贴齐侧栏右缘（store.sidebarRight，随侧栏收展实时跟随），只覆盖主区。
 * 任务页 = 框架：任务列表 + 详情面板槽——不同任务对应不同插件，插件的 client 半边
 * 经 registerTaskPanel(typeKey, Panel) 注册专属 UI；未注册的类型用默认面板（运行历史+报告）。
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getState, setState, subscribe, getTaskPanel } from './state.ts';

const hsSel = () => getState().selectedTaskId;

export function makeOverlay(ctx: any, call: (endpoint: string, payload?: unknown) => Promise<any>) {
  const S: Record<string, React.CSSProperties> = {
    head: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 20px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
    title: { fontSize: 15, fontWeight: 600 },
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
    split: { display: 'flex', gap: 16, alignItems: 'flex-start' },
    listPane: { width: 340, flexShrink: 0 },
    detailPane: { flex: 1, minWidth: 0, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: 14 },
    taskRow: { padding: '8px 10px', borderRadius: 8, cursor: 'pointer', border: '1px solid transparent' },
    taskRowActive: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-interactive-bg-hover)' },
  };
  const sevColor = (s?: string) => s === 'critical' ? 'var(--dsw-alias-state-error-primary)' : s === 'warn' ? '#c9862d' : 'var(--dsw-alias-label-secondary)';

  /** 默认任务面板：运行历史 + 报告 + 操作（任务插件未注册专属面板时使用）。 */
  function DefaultTaskPanel({ task }: { task: any }) {
    const [runs, setRuns] = useState<any[]>([]);
    const refresh = async () => { try { setRuns((await call('runs/list', { taskId: task.id })).runs); } catch { /* retry */ } };
    useEffect(() => { void refresh(); const t = setInterval(() => void refresh(), 15_000); return () => clearInterval(t); }, [task.id]);
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <b>{task.name}</b><span style={S.dim}>{task.type} · {task.cron ?? '手动'}</span>
          <span style={{ marginLeft: 'auto', ...S.dim, fontSize: 12 }}>{task.enabled ? (task.cron ? '定时运行中' : '手动触发') : '已停用'}</span>
        </div>
        <div style={{ ...S.dim, fontSize: 12, margin: '8px 0' }}>要调整这个任务（改周期/改策略/停用），直接在会话里告诉智能体即可。专属大盘由任务插件提供，当前为默认视图。</div>
        <table style={S.table}>
          <thead><tr><th style={S.th}>时间</th><th style={S.th}>触发</th><th style={S.th}>状态</th><th style={S.th}>报告</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td style={S.td}>{String(r.firedAt).replace('T', ' ').slice(0, 19)}</td>
                <td style={S.td}><span style={S.dim}>{r.triggerKind}</span></td>
                <td style={S.td}>{r.status}{r.error ? <span style={{ color: sevColor('critical') }}> {r.error}</span> : null}</td>
                <td style={S.td}>{r.report !== undefined ? <span style={{ color: sevColor(r.report.severity) }}>{r.report.severity} · {r.report.summary}</span> : <span style={S.dim}>-</span>}</td>
              </tr>
            ))}
            {runs.length === 0 && <tr><td style={S.td} colSpan={4}><span style={S.dim}>还没有运行记录</span></td></tr>}
          </tbody>
        </table>
      </div>
    );
  }

  function TasksPage() {
    const [tasks, setTasks] = useState<any[]>([]);
    const [approvals, setApprovals] = useState<any[]>([]);
    const selected = hsSel();
    const [comment, setComment] = useState<Record<string, string>>({});
    const refresh = async () => {
      try {
        setTasks((await call('tasks/list', {})).tasks);
        setApprovals((await call('approvals/list', { status: 'pending' })).approvals);
      } catch { /* retry next poll */ }
    };
    useEffect(() => { void refresh(); const t = setInterval(() => void refresh(), 20_000); return () => clearInterval(t); }, []);
    const task = tasks.find((t) => t.id === selected);
    const Panel = task !== undefined ? (getTaskPanel(task.type) ?? DefaultTaskPanel) : undefined;
    return (
      <div>
        {approvals.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={S.h2}>待签收（{approvals.length}）</div>
            <table style={S.table}>
              <tbody>
                {approvals.map((a) => (
                  <tr key={a.id}>
                    <td style={S.td}>{a.subject}</td>
                    <td style={S.td}><input style={S.input} placeholder="意见" value={comment[a.id] ?? ''} onChange={(e) => setComment({ ...comment, [a.id]: e.target.value })} /></td>
                    <td style={S.td}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button style={S.btn} onClick={() => void call('approvals/decide', { id: a.id, decision: 'approved', comment: comment[a.id] ?? '' }).then(refresh)}>签收</button>
                        <button style={S.btn} onClick={() => void call('approvals/decide', { id: a.id, decision: 'rejected', comment: comment[a.id] ?? '' }).then(refresh)}>驳回</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={S.split}>
          <div style={S.listPane}>
            <div style={S.h2}>任务</div>
            {tasks.map((t) => (
              <div key={t.id} style={{ ...S.taskRow, ...(t.id === selected ? S.taskRowActive : {}) }} onClick={() => setState({ selectedTaskId: t.id })}>
                <div style={{ display: 'flex', gap: 6 }}>
                  <b>{t.name}</b>
                  {!t.enabled && <span style={S.dim}>停用</span>}
                </div>
                <div style={{ fontSize: 12, marginTop: 2 }}>
                  <span style={S.dim}>{t.type} · {t.cron ?? '手动'}</span>
                  {t.lastReport !== undefined && <span style={{ color: sevColor(t.lastReport.severity) }}> · {t.lastReport.severity}</span>}
                </div>
              </div>
            ))}
            {tasks.length === 0 && <span style={S.dim}>还没有任务——在会话里让 opendb-harness 帮你建</span>}
          </div>
          <div style={S.detailPane}>
            {Panel !== undefined && task !== undefined
              ? <Panel task={task} call={call} />
              : <span style={S.dim}>← 选择一个任务查看详情（任务插件的专属面板将渲染在这里）</span>}
          </div>
        </div>
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
            <div key={n.id} style={{ ...S.card, ...(getState().selectedNodeId === n.id ? { borderColor: 'var(--dsw-alias-label-secondary)' } : {}) }} onClick={() => setState({ selectedNodeId: n.id })}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: n.status === 'online' ? '#3fa552' : n.status === 'offline' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)' }}>●</span>
                <b>{n.name}</b>
                <span style={S.dim}>{n.engine}</span>
              </div>
              <div style={{ marginTop: 6, fontSize: 12 }}>{n.host}:{n.port}/{n.dbname}</div>
              <div style={{ marginTop: 4, fontSize: 12 }}>状态：{n.status}</div>
              <div style={{ marginTop: 8 }}><span style={S.dim}>节点监控详情（下一批上线）</span></div>
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
        <div style={S.h2}>平台资源（下一批展示实时 pod 拓扑 / k8s 逻辑架构 / 模型用量）</div>
        <div style={S.cards}>
          <div style={S.card}><b>逻辑 agent</b><div style={{ marginTop: 6 }}>{agents.length} 个</div></div>
          <div style={S.card}><b>运行形态</b><div style={{ marginTop: 6, fontSize: 12 }}>Host ×1 · Runtime 池 ×2 · Collector ×1<br />PG(Timescale+pgvector) · MinIO · Ollama(bge-m3)</div></div>
          <div style={S.card}><b>记忆层</b><div style={{ marginTop: 6, fontSize: 12 }}>PG 真相 + 向量语义检索<br />报告自动入记忆 · 会话自动注入</div></div>
        </div>
      </div>
    );
  }

  /** 新建智能体（交互纲领 §15：稀缺的弹页场景，设置页风格）——配置管理的数据库/挂载插件技能/连接模型。 */
  function NewAgentPage() {
    const [nodes, setNodes] = useState<any[]>([]);
    const [name, setName] = useState('');
    const [picked, setPicked] = useState<Record<string, boolean>>({});
    const [model, setModel] = useState('deepseek-v4-flash');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    useEffect(() => { void call('nodes/list', {}).then((r) => setNodes(r.nodes)).catch(() => {}); }, []);
    const submit = async () => {
      const n = name.trim();
      if (!/^[\w-]{1,40}$/.test(n)) { setErr('名称只能包含字母/数字/下划线/连字符'); return; }
      setBusy(true); setErr('');
      try {
        const created = await call('agents/create', { name: n });
        for (const node of nodes) if (picked[node.id]) await call('nodes/assign', { nodeId: node.id, agentId: created.agent.id });
        await call('agents/update', { id: created.agent.id, patch: { modelProvider: 'deepseek-official', modelName: model } });
        await ctx.workspaces.create({ path: `/var/lib/dsh/agents/${n}` }).catch(() => {});
        setState({ view: 'chat', agentId: created.agent.id, agentName: n });
      } catch (e) { setErr(String((e as Error).message ?? e)); } finally { setBusy(false); }
    };
    const label: React.CSSProperties = { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', margin: '18px 0 8px', fontWeight: 600 };
    const box: React.CSSProperties = { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: 12 };
    return (
      <div style={{ maxWidth: 560, margin: '0 auto', paddingBottom: 40 }}>
        <div style={{ fontSize: 17, fontWeight: 700, margin: '8px 0 2px' }}>新建智能体</div>
        <div style={{ ...S.dim, fontSize: 13 }}>创建后，会话、任务、数据库都挂在这个智能体下；日常使用中的一切调整都可以在会话里告诉它。</div>

        <div style={label}>名称</div>
        <input style={{ ...S.input, width: '100%', boxSizing: 'border-box', padding: '8px 10px' }} autoFocus placeholder="例如 og-prod" value={name} onChange={(e) => setName(e.target.value)} />

        <div style={label}>管理的数据库（可多选，之后也能在会话里增减）</div>
        <div style={box}>
          {nodes.map((n) => (
            <label key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 2px', cursor: 'pointer', fontSize: 14 }}>
              <input type="checkbox" checked={picked[n.id] === true} onChange={(e) => setPicked({ ...picked, [n.id]: e.target.checked })} />
              <span>{n.name}</span>
              <span style={{ ...S.dim, fontSize: 12 }}>{n.engine} · {n.host}:{n.port}{n.agentId ? ' · 已属其它智能体' : ''}</span>
            </label>
          ))}
          {nodes.length === 0 && <span style={S.dim}>暂无已登记节点（可先创建智能体，稍后在会话里添加节点）</span>}
        </div>

        <div style={label}>挂载插件与技能</div>
        <div style={{ ...box, ...S.dim, fontSize: 13, lineHeight: 1.9 }}>
          数据库诊断（db_query / db_overview）· 指标监控（metrics）· 字典变更（dict）· 记忆（memory）· 任务引擎（巡检 / SQL 审核 / 定时对话）
          <div style={{ fontSize: 12, marginTop: 4 }}>MVP 阶段默认全量挂载，后续版本支持按智能体裁剪。</div>
        </div>

        <div style={label}>连接模型（会话与任务可单独调整）</div>
        <select style={{ ...S.input, padding: '8px 10px' }} value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="deepseek-v4-flash">DeepSeek-V4-Flash（默认，性价比）</option>
          <option value="deepseek-v4">DeepSeek-V4（复杂诊断）</option>
        </select>

        {err !== '' && <div style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 13, marginTop: 12 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
          <button style={{ ...S.btn, padding: '8px 22px', fontWeight: 600 }} disabled={busy} onClick={() => void submit()}>创建</button>
          <button style={{ ...S.btn, padding: '8px 16px' }} onClick={() => setState({ view: 'chat' })}>取消</button>
        </div>
      </div>
    );
  }

  return function HarnessMain() {
    const hs = useSyncExternalStore(subscribe, getState);
    if (hs.view === 'chat') return null;
    if (hs.view === 'newAgent') {
      return (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--dsw-alias-bg-base, #fff)', zIndex: 50, display: 'flex', flexDirection: 'column', color: 'var(--dsw-alias-label-primary)' }}>
          <div style={S.head}>
            <span style={S.title}>新建智能体</span>
            <button style={{ ...S.btn, marginLeft: 'auto' }} onClick={() => setState({ view: 'chat' })}>关闭 ✕</button>
          </div>
          <div style={S.body}><NewAgentPage /></div>
        </div>
      );
    }
    const title = hs.view === 'tasks' ? '任务' : hs.view === 'databases' ? '数据库' : '资源';
    return (
      <div style={{
        position: 'fixed', top: 0, bottom: 0, right: 0, left: hs.sidebarRight,
        background: 'var(--dsw-alias-bg-base, #fff)', zIndex: 30,
        display: 'flex', flexDirection: 'column', color: 'var(--dsw-alias-label-primary)',
      }}>
        <div style={S.head}>
          <span style={S.title}>{title}</span>
          <span style={S.dim}>agent：{hs.agentName || '…'}</span>
          <button style={{ ...S.btn, marginLeft: 'auto' }} onClick={() => setState({ view: 'chat' })}>返回会话</button>
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
