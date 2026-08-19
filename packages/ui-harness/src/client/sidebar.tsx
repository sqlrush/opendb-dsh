/**
 * opendb-harness 侧栏（sidebar.workspaces hole）：agent 切换下拉（含低频的"新建 agent"，
 * 藏在下拉底部——user 定案）+ 四资源导航 + 当前 agent 的会话列表。
 * 侧栏右缘经 ResizeObserver 写入 store，主区页面贴齐渲染。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getState, setState, subscribe, type HarnessView } from './state.ts';

interface AgentRow { id: string; name: string; nodeCount: number; status: string }
interface SessionRow { sessionId: string; title: string; lastAt: number }

/** 数据库圆柱图标（currentColor 细线，替换 emoji —— user 反馈）。 */
function DbIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" style={{ flexShrink: 0 }}>
      <ellipse cx="8" cy="3.5" rx="5.5" ry="2.2" />
      <path d="M2.5 3.5v9c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2v-9" />
      <path d="M2.5 8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2" />
    </svg>
  );
}

export function makeSidebar(ctx: any, call: (endpoint: string, payload?: unknown) => Promise<any>) {
  const S: Record<string, React.CSSProperties> = {
    wrap: { display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 10px', color: 'var(--dsw-alias-label-primary)', fontSize: 13, height: '100%', overflow: 'hidden', position: 'relative' as const },
    agentBtn: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 8, cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l1)', userSelect: 'none' as const },
    menu: { position: 'absolute' as const, top: 40, left: 10, right: 10, zIndex: 20, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.25)', overflow: 'hidden' },
    menuItem: { padding: '8px 10px', cursor: 'pointer' },
    menuDivider: { borderTop: '1px solid var(--dsw-alias-border-l1)' },
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

  return function HarnessSidebar() {
    const hs = useSyncExternalStore(subscribe, getState);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const [agents, setAgents] = useState<AgentRow[]>([]);
    const [sessions, setSessions] = useState<SessionRow[]>([]);
    const [pendingAcks, setPendingAcks] = useState(0);
    const [offlineNodes, setOfflineNodes] = useState(0);
    const [menuOpen, setMenuOpen] = useState(false);
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');

    // 侧栏右缘实时上报（主区页面贴齐渲染，不盖侧栏）
    useEffect(() => {
      const measure = () => {
        const el = wrapRef.current;
        if (el !== null) setState({ sidebarRight: Math.round(el.getBoundingClientRect().right) });
      };
      measure();
      const ro = new ResizeObserver(measure);
      if (wrapRef.current !== null) ro.observe(wrapRef.current);
      window.addEventListener('resize', measure);
      return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
    }, []);

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
        setPendingAcks((await call('approvals/list', { status: 'pending' })).approvals.length);
        setOfflineNodes((await call('nodes/list', {})).nodes.filter((x: any) => x.status === 'offline').length);
      } catch { /* keep last data; next poll retries */ }
    };
    useEffect(() => {
      void refresh();
      const t = setInterval(() => { void refresh(); }, 30_000);
      return () => clearInterval(t);
    }, [hs.agentId]);

    const nav = (view: HarnessView, icon: React.ReactNode, label: string, badge?: { n: number; warn: boolean }) => (
      <div style={{ ...S.navItem, ...(hs.view === view ? S.navActive : {}) }} onClick={() => setState({ view })}>
        <span style={{ display: 'inline-flex', width: 16, justifyContent: 'center' }}>{icon}</span><span>{label}</span>
        {badge !== undefined && badge.n > 0 && <span style={{ ...S.badge, ...(badge.warn ? S.badgeWarn : {}) }}>{badge.n}</span>}
      </div>
    );

    const createAgent = async () => {
      const name = newName.trim();
      if (name === '') return;
      try {
        await call('agents/create', { name });
        await ctx.workspaces.create({ path: `/var/lib/dsh/agents/${name}` }).catch(() => { /* 首次开会话时兜底创建 */ });
        setCreating(false); setNewName(''); setMenuOpen(false);
        await refresh();
      } catch { /* 保持表单让用户重试 */ }
    };

    const openSession = (id: string) => { setState({ view: 'chat' }); ctx.sessions.open(id); };
    const newSession = async () => {
      setState({ view: 'chat' });
      try {
        const ws = await call('workspaces/find', { agentName: hs.agentName });
        if (typeof ws.workspaceId === 'string') await ctx.workspaces.startSession(ws.workspaceId);
      } catch { /* ignore */ }
    };

    const current = agents.find((a) => a.id === hs.agentId);

    return (
      <div ref={wrapRef} style={S.wrap}>
        {/* agent 切换器：低频的"新建"藏在下拉底部（user 定案：不做常驻按钮） */}
        <div style={S.agentBtn} onClick={() => { setMenuOpen(!menuOpen); setCreating(false); }}>
          <span>●</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current?.name ?? '…'}</span>
          <span style={{ ...S.dim, marginLeft: 'auto' }}>▾</span>
        </div>
        {menuOpen && (
          <div style={S.menu}>
            {agents.map((a) => (
              <div key={a.id} style={{ ...S.menuItem, ...(a.id === hs.agentId ? S.navActive : {}) }}
                onClick={() => { setState({ agentId: a.id, agentName: a.name }); setMenuOpen(false); }}>
                {a.name} <span style={S.dim}>· {a.nodeCount} 节点</span>
              </div>
            ))}
            <div style={S.menuDivider} />
            {!creating
              ? <div style={{ ...S.menuItem, ...S.dim }} onClick={(e) => { e.stopPropagation(); setCreating(true); }}>＋ 新建 agent…</div>
              : (
                <div style={{ padding: 8, display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                  <input style={S.input} autoFocus placeholder="agent 名称" value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void createAgent(); }} />
                  <button style={S.btn} onClick={() => void createAgent()}>建</button>
                </div>
              )}
          </div>
        )}

        <div>
          {nav('chat', '💬', '会话')}
          {nav('tasks', '📋', '任务', { n: pendingAcks, warn: pendingAcks > 0 })}
          {nav('databases', <DbIcon />, '数据库', { n: offlineNodes, warn: offlineNodes > 0 })}
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
