/**
 * opendb-harness 侧栏（替换官方 sidebar.workspaces hole，W5.5 批次1）：
 * 品牌行 + agent 切换器（default agent 低调显示，可新建）+ 四资源导航（任务/数据库/资源角标）
 * + 当前 agent 的会话列表（sessions/list RPC；点击 ctx.sessions.open）。
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getState, setState, subscribe, type HarnessView } from './state.ts';

interface AgentRow { id: string; name: string; nodeCount: number; status: string }
interface SessionRow { sessionId: string; title: string; lastAt: number }

export function makeSidebar(ctx: any, call: (endpoint: string, payload?: unknown) => Promise<any>) {
  const S: Record<string, React.CSSProperties> = {
    wrap: { display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 10px', color: 'var(--dsw-alias-label-primary)', fontSize: 13, height: '100%', overflow: 'hidden' },
    brand: { fontWeight: 700, fontSize: 14, letterSpacing: 0.3 },
    brandSub: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 },
    agentRow: { display: 'flex', gap: 6, alignItems: 'center' },
    select: { flex: 1, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, color: 'var(--dsw-alias-label-primary)', padding: '4px 6px', fontSize: 13 },
    navItem: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8, cursor: 'pointer', userSelect: 'none' as const },
    navActive: { background: 'var(--dsw-alias-interactive-bg-hover)' },
    badge: { marginLeft: 'auto', fontSize: 11, borderRadius: 8, padding: '0 6px', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' },
    badgeWarn: { background: '#c9862d', color: '#fff' },
    sectionTitle: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: 0.5, marginTop: 4 },
    sessionItem: { padding: '5px 8px', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' },
    sessions: { flex: 1, overflowY: 'auto' as const, display: 'flex', flexDirection: 'column' as const, gap: 2 },
    btn: { background: 'var(--dsw-alias-interactive-bg-hover)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, color: 'var(--dsw-alias-label-primary)', padding: '4px 8px', fontSize: 12, cursor: 'pointer' },
    dim: { color: 'var(--dsw-alias-label-tertiary)' },
    input: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, color: 'var(--dsw-alias-label-primary)', padding: '4px 8px', fontSize: 13, width: '100%', boxSizing: 'border-box' as const },
  };

  function statusDot(a: AgentRow): string {
    if (a.nodeCount === 0) return '○';
    return '●';
  }

  return function HarnessSidebar() {
    const hs = useSyncExternalStore(subscribe, getState);
    const [agents, setAgents] = useState<AgentRow[]>([]);
    const [sessions, setSessions] = useState<SessionRow[]>([]);
    const [pendingAcks, setPendingAcks] = useState(0);
    const [offlineNodes, setOfflineNodes] = useState(0);
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');

    const refresh = async () => {
      try {
        const a = await call('agents/list', {});
        const rows: AgentRow[] = a.agents.map((x: any) => ({ id: x.id, name: x.name, nodeCount: x.nodeCount, status: x.status }));
        setAgents(rows);
        const current = rows.find((x) => x.id === getState().agentId) ?? rows[0];
        if (current !== undefined && current.id !== getState().agentId) setState({ agentId: current.id, agentName: current.name });
        if (current !== undefined) {
          const s = await call('sessions/list', { agentName: current.name, limit: 30 });
          setSessions(s.sessions);
        }
        const ap = await call('approvals/list', { status: 'pending' });
        setPendingAcks(ap.approvals.length);
        const n = await call('nodes/list', {});
        setOfflineNodes(n.nodes.filter((x: any) => x.status === 'offline').length);
      } catch { /* sidebar stays with last data; next poll retries */ }
    };
    useEffect(() => {
      void refresh();
      const t = setInterval(() => { void refresh(); }, 30_000);
      return () => clearInterval(t);
    }, [hs.agentId]);

    const nav = (view: HarnessView, icon: string, label: string, badge?: { n: number; warn: boolean }) => (
      <div
        style={{ ...S.navItem, ...(hs.view === view ? S.navActive : {}) }}
        onClick={() => setState({ view })}
      >
        <span>{icon}</span><span>{label}</span>
        {badge !== undefined && badge.n > 0 && <span style={{ ...S.badge, ...(badge.warn ? S.badgeWarn : {}) }}>{badge.n}</span>}
      </div>
    );

    const createAgent = async () => {
      const name = newName.trim();
      if (name === '') return;
      try {
        // registry 建 agent + 官方 workspaces.create 建对应工作区（路径约定 /agents/<name>）
        await call('agents/create', { name });
        await ctx.workspaces.create({ path: `/var/lib/dsh/agents/${name}` }).catch(() => { /* 目录流兜底：首次 startSession 时也会建 */ });
        setCreating(false); setNewName('');
        await refresh();
      } catch { /* 下轮刷新可见错误状态 */ }
    };

    const openSession = (id: string) => { setState({ view: 'chat' }); ctx.sessions.open(id); };
    const newSession = async () => {
      setState({ view: 'chat' });
      try {
        const ws = await call('workspaces/find', { agentName: hs.agentName });
        if (typeof ws.workspaceId === 'string') await ctx.workspaces.startSession(ws.workspaceId);
      } catch { /* ignore */ }
    };

    return (
      <div style={S.wrap}>
        <div>
          <div style={S.brand}>opendb-harness</div>
          <div style={S.brandSub}>数据库集群自动化运维</div>
        </div>

        <div style={S.agentRow}>
          {agents.length <= 1
            ? <span title="agent">{agents[0] !== undefined ? `${statusDot(agents[0])} ${agents[0].name}` : '…'}</span>
            : (
              <select style={S.select} value={hs.agentId} onChange={(e) => {
                const a = agents.find((x) => x.id === e.target.value);
                if (a !== undefined) setState({ agentId: a.id, agentName: a.name });
              }}>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}（{a.nodeCount} 节点）</option>)}
              </select>
            )}
          <button style={S.btn} title="新建 agent" onClick={() => setCreating(!creating)}>＋</button>
        </div>
        {creating && (
          <div style={{ display: 'flex', gap: 6 }}>
            <input style={S.input} placeholder="新 agent 名称" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button style={S.btn} onClick={() => void createAgent()}>建</button>
          </div>
        )}

        <div>
          {nav('chat', '💬', '会话')}
          {nav('tasks', '📋', '任务', { n: pendingAcks, warn: pendingAcks > 0 })}
          {nav('databases', '🗄', '数据库', { n: offlineNodes, warn: offlineNodes > 0 })}
          {nav('resources', '📊', '资源')}
        </div>

        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={S.sectionTitle}>最近会话</span>
          <button style={{ ...S.btn, marginLeft: 'auto' }} onClick={() => void newSession()}>新会话</button>
        </div>
        <div style={S.sessions}>
          {sessions.map((s) => (
            <div key={s.sessionId} style={S.sessionItem} title={s.title} onClick={() => openSession(s.sessionId)}>
              {s.title}
            </div>
          ))}
          {sessions.length === 0 && <span style={S.dim}>还没有会话</span>}
        </div>
      </div>
    );
  };
}
