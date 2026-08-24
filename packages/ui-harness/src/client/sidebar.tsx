/**
 * opendb-harness 侧栏 —— 全面继承 dsh 原版视觉（prd/ 两张对照截图定稿）。
 *
 * 2026-08-24 user 定案：**对外不暴露「智能体」概念**（客户不需要知道有几个智能体，
 * 也不需要知道哪个库挂在哪个智能体下）。小节头改称「工作区」，智能体那层分组整个撤掉，
 * 会话 / 任务 / 数据库升为三个平级一级菜单，各自可折叠、图标统一 dsh 蓝。
 * 每行右侧 hover 出三点菜单（对齐 dsh 原生 menu.archiveSession）：
 * 会话→归档会话（走 dsh 原生 ctx.workspaces.archiveSession），任务→归档任务
 * （opendb_archived_tasks 旁路表），数据库无菜单。
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
  dots: (c: string, s = 15) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill={c}>
      <circle cx="8" cy="3.4" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="8" cy="12.6" r="1.3" />
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
    // 行尾三点弹出的操作菜单：贴右缘、压在下一行之上
    rowMenu: {
      position: 'absolute' as const, top: '100%', right: 4, zIndex: 30, minWidth: 116,
      background: 'var(--dsw-alias-bg-layer-1)', border: `1px solid var(--dsw-alias-border-l2)`,
      borderRadius: 10, boxShadow: '0 6px 20px rgba(0,0,0,.16)', overflow: 'hidden', padding: 4,
    },
    rowMenuItem: { padding: '7px 10px', fontSize: 13.5, borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap' as const },
    // 一级菜单头（会话/任务/数据库）——蓝图标 + caret，整行可点折叠
    secHead: {
      display: 'flex', alignItems: 'center', gap: 7, padding: '7px 6px', borderRadius: 8,
      cursor: 'pointer', userSelect: 'none' as const, fontWeight: 500, fontSize: 14,
    },
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

  /**
   * 列表行——官方 sessionRow 同款：hover 走纯 CSS（.odbRow:hover），无 JS 状态、无持久选中高亮。
   * menu：可选的三点操作菜单项（对齐 dsh 原生行尾隐藏菜单）。三点常驻 DOM、靠 CSS 控透明度，
   * 不做条件渲染——条件渲染会让指针移到三点上的瞬间行 hover 抖动。
   */
  function Row({ onClick, title, children, menu, menuOpen, onMenuToggle }: any) {
    const hasMenu = Array.isArray(menu) && menu.length > 0;
    return (
      <div className="odbRow" title={title} onClick={onClick} style={{ position: 'relative' }}>
        {children}
        {hasMenu && (
          <span
            className="odbDots"
            style={{ ...S.iconBtn, width: 20, height: 20, flexShrink: 0, marginLeft: 2, ...(menuOpen ? { background: T.hover, opacity: 1 } : {}) }}
            onClick={(e) => { e.stopPropagation(); onMenuToggle(); }}
          >{I.dots('currentColor')}</span>
        )}
        {hasMenu && menuOpen && (
          <div style={S.rowMenu} onClick={(e) => e.stopPropagation()}>
            {menu.map((m: any) => (
              <div key={m.label} className="odbMenuItem" style={S.rowMenuItem}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); m.onSelect(); }}>
                {m.label}
              </div>
            ))}
          </div>
        )}
      </div>
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
    const [searching, setSearching] = useState(false);
    const [q, setQ] = useState('');
    const [showAllSessions, setShowAllSessions] = useState(false);
    // 三个一级菜单各自的折叠态（user 2026-08-24：三个都要能折叠），默认全展开
    const [open, setOpen] = useState<Record<'chat' | 'task' | 'db', boolean>>({ chat: true, task: true, db: true });
    // 行尾三点菜单：同一时刻只开一个，key = `${kind}:${id}`
    const [menuFor, setMenuFor] = useState<string | null>(null);

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
    // 点空白处关掉三点菜单（捕获阶段：行自身的 onClick 不该顺带把菜单关了又开）
    useEffect(() => {
      if (menuFor === null) return;
      const close = () => setMenuFor(null);
      document.addEventListener('mousedown', close);
      return () => document.removeEventListener('mousedown', close);
    }, [menuFor]);

    const match = (s: string) => q === '' || s.toLowerCase().includes(q.toLowerCase());
    const openSession = (id: string) => { setState({ view: 'chat' }); ctx.sessions.open(id); };
    // 归档项不占列表（归档≠删除：会话在 dsh registry 里留着，任务照常按 cron 跑）。
    // 会话的归档判定在后端 sessions/list 完成，这里只兜任务。
    const visibleSessions = sessions;
    const visibleTasks = tasks.filter((t) => t.archived !== true);

    // P2 W3：内容全文检索（session-query-pg 通道）——标题过滤之外，搜历史会话正文；400ms 防抖
    const [contentHits, setContentHits] = useState<any[]>([]);
    useEffect(() => {
      if (q.trim().length < 2) { setContentHits([]); return; }
      const t = setTimeout(() => {
        void ctx.connection.rpc.call('/opendb-sessions', 'search', { query: q })
          .then((r: any) => { if (r.ok) setContentHits(r.value.sessions); })
          .catch(() => {});
      }, 400);
      return () => clearTimeout(t);
    }, [q]);
    const newSession = async (agentName: string) => {
      setState({ view: 'chat' });
      try {
        const ws = await call('workspaces/find', { agentName });
        if (typeof ws.workspaceId === 'string') await ctx.workspaces.startSession(ws.workspaceId);
      } catch { /* ignore */ }
    };
    // createAgent 已随「智能体」概念一并撤下（user 2026-08-24）：新建智能体是运维动作，
    // 不该出现在面向客户的侧栏；agents 仍在内部拉取，只为解析当前 agentName（建会话要用）。

    /**
     * 归档会话：走 dsh 原生 ctx.workspaces.archiveSession（registry-global 归档集，
     * 不动 workspace accounting）。归档结果由后端 sessions/list 过滤——原生把归档集暴露成
     * 组件内 useWorkspaces store，ctx.workspaces 上并没有该属性，前端读不到。
     * 失败不再静默吞：原生同样 .catch 上报，吞掉会让「点了没反应」无从查起。
     */
    const archiveSession = async (sessionId: string) => {
      setMenuFor(null);
      // 乐观移除：等 refresh 往返再消失会有一拍延迟，手感像没响应
      setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
      try {
        await ctx.workspaces.archiveSession(sessionId);
      } catch (cause) {
        // eslint-disable-next-line no-console
        console.error('[ui-harness] 归档会话失败:', cause);
        window.alert(`归档会话失败：${String((cause as Error)?.message ?? cause)}`);
      }
      await refresh();
    };
    /** 归档任务：opendb 自有概念，走旁路表；归档 ≠ 停用，任务照常按 cron 跑，只是不占侧栏。 */
    const archiveTask = async (id: string) => {
      setMenuFor(null);
      try { await call('tasks/archive', { id }); } catch { /* 忽略：下轮轮询自愈 */ }
      await refresh();
    };

    /* 条目渲染器（会话/任务/节点通用行风格） */
    const sessionRow = (s: any) => match(s.title) && (
      <Row key={s.sessionId} title={s.title} onClick={() => openSession(s.sessionId)}
        menu={[{ label: '归档会话', onSelect: () => void archiveSession(s.sessionId) }]}
        menuOpen={menuFor === `s:${s.sessionId}`}
        onMenuToggle={() => setMenuFor(menuFor === `s:${s.sessionId}` ? null : `s:${s.sessionId}`)}>
        <span className="odbTitle">{s.title}</span>
        <span className="odbTime">{relTime(s.lastAt)}</span>
      </Row>
    );
    const taskRow = (t: any) => match(t.name) && (
      <Row key={t.id} title={`${t.name}（${t.type}）`}
        onClick={() => setState({ view: 'tasks', selectedTaskId: t.id })}
        menu={[{ label: '归档任务', onSelect: () => void archiveTask(t.id) }]}
        menuOpen={menuFor === `t:${t.id}`}
        onMenuToggle={() => setMenuFor(menuFor === `t:${t.id}` ? null : `t:${t.id}`)}>
        <span className="odbTitle">{t.name}</span>
        {t.lastRun?.status === 'running'
          ? <span className="odbTime">运行中</span>
          : sevColor(t.lastReport?.severity) !== undefined
            ? <span style={{ ...S.dot, background: sevColor(t.lastReport?.severity) }} />
            : !t.enabled ? <span className="odbTime">停用</span> : null}
      </Row>
    );
    const nodeRow = (n: any) => match(n.name) && (
      <Row key={n.id} title={`${n.host}:${n.port}/${n.dbname}`}
        onClick={() => setState({ view: 'databases', selectedNodeId: n.id })}>
        <span className="odbTitle">{n.name}</span>
        <span style={{ ...S.dot, background: n.status === 'online' ? '#3fa552' : n.status === 'offline' ? '#d64545' : 'var(--dsw-alias-border-l2)' }} />
      </Row>
    );
    /** W6 规模适配：侧栏节点列表限量（950 节点不可平铺）——前 8 个 + 汇总行进数据库页。 */
    const nodeRows = (list: any[]) => {
      const matched = q === '' ? list : list.filter((n) => n.name.includes(q));
      const head = matched.slice(0, 8);
      return (
        <div>
          {head.map(nodeRow)}
          {matched.length > head.length && (
            <Row onClick={() => setState({ view: 'databases', selectedNodeId: '' })}>
              <span style={{ ...S.meta, flex: 1 }}>共 {matched.length} 个节点，去数据库页查看</span>
            </Row>
          )}
        </div>
      );
    };
    /**
     * 一级菜单头：蓝图标 + 名称 + 计数，整行点击折叠。
     * 无 caret——对齐原生 dsh 工作区分组（prd/004.png）：图标本身就占最左那格，
     * 不额外让出箭头位（user 2026-08-24 定）。折叠仍然可用，只是不做箭头指示。
     * extra 里的按钮自行 stopPropagation，避免点它把分区折叠了。
     */
    const secHead = (key: 'chat' | 'task' | 'db', icon: React.ReactNode, label: string, count: number, extra?: React.ReactNode) => (
      <div className="odbRow" style={S.secHead} onClick={() => setOpen({ ...open, [key]: !open[key] })}>
        {icon}
        <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
        {count > 0 && <span style={S.meta}>{count}</span>}
        {extra}
      </div>
    );
    /**
     * 条目缩进容器：让列表项文字与分组标题文字左对齐，不贴侧栏左缘（原生同款层级感）。
     * 16 = 分组行文字起点(6 padding + 15 icon + 7 gap = 28) − 条目文字起点(8 padding + 4 title margin = 12)。
     */
    const indent = (children: React.ReactNode) => <div style={{ paddingLeft: 16 }}>{children}</div>;

    return (
      <div ref={wrapRef} style={S.wrap}>
        {/* 小节头：工作区（user 2026-08-24：对外不提「智能体」，分组切换/新建智能体一并撤掉） */}
        <div style={{ ...S.secRow, position: 'relative' }}>
          <span style={S.secTitle}>工作区</span>
          <span style={{ flex: 1 }} />
          <IconBtn title="搜索" active={searching} onClick={() => { setSearching(!searching); setQ(''); }}>{I.search('currentColor')}</IconBtn>
        </div>
        {searching && <input style={S.input} autoFocus placeholder="搜索会话 / 任务 / 数据库" value={q} onChange={(e) => setQ(e.target.value)} />}
        {searching && contentHits.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <div style={S.subHead}><span>内容命中（{contentHits.length}）</span></div>
            {contentHits.map((h) => (
              <Row key={h.sessionId} title={h.excerpt} onClick={() => openSession(h.sessionId)}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="odbTitle">{h.title}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.excerpt}</div>
                </div>
                <span className="odbTime">{h.hits} 处</span>
              </Row>
            ))}
          </div>
        )}
        <div style={S.scroll}>
          {/* 三个平级一级菜单：会话 / 任务 / 数据库（智能体那层已撤，见文件头注释） */}
          {/* 不放「新建」按钮：顶部已有「新会话」，重复入口（user 2026-08-24） */}
          {secHead('chat', I.chat(BLUE), '会话', visibleSessions.length)}
          {open.chat && indent(
            <>
              {(showAllSessions ? visibleSessions : visibleSessions.slice(0, 12)).map(sessionRow)}
              {visibleSessions.length > 12 && (
                <Row onClick={() => setShowAllSessions(!showAllSessions)}>
                  <span style={{ ...S.meta, flex: 1 }}>{showAllSessions ? '收起' : `展开其余 ${visibleSessions.length - 12} 个会话`}</span>
                </Row>
              )}
              {visibleSessions.length === 0 && (
                <Row><span style={{ ...S.meta, flex: 1 }}>还没有会话</span></Row>
              )}
            </>,
          )}

          {secHead('task', I.task(BLUE), '任务', visibleTasks.length,
            pendingAcks > 0 ? <span style={{ ...S.meta, background: '#c9862d', color: '#fff', borderRadius: 8, padding: '0 6px', fontSize: 11 }}>{pendingAcks}</span> : undefined)}
          {open.task && indent(
            <>
              {visibleTasks.map(taskRow)}
              {visibleTasks.length === 0 && (
                <Row><span style={{ ...S.meta, flex: 1 }}>还没有任务</span></Row>
              )}
            </>,
          )}

          {secHead('db', I.db(BLUE, 15), '数据库', nodes.length)}
          {open.db && indent(nodeRows(nodes))}
        </div>

        {/* 资源：与「智能体」同级的全局入口——交互与列表条目一致（hover 反馈 + 紧凑圆角选中态） */}
        <div style={{ paddingTop: 4, paddingBottom: 2 }}>
          <Row onClick={() => setState({ view: 'resources' })}>
            {I.chart(T.sub as string)}
            <span className="odbTitle">资源</span>
          </Row>
        </div>
      </div>
    );
  };
}
