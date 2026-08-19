/**
 * opendb-harness 侧栏（sidebar.workspaces hole）——user 定案的分区树形态：
 * 会话/任务/数据库三个分区各自挂子列表（dsh 原版工作区树的形态），点分区头开总览页，
 * 点子条目直达（会话→会话流；任务→该任务详情；数据库→该节点详情）。资源为纯入口。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getState, setState, subscribe, type HarnessView } from './state.ts';

interface AgentRow { id: string; name: string; nodeCount: number; status: string }
interface SessionRow { sessionId: string; title: string; lastAt: number }

/** 数据库圆柱图标（currentColor 细线）。 */
function DbIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" style={{ flexShrink: 0 }}>
      <ellipse cx="8" cy="3.5" rx="5.5" ry="2.2" />
      <path d="M2.5 3.5v9c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2v-9" />
      <path d="M2.5 8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2" />
    </svg>
  );
}

const sevDot = (s?: string) => s === 'critical' ? '#d64545' : s === 'warn' ? '#c9862d' : s === 'ok' ? '#3fa552' : 'transparent';

export function makeSidebar(ctx: any, call: (endpoint: string, payload?: unknown) => Promise<any>) {
  const S: Record<string, React.CSSProperties> = {
    wrap: { display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 8px', color: 'var(--dsw-alias-label-primary)', fontSize: 13, height: '100%', overflowY: 'auto', position: 'relative' as const },
    agentBtn: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 8, cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l1)', userSelect: 'none' as const, marginBottom: 4 },
    menu: { position: 'absolute' as const, top: 40, left: 8, right: 8, zIndex: 20, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.25)', overflow: 'hidden' },
    menuItem: { padding: '8px 10px', cursor: 'pointer' },
    menuDivider: { borderTop: '1px solid var(--dsw-alias-border-l1)' },
    secHead: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 6px', borderRadius: 8, cursor: 'pointer', userSelect: 'none' as const, fontWeight: 600 },
    secHeadActive: { background: 'var(--dsw-alias-interactive-bg-hover)' },
    caret: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 10, width: 10 },
    badge: { marginLeft: 'auto', fontSize: 11, borderRadius: 8, padding: '0 6px', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' },
    badgeWarn: { background: '#c9862d', color: '#fff' },
    item: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px 4px 22px', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap' as const, overflow: 'hidden' },
    itemActive: { background: 'var(--dsw-alias-interactive-bg-hover)' },
    itemText: { overflow: 'hidden', textOverflow: 'ellipsis' },
    list: { display: 'flex', flexDirection: 'column' as const, gap: 1, maxHeight: 240, overflowY: 'auto' as const },
    dot: { width: 7, height: 7, borderRadius: 4, flexShrink: 0 },
    miniBtn: { background: 'none', border: 'none', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer', fontSize: 14, padding: '0 4px' },
    dim: { color: 'var(--dsw-alias-label-tertiary)' },
    input: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, color: 'var(--dsw-alias-label-primary)', padding: '4px 8px', fontSize: 13, width: '100%', boxSizing: 'border-box' as const },
    btn: { background: 'var(--dsw-alias-interactive-bg-hover)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, color: 'var(--dsw-alias-label-primary)', padding: '4px 8px', fontSize: 12, cursor: 'pointer' },
  };

  return function HarnessSidebar() {
    const hs = useSyncExternalStore(subscribe, getState);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const [agents, setAgents] = useState<AgentRow[]>([]);
    const [sessions, setSessions] = useState<SessionRow[]>([]);
    const [tasks, setTasks] = useState<any[]>([]);
    const [nodes, setNodes] = useState<any[]>([]);
    const [pendingAcks, setPendingAcks] = useState(0);
    const [open, setOpen] = useState<{ chat: boolean; tasks: boolean; db: boolean }>({ chat: true, tasks: true, db: true });
    const [menuOpen, setMenuOpen] = useState(false);
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');

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
          setSessions((await call('sessions/list', { agentName: current.name, limit: 30 })).sessions);
        }
        setTasks((await call('tasks/list', {})).tasks);
        setNodes((await call('nodes/list', {})).nodes);
        setPendingAcks((await call('approvals/list', { status: 'pending' })).approvals.length);
      } catch { /* keep last data; next poll retries */ }
    };
    useEffect(() => {
      void refresh();
      const t = setInterval(() => { void refresh(); }, 30_000);
      return () => clearInterval(t);
    }, [hs.agentId]);

    const createAgent = async () => {
      const name = newName.trim();
      if (name === '') return;
      try {
        await call('agents/create', { name });
        await ctx.workspaces.create({ path: `/var/lib/dsh/agents/${name}` }).catch(() => { /* 首次开会话时兜底 */ });
        setCreating(false); setNewName(''); setMenuOpen(false);
        await refresh();
      } catch { /* 保持表单让用户重试 */ }
    };

    const openSession = (id: string) => { setState({ view: 'chat' }); ctx.sessions.open(id); };
    const newSession = async (e: any) => {
      e.stopPropagation();
      setState({ view: 'chat' });
      try {
        const ws = await call('workspaces/find', { agentName: hs.agentName });
        if (typeof ws.workspaceId === 'string') await ctx.workspaces.startSession(ws.workspaceId);
      } catch { /* ignore */ }
    };

    const secHead = (key: 'chat' | 'tasks' | 'db', view: HarnessView, icon: React.ReactNode, label: string, extra?: React.ReactNode) => (
      <div
        style={{ ...S.secHead, ...(hs.view === view ? S.secHeadActive : {}) }}
        onClick={() => { setState({ view, ...(view === 'tasks' ? { selectedTaskId: '' } : {}), ...(view === 'databases' ? { selectedNodeId: '' } : {}) }); }}
      >
        <span
          style={S.caret}
          onClick={(e) => { e.stopPropagation(); setOpen({ ...open, [key]: !open[key] }); }}
        >{open[key] ? '▾' : '▸'}</span>
        <span style={{ display: 'inline-flex', width: 16, justifyContent: 'center' }}>{icon}</span>
        <span>{label}</span>
        {extra}
      </div>
    );

    const current = agents.find((a) => a.id === hs.agentId);

    return (
      <div ref={wrapRef} style={S.wrap}>
        {/* agent 切换器（低频"新建"藏在下拉底部） */}
        <div style={S.agentBtn} onClick={() => { setMenuOpen(!menuOpen); setCreating(false); }}>
          <span>●</span>
          <span style={S.itemText}>{current?.name ?? '…'}</span>
          <span style={{ ...S.dim, marginLeft: 'auto' }}>▾</span>
        </div>
        {menuOpen && (
          <div style={S.menu}>
            {agents.map((a) => (
              <div key={a.id} style={{ ...S.menuItem, ...(a.id === hs.agentId ? S.secHeadActive : {}) }}
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

        {/* 会话分区 */}
        {secHead('chat', 'chat', '💬', '会话', <button style={{ ...S.miniBtn, marginLeft: 'auto' }} title="新会话" onClick={(e) => void newSession(e)}>＋</button>)}
        {open.chat && (
          <div style={S.list}>
            {sessions.map((s) => (
              <div key={s.sessionId} style={S.item} title={s.title} onClick={() => openSession(s.sessionId)}>
                <span style={S.itemText}>{s.title}</span>
              </div>
            ))}
            {sessions.length === 0 && <div style={{ ...S.item, ...S.dim }}>还没有会话</div>}
          </div>
        )}

        {/* 任务分区：不断添加的任务（监控大盘/SQL 审核/巡检…），点条目直达任务详情 */}
        {secHead('tasks', 'tasks', '📋', '任务', pendingAcks > 0 ? <span style={{ ...S.badge, ...S.badgeWarn }}>{pendingAcks}</span> : undefined)}
        {open.tasks && (
          <div style={S.list}>
            {tasks.map((t) => (
              <div key={t.id}
                style={{ ...S.item, ...(hs.view === 'tasks' && hs.selectedTaskId === t.id ? S.itemActive : {}) }}
                title={`${t.name}（${t.type}${t.cron ? ' · ' + t.cron : ''}）`}
                onClick={() => setState({ view: 'tasks', selectedTaskId: t.id })}>
                <span style={{ ...S.dot, background: sevDot(t.lastReport?.severity) }} />
                <span style={S.itemText}>{t.name}</span>
                {t.lastRun?.status === 'running' && <span style={{ ...S.dim, marginLeft: 'auto' }}>▶</span>}
                {!t.enabled && <span style={{ ...S.dim, marginLeft: 'auto', fontSize: 11 }}>停</span>}
              </div>
            ))}
            {tasks.length === 0 && <div style={{ ...S.item, ...S.dim }}>还没有任务</div>}
          </div>
        )}

        {/* 数据库分区：节点列表，点条目直达节点详情 */}
        {secHead('db', 'databases', <DbIcon />, '数据库')}
        {open.db && (
          <div style={S.list}>
            {nodes.map((n) => (
              <div key={n.id}
                style={{ ...S.item, ...(hs.view === 'databases' && hs.selectedNodeId === n.id ? S.itemActive : {}) }}
                title={`${n.host}:${n.port}/${n.dbname}`}
                onClick={() => setState({ view: 'databases', selectedNodeId: n.id })}>
                <span style={{ ...S.dot, background: n.status === 'online' ? '#3fa552' : n.status === 'offline' ? '#d64545' : 'var(--dsw-alias-border-l2)' }} />
                <span style={S.itemText}>{n.name}</span>
                <span style={{ ...S.dim, marginLeft: 'auto', fontSize: 11 }}>{n.engine === 'opengauss' ? 'og' : 'pg'}</span>
              </div>
            ))}
            {nodes.length === 0 && <div style={{ ...S.item, ...S.dim }}>还没有节点</div>}
          </div>
        )}

        {/* 资源：纯入口 */}
        <div
          style={{ ...S.secHead, ...(hs.view === 'resources' ? S.secHeadActive : {}) }}
          onClick={() => setState({ view: 'resources' })}
        >
          <span style={S.caret} />
          <span style={{ display: 'inline-flex', width: 16, justifyContent: 'center' }}>📊</span>
          <span>资源</span>
        </div>
      </div>
    );
  };
}
