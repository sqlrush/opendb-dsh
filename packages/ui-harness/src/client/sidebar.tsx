/**
 * opendb-harness 侧栏 —— 全面继承 dsh 原版视觉（prd/ 两张对照截图定稿）：
 * logo 行（数据库图标 + opendb 粗字 + HARNESS 黑胶囊）、「智能体」小节头 + 三小按钮
 * （搜索 / 按智能体分类切换 / 新建智能体）、蓝色线性图标、dsh 条目行风格（右侧灰色 meta）。
 * 分类模式：每个智能体一组，组内挂会话/任务/数据库；不分类：三类资源全量平铺。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getState, setState, subscribe } from './state.ts';

const BLUE = '#4D6BFE';   // dsh 文件夹图标同款蓝

/* ── 16px 细线图标组（stroke=currentColor，风格对齐 dsh）───────────────── */
const I = {
  db: (c = BLUE, s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke={c} strokeWidth="1.3" strokeLinecap="round">
      <ellipse cx="8" cy="3.6" rx="5.6" ry="2.1" />
      <path d="M2.4 3.6v8.8c0 1.16 2.5 2.1 5.6 2.1s5.6-.94 5.6-2.1V3.6" />
      <path d="M2.4 8c0 1.16 2.5 2.1 5.6 2.1S13.6 9.16 13.6 8" />
    </svg>
  ),
  agent: (c = BLUE, s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke={c} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="10" height="8" rx="2" />
      <path d="M8 5V2.8M6 2.8h4" />
      <circle cx="6" cy="8.6" r="0.6" fill={c} stroke="none" />
      <circle cx="10" cy="8.6" r="0.6" fill={c} stroke="none" />
      <path d="M6.2 11h3.6" />
    </svg>
  ),
  chat: (c: string, s = 15) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke={c} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 8a5.5 5.5 0 1 1 2.2 4.4L2.3 13l.6-2.3A5.47 5.47 0 0 1 2.5 8Z" />
    </svg>
  ),
  task: (c: string, s = 15) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke={c} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="2.5" width="10" height="11" rx="1.6" />
      <path d="M5.6 6h4.8M5.6 8.5h4.8M5.6 11h2.8" />
    </svg>
  ),
  chart: (c: string, s = 15) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke={c} strokeWidth="1.3" strokeLinecap="round">
      <path d="M2.5 13.5h11" />
      <path d="M4.5 13V9M8 13V5.5M11.5 13V7.5" />
    </svg>
  ),
  search: (c: string, s = 15) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke={c} strokeWidth="1.3" strokeLinecap="round">
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2 13.4 13.4" />
    </svg>
  ),
  group: (c: string, s = 15) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke={c} strokeWidth="1.3" strokeLinecap="round">
      <path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" />
    </svg>
  ),
  plus: (c: string, s = 15) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke={c} strokeWidth="1.3" strokeLinecap="round">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.6" />
      <path d="M8 5.6v4.8M5.6 8h4.8" />
    </svg>
  ),
  caret: (open: boolean, c: string) => (
    <svg width="10" height="10" viewBox="0 0 10 10" fill={c} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>
      <path d="M3 1.5 7.5 5 3 8.5Z" />
    </svg>
  ),
};

function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return '刚刚';
  if (d < 3600_000) return `${Math.floor(d / 60_000)}分钟`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)}小时`;
  return `${Math.floor(d / 86400_000)}天`;
}
const sevColor = (s?: string) => s === 'critical' ? '#d64545' : s === 'warn' ? '#c9862d' : s === 'ok' ? '#3fa552' : undefined;

export function makeSidebar(ctx: any, call: (endpoint: string, payload?: unknown) => Promise<any>) {
  const T = {
    text: 'var(--dsw-alias-label-primary)',
    sub: 'var(--dsw-alias-label-secondary)',
    dim: 'var(--dsw-alias-label-tertiary)',
    hover: 'var(--dsw-alias-interactive-bg-hover)',
    border: 'var(--dsw-alias-border-l1)',
  };
  const S: Record<string, React.CSSProperties> = {
    wrap: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', color: T.text, fontSize: 14, padding: '0 12px' },
    logoRow: { display: 'flex', alignItems: 'center', gap: 7, padding: '14px 2px 10px' },
    logoText: { fontWeight: 700, fontSize: 19, letterSpacing: 0.2, color: T.text },
    pill: { fontSize: 10, fontWeight: 700, letterSpacing: 0.8, background: T.text, color: 'var(--dsw-alias-bg-layer-0, #fff)', borderRadius: 5, padding: '2.5px 6px', transform: 'translateY(1px)' },
    secRow: { display: 'flex', alignItems: 'center', gap: 4, padding: '10px 2px 6px' },
    secTitle: { fontSize: 13, color: T.dim },
    iconBtn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 6, cursor: 'pointer', color: T.dim, background: 'none', border: 'none', padding: 0 },
    scroll: { flex: 1, overflowY: 'auto' as const, paddingBottom: 12 },
    groupRow: { display: 'flex', alignItems: 'center', gap: 7, padding: '7px 6px', borderRadius: 8, cursor: 'pointer', userSelect: 'none' as const, fontWeight: 500 },
    item: { display: 'flex', alignItems: 'center', gap: 7, padding: '7px 8px 7px 10px', borderRadius: 8, cursor: 'pointer', minHeight: 20 },
    itemActive: { background: T.hover },
    itemTitle: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, fontSize: 14 },
    meta: { fontSize: 12, color: T.dim, flexShrink: 0 },
    subHead: { display: 'flex', alignItems: 'center', gap: 7, padding: '8px 6px 4px', fontSize: 14, color: T.sub },
    input: { background: 'var(--dsw-alias-bg-layer-1)', border: `1px solid var(--dsw-alias-border-l2)`, borderRadius: 8, color: T.text, padding: '5px 9px', fontSize: 13, width: '100%', boxSizing: 'border-box' as const, margin: '2px 0 6px' },
    menu: { position: 'absolute' as const, top: 0, left: 0, right: 0, zIndex: 20, background: 'var(--dsw-alias-bg-layer-1)', border: `1px solid var(--dsw-alias-border-l2)`, borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.18)', overflow: 'hidden' },
    dot: { width: 7, height: 7, borderRadius: 4, flexShrink: 0 },
  };

  function IconBtn({ title, active, onClick, children }: any) {
    const [hov, setHov] = useState(false);
    return (
      <button
        style={{ ...S.iconBtn, ...(hov || active ? { background: T.hover, color: T.sub } : {}) }}
        title={title}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        onClick={onClick}
      >{children}</button>
    );
  }

  function Row({ active, onClick, title, children }: any) {
    const [hov, setHov] = useState(false);
    return (
      <div
        style={{ ...S.item, ...(active ? S.itemActive : hov ? { background: T.hover } : {}) }}
        title={title}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        onClick={onClick}
      >{children}</div>
    );
  }

  return function HarnessSidebar() {
    const hs = useSyncExternalStore(subscribe, getState);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const [agents, setAgents] = useState<any[]>([]);
    const [sessions, setSessions] = useState<any[]>([]);
    const [tasks, setTasks] = useState<any[]>([]);
    const [nodes, setNodes] = useState<any[]>([]);
    const [pendingAcks, setPendingAcks] = useState(0);
    const [grouped, setGrouped] = useState(true);
    const [searching, setSearching] = useState(false);
    const [q, setQ] = useState('');
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
    const [showAllSessions, setShowAllSessions] = useState(false);

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
        setAgents(a.agents);
        const current = a.agents.find((x: any) => x.id === getState().agentId) ?? a.agents[0];
        if (current !== undefined && current.id !== getState().agentId) setState({ agentId: current.id, agentName: current.name });
        setSessions((await call('sessions/list', { limit: 40 })).sessions.map((s: any) => ({ ...s, agentName: undefined })));
        setTasks((await call('tasks/list', {})).tasks);
        setNodes((await call('nodes/list', {})).nodes);
        setPendingAcks((await call('approvals/list', { status: 'pending' })).approvals.length);
      } catch { /* keep last data */ }
    };
    useEffect(() => {
      void refresh();
      const t = setInterval(() => { void refresh(); }, 30_000);
      return () => clearInterval(t);
    }, []);

    const match = (s: string) => q === '' || s.toLowerCase().includes(q.toLowerCase());
    const openSession = (id: string) => { setState({ view: 'chat' }); ctx.sessions.open(id); };
    const newSession = async (agentName: string) => {
      setState({ view: 'chat' });
      try {
        const ws = await call('workspaces/find', { agentName });
        if (typeof ws.workspaceId === 'string') await ctx.workspaces.startSession(ws.workspaceId);
      } catch { /* ignore */ }
    };
    const createAgent = async () => {
      const name = newName.trim();
      if (name === '') return;
      try {
        await call('agents/create', { name });
        await ctx.workspaces.create({ path: `/var/lib/dsh/agents/${name}` }).catch(() => {});
        setCreating(false); setNewName('');
        await refresh();
      } catch { /* keep form */ }
    };

    /* 条目渲染器（会话/任务/节点通用行风格） */
    const sessionRow = (s: any) => match(s.title) && (
      <Row key={s.sessionId} title={s.title} onClick={() => openSession(s.sessionId)}>
        <span style={S.itemTitle}>{s.title}</span>
        <span style={S.meta}>{relTime(s.lastAt)}</span>
      </Row>
    );
    const taskRow = (t: any) => match(t.name) && (
      <Row key={t.id} active={hs.view === 'tasks' && hs.selectedTaskId === t.id} title={`${t.name}（${t.type}）`}
        onClick={() => setState({ view: 'tasks', selectedTaskId: t.id })}>
        <span style={S.itemTitle}>{t.name}</span>
        {t.lastRun?.status === 'running'
          ? <span style={S.meta}>运行中</span>
          : sevColor(t.lastReport?.severity) !== undefined
            ? <span style={{ ...S.dot, background: sevColor(t.lastReport?.severity) }} />
            : !t.enabled ? <span style={S.meta}>停用</span> : null}
      </Row>
    );
    const nodeRow = (n: any) => match(n.name) && (
      <Row key={n.id} active={hs.view === 'databases' && hs.selectedNodeId === n.id} title={`${n.host}:${n.port}/${n.dbname}`}
        onClick={() => setState({ view: 'databases', selectedNodeId: n.id })}>
        <span style={S.itemTitle}>{n.name}</span>
        <span style={{ ...S.dot, background: n.status === 'online' ? '#3fa552' : n.status === 'offline' ? '#d64545' : 'var(--dsw-alias-border-l2)' }} />
      </Row>
    );
    const typeHead = (icon: React.ReactNode, label: string, extra?: React.ReactNode) => (
      <div style={S.subHead}>{icon}<span>{label}</span>{extra}</div>
    );

    return (
      <div ref={wrapRef} style={S.wrap}>
        {/* 小节头：智能体 + 搜索/分类切换/新建 */}
        <div style={{ ...S.secRow, position: 'relative' }}>
          <span style={S.secTitle}>智能体</span>
          <span style={{ flex: 1 }} />
          <IconBtn title="搜索" active={searching} onClick={() => { setSearching(!searching); setQ(''); }}>{I.search('currentColor')}</IconBtn>
          <IconBtn title={grouped ? '取消按智能体分组' : '按智能体分组'} active={grouped} onClick={() => setGrouped(!grouped)}>{I.group('currentColor')}</IconBtn>
          <IconBtn title="新建智能体" onClick={() => setState({ view: 'newAgent' })}>{I.plus('currentColor')}</IconBtn>
        </div>
        {searching && <input style={S.input} autoFocus placeholder="搜索会话 / 任务 / 数据库" value={q} onChange={(e) => setQ(e.target.value)} />}
        {creating && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input style={{ ...S.input, margin: 0 }} autoFocus placeholder="智能体名称" value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void createAgent(); }} />
            <button style={{ ...S.iconBtn, width: 'auto', padding: '0 10px', border: `1px solid var(--dsw-alias-border-l2)`, color: T.text }} onClick={() => void createAgent()}>建</button>
          </div>
        )}

        <div style={S.scroll}>
          {grouped
            ? agents.map((a) => {
                const open = openGroups[a.id] ?? true;
                return (
                  <div key={a.id}>
                    <div style={S.groupRow} onClick={() => setOpenGroups({ ...openGroups, [a.id]: !open })}>
                      {I.caret(open, T.dim as string)}
                      {I.agent()}
                      <span style={S.itemTitle}>{a.name}</span>
                      {pendingAcks > 0 && a.id === hs.agentId && <span style={{ ...S.meta, background: '#c9862d', color: '#fff', borderRadius: 8, padding: '0 6px', fontSize: 11 }}>{pendingAcks}</span>}
                    </div>
                    {open && (
                      <div style={{ marginLeft: 14 }}>
                        {typeHead(I.chat(T.dim), '会话', <IconBtn title="新会话" onClick={() => void newSession(a.name)}>{I.plus('currentColor')}</IconBtn>)}
                        {(showAllSessions ? sessions : sessions.slice(0, 12)).map(sessionRow)}
                        {sessions.length > 12 && (
                          <Row onClick={() => setShowAllSessions(!showAllSessions)}>
                            <span style={{ width: 15 }} />
                            <span style={{ ...S.meta, flex: 1 }}>{showAllSessions ? '收起' : `显示全部 ${sessions.length} 条`}</span>
                          </Row>
                        )}
                        {typeHead(I.task(T.dim), '任务')}
                        {tasks.filter((t) => t.agentId === a.id).map(taskRow)}
                        {typeHead(I.db(T.dim as string, 15), '数据库')}
                        {nodes.filter((n) => n.agentId === a.id || n.agentId === undefined).map(nodeRow)}
                      </div>
                    )}
                  </div>
                );
              })
            : (
              <div>
                {typeHead(I.chat(T.dim), '会话', <IconBtn title="新会话" onClick={() => void newSession(hs.agentName)}>{I.plus('currentColor')}</IconBtn>)}
                {(showAllSessions ? sessions : sessions.slice(0, 12)).map(sessionRow)}
                {sessions.length > 12 && (
                  <Row onClick={() => setShowAllSessions(!showAllSessions)}>
                    <span style={{ width: 15 }} />
                    <span style={{ ...S.meta, flex: 1 }}>{showAllSessions ? '收起' : `显示全部 ${sessions.length} 条`}</span>
                  </Row>
                )}
                {typeHead(I.task(T.dim), '任务', pendingAcks > 0 ? <span style={{ ...S.meta, background: '#c9862d', color: '#fff', borderRadius: 8, padding: '0 6px', fontSize: 11 }}>{pendingAcks}</span> : undefined)}
                {tasks.map(taskRow)}
                {typeHead(I.db(T.dim as string, 15), '数据库')}
                {nodes.map(nodeRow)}
              </div>
            )}

        </div>

        {/* 资源：与「智能体」同级的全局入口（k8s 集群 Pod 与组件资源大盘） */}
        <div
          style={{ ...S.secRow, cursor: 'pointer', borderTop: `1px solid ${T.border}`, paddingTop: 10, ...(hs.view === 'resources' ? { background: T.hover, borderRadius: 8 } : {}) }}
          onClick={() => setState({ view: 'resources' })}
        >
          {I.chart(T.sub as string)}
          <span style={{ fontSize: 14, color: T.sub }}>资源</span>
        </div>
      </div>
    );
  };
}
