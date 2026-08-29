/**
 * opendb-harness 主区页面（user 定案：所有资源交互都在右边主区，不单开页面）：
 * 容器贴齐侧栏右缘（store.sidebarRight，随侧栏收展实时跟随），只覆盖主区。
 * 任务页 = 框架：任务列表 + 详情面板槽——不同任务对应不同插件，插件的 client 半边
 * 经 registerTaskPanel(typeKey, Panel) 注册专属 UI；未注册的类型用默认面板（运行历史+报告）。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getState, setState, subscribe, getTaskPanel, getResourcePanel, getNodePanel } from './state.ts';


export function makeOverlay(ctx: any, call: (endpoint: string, payload?: unknown) => Promise<any>) {
  const S: Record<string, React.CSSProperties> = {
    head: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 20px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
    title: { fontSize: 15, fontWeight: 600 },
    body: { flex: 1, overflow: 'auto', padding: 24 },
    btn: { background: 'var(--dsw-alias-interactive-bg-hover)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, color: 'var(--dsw-alias-label-primary)', padding: '4px 10px', fontSize: 13, cursor: 'pointer' },
    table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: 13.5 },
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

  /**
   * 默认任务面板：运行历史 + 报告 + 操作（任务插件未注册专属面板时使用）。
   * runId：从「历史」跳来时高亮那一行——没有专属大盘的类型，至少能定位到那次。
   */
  /**
   * 该任务类型的面板插件包这次是否没加载上（2026-08-26 user 报障：滚动窗口里加载的页面，两个任务面板都退化成历史列表）。
   * 看 performance 资源条目：包的请求不存在 / 非 200 / 0 字节 = 没加载上 → 自动刷新一次（sessionStorage 限 5 分钟一次，防循环）。
   */
  function pluginBundleFailed(type: string): { failed: boolean; loaded: boolean; status?: number } {
    try {
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const hit = entries.filter((e) => e.name.includes(`/plugins/@opendb-dsh/task-${type}/client.js`));
      if (hit.length === 0) return { failed: true, loaded: false };
      const last = hit[hit.length - 1] as PerformanceResourceTiming & { responseStatus?: number };
      const status = last.responseStatus;
      if (typeof status === 'number' && status !== 200) return { failed: true, loaded: false, status };
      if (last.transferSize === 0 && last.decodedBodySize === 0) return { failed: true, loaded: false };
      // 包拿到了却还是落到默认视图 = 插件初始化时抛了异常（面板没注册）。刷新解决不了，要看 console 里的报错
      return { failed: false, loaded: true, status };
    } catch { return { failed: false, loaded: false }; }
  }
  function autoReloadOnce(reason: string): boolean {
    try {
      const key = 'opendb.autoReload.at';
      const last = Number(sessionStorage.getItem(key) ?? 0);
      if (Date.now() - last < 5 * 60_000) return false;
      sessionStorage.setItem(key, String(Date.now()));
      console.warn(`[opendb-harness] ${reason}，自动刷新页面`);
      setTimeout(() => location.reload(), 1500);
      return true;
    } catch { return false; }
  }

  function DefaultTaskPanel({ task, runId }: { task: any; runId?: string }) {
    const [runs, setRuns] = useState<any[]>([]);
    const [bundle] = useState(() => pluginBundleFailed(String(task.type)));
    // 包没加载上（HTTP 非 200 / 无请求）：立刻自动刷新一次（2026-08-26 滚动窗口修复）
    const [reloading, setReloading] = useState(() => bundle.failed && autoReloadOnce(`任务类型「${String(task.type)}」的面板插件包未加载（HTTP ${bundle.status ?? '无请求'}）`));
    // 包加载了却没注册出面板：等 4s 再判——面板注册常常晚于任务页首绘（插件包异步 apply），这一拍就刷新会把正常页面刷掉
    //（2026-08-28 下午 user：过载监控/Top1 两个任务"刷不出来"，就是我把这一拍判成了故障直接 reload）。
    // 4s 后仍没注册才是"页面赶上发布窗口 / 插件初始化异常"：先自动刷一次，刷完还这样才提示看 console。
    const [stale, setStale] = useState(false);
    useEffect(() => {
      if (!bundle.loaded) return undefined;
      const t = setTimeout(() => { if (getTaskPanel(String(task.type)) === undefined) setStale(true); }, 4000);
      return () => clearTimeout(t);
    }, [task.type]);
    useEffect(() => {
      if (stale && !reloading) setReloading(autoReloadOnce(`任务类型「${String(task.type)}」的面板插件包已加载但 4s 内未注册面板`));
    }, [stale]);
    const refresh = async () => { try { setRuns((await call('runs/list', { taskId: task.id })).runs); } catch { /* retry */ } };
    useEffect(() => { void refresh(); const t = setInterval(() => void refresh(), 15_000); return () => clearInterval(t); }, [task.id]);
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <b>{task.name}</b><span style={S.dim}>{task.type} · {task.cron ?? '手动'}</span>
          <span style={{ marginLeft: 'auto', ...S.dim, fontSize: 12 }}>{task.enabled ? (task.cron ? '定时运行中' : '手动触发') : '已停用'}</span>
        </div>
        {bundle.failed ? (
          <div style={{ margin: '10px 0 0', padding: '9px 12px', borderRadius: 8, fontSize: 13, background: '#fdecec', color: '#b53434', border: '1px solid rgba(214,69,69,.25)' }}>
            <b>面板插件包没加载上</b>（{bundle.status !== undefined ? `HTTP ${bundle.status}` : '页面加载时没有拿到'}——多半是页面在服务滚动更新的窗口里打开的）。
            {reloading ? ' 正在自动刷新…' : ' '}
            <button type="button" onClick={() => location.reload()} style={{ ...S.btn, marginLeft: 8, color: '#b53434' }}>立即刷新</button>
          </div>
        ) : bundle.loaded && stale ? (
          <div style={{ margin: '10px 0 0', padding: '9px 12px', borderRadius: 8, fontSize: 13, background: '#fdecec', color: '#b53434', border: '1px solid rgba(214,69,69,.25)' }}>
            <b>面板插件包已加载，但没有注册出「{task.type}」的面板</b>
            {reloading ? '——多半是页面正赶上发布窗口加载的，正在自动刷新…' : '——已自动刷新过一次仍如此，才可能是插件初始化异常：请打开浏览器 console，把 '}
            {reloading ? null : <><code>task-{task.type}</code> 相关的报错发给开发者。<button type="button" onClick={() => location.reload()} style={{ ...S.btn, marginLeft: 8, color: '#b53434' }}>再刷新一次</button></>}
          </div>
        ) : null}
        {/*
          兜底视图的醒目标识（user 2026-08-24：「报告又没有报告了，内容和历史列表基本一致」——
          说的就是掉到这里。以前只有一行灰色小字提"当前为默认视图"，看不出是异常态）。
          该任务类型注册过专属面板才会有大盘；掉到这里通常是那个 client 插件没加载上，刷新即可。
        */}
        <div style={{
          margin: '10px 0 14px', padding: '9px 12px', borderRadius: 8, fontSize: 13,
          border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-interactive-bg-hover)',
        }}>
          <b>当前是默认视图，不是「{task.type}」的专属大盘。</b>
          <span style={{ ...S.dim, marginLeft: 6 }}>该类型的面板插件这次没加载上——刷新页面通常即可恢复；若刷新后仍是这个视图，请告诉我。</span>
        </div>
        <div style={{ ...S.dim, fontSize: 12, margin: '8px 0' }}>要调整这个任务（改周期/改策略/停用），直接在会话里告诉智能体即可。</div>
        <table style={S.table}>
          <thead><tr><th style={S.th}>时间</th><th style={S.th}>触发</th><th style={S.th}>状态</th><th style={S.th}>报告</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} style={r.id === runId ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : undefined}>
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

  /**
   * 运行中指示条（user 2026-08-23：点了立即运行要像会话等模型出结果那样有 think 反馈）。
   * 脉冲点 + 秒表，跑完由 TasksPage 的 2s 轮询自动撤下并刷新报告。
   */
  function RunningBar({ n, since }: { n: number; since: number }) {
    const [now, setNow] = useState(Date.now());
    useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(t); }, []);
    const sec = Math.max(0, Math.round((now - since) / 1000));
    const el = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, padding: '10px 14px',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10,
        background: 'var(--dsw-alias-interactive-bg-hover)', fontSize: 13.5,
      }}>
        <span className="odbPulse" style={{
          width: 8, height: 8, borderRadius: '50%', flex: 'none',
          background: 'var(--dsw-alias-label-brand, #4176e6)',
        }} />
        <span>智能体正在执行{n > 1 ? `（${n} 个运行排队中）` : ''}…</span>
        <span style={{ ...S.dim, fontVariantNumeric: 'tabular-nums' }}>已用时 {el}</span>
        <span style={{ marginLeft: 'auto', ...S.dim, fontSize: 12 }}>完成后本页自动刷出报告</span>
      </div>
    );
  }

  /** 任务运行历史（页内 tab「历史」）：只读表。onOpenReport = 跳去那一次的完整大盘。 */
  function TaskHistory({ task, onOpenReport }: { task: any; onOpenReport: (runId: string) => void }) {
    const [runs, setRuns] = useState<any[]>([]);
    useEffect(() => {
      let alive = true;
      call('runs/list', { taskId: task.id }).then((v) => { if (alive) setRuns(v?.runs ?? []); }).catch(() => {});
      return () => { alive = false; };
    }, [task.id]);
    // 任务运行会话已从侧栏隐藏（避免刷屏），这里是唯一追溯入口：排查任务为什么跑歪时点进去看模型全过程。
    const openRunSession = (sessionId: string) => {
      setState({ view: 'chat' });
      try { ctx.sessions.open(sessionId); } catch { /* 会话已被清理：退回聊天区即可 */ }
    };
    return (
      <table style={S.table}>
        <thead><tr><th style={S.th}>时间</th><th style={S.th}>触发</th><th style={S.th}>状态</th><th style={S.th}>报告</th><th style={S.th}>大盘</th><th style={S.th}>过程</th></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td style={S.td}>{String(r.firedAt).replace('T', ' ').slice(0, 19)}</td>
              <td style={S.td}><span style={S.dim}>{r.triggerKind}</span></td>
              <td style={S.td}>{r.status}{r.error ? <span style={{ color: sevColor('critical') }}> {r.error}</span> : null}</td>
              <td style={S.td}>{r.report !== undefined ? <span style={{ color: sevColor(r.report.severity) }}>{r.report.severity} · {r.report.summary}</span> : <span style={S.dim}>-</span>}</td>
              {/* 用户报障：跑过多次后历史只有一张表，进不去那一次的详细大盘 */}
              <td style={S.td}>{r.report !== undefined
                ? <span onClick={() => onOpenReport(String(r.id))}
                    style={{ cursor: 'pointer', color: 'var(--dsw-alias-label-brand, #4176e6)', whiteSpace: 'nowrap' }}>看报告 →</span>
                : <span style={S.dim}>-</span>}</td>
              <td style={S.td}>{typeof r.sessionId === 'string' && r.sessionId !== ''
                ? <span onClick={() => openRunSession(r.sessionId)}
                    style={{ cursor: 'pointer', color: 'var(--dsw-alias-label-brand, #4176e6)', whiteSpace: 'nowrap' }}>查看会话 →</span>
                : <span style={S.dim}>-</span>}</td>
            </tr>
          ))}
          {runs.length === 0 && <tr><td style={S.td} colSpan={6}><span style={S.dim}>还没有运行记录</span></td></tr>}
        </tbody>
      </table>
    );
  }

  /** 任务配置（页内 tab「配置」）：只读展示——调整在会话里说一句即可（交互纲领） */
  function TaskConfig({ task }: { task: any }) {
    return (
      <div style={{ maxWidth: 640 }}>
        <div style={{ ...S.dim, fontSize: 13.5, marginBottom: 10 }}>只读展示——要调整（改周期/改范围/停用），在会话里对智能体说一句即可，这里没有编辑按钮（交互纲领 §15）。</div>
        <table style={S.table}>
          <tbody>
            <tr><td style={{ ...S.td, width: 110, color: 'var(--dsw-alias-label-tertiary)' }}>类型</td><td style={S.td}>{task.type}</td></tr>
            <tr><td style={{ ...S.td, color: 'var(--dsw-alias-label-tertiary)' }}>调度</td><td style={S.td}>{task.cron ?? '手动触发'}</td></tr>
            <tr><td style={{ ...S.td, color: 'var(--dsw-alias-label-tertiary)' }}>状态</td><td style={S.td}>{task.enabled ? '启用' : '停用'}</td></tr>
            <tr><td style={{ ...S.td, color: 'var(--dsw-alias-label-tertiary)' }}>配置</td><td style={S.td}><pre style={{ margin: 0, font: '12px/1.7 "JetBrains Mono",Menlo,monospace', background: 'var(--dsw-alias-interactive-bg-hover)', borderRadius: 10, padding: '12px 14px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{JSON.stringify(task.config ?? {}, null, 2)}</pre></td></tr>
          </tbody>
        </table>
      </div>
    );
  }

  /**
   * 任务页 = 全宽任务大盘（2026-08-22 user：工作区侧栏已有任务列表，主区不再重复列表）。
   * dsh 式页头（大标题 + meta）+ 文字 tab（报告/历史/配置，蓝下划线）——与 R4 设计稿一致。
   */
  function TasksPage() {
    // 订阅整个 store：selectedTaskId 之外还要读 selectedRunId（「历史」跳过来指定的那次运行）
    const hs = useSyncExternalStore(subscribe, getState);
    const [tasks, setTasks] = useState<any[]>([]);
    const [tab, setTab] = useState<'report' | 'history' | 'config'>('report');
    // busy：正在飞的操作 key。空串=空闲。按钮据此禁用——2026-08-23 user 报障根因：
    // act 是 async 但按钮无任何 pending 反馈，连点 14 次落了 14 条 run（maxConcurrent=2 → 6 条跑到超时）。
    const [busy, setBusy] = useState('');
    // live：该任务当前 queued/running 的运行（thinking 态数据源）
    const [live, setLive] = useState<{ n: number; since: number } | null>(null);
    // liveRef：轮询闭包读不到最新 live（也读不到「乐观点亮」写入的值），用 ref 做真相
    const liveRef = useRef(false);
    const selected = hs.selectedTaskId;
    const refresh = async () => {
      try {
        setTasks((await call('tasks/list', {})).tasks);
      } catch { /* retry next poll */ }
    };
    useEffect(() => { void refresh(); const t = setInterval(() => void refresh(), 20_000); return () => clearInterval(t); }, []);
    const task = tasks.find((t) => t.id === selected) ?? tasks[0];
    // 换任务时回到「报告 · 最新」——否则会拿着上一个任务的 runId 去查这个任务
    useEffect(() => { setTab('report'); setState({ selectedRunId: '' }); }, [task?.id]);
    // 运行态 2s 轮询：有在跑的 run 就亮 thinking 条，跑完自动熄灭并刷新报告（user：要像会话等模型那样有反馈）
    const taskId = task?.id;
    useEffect(() => {
      if (taskId === undefined) return;
      let alive = true;
      const poll = async () => {
        try {
          const rs: any[] = (await call('runs/list', { taskId })).runs ?? [];
          if (!alive) return;
          const act = rs.filter((r) => r.status === 'queued' || r.status === 'running');
          if (act.length > 0) {
            const ts = act.map((r) => Date.parse(r.firedAt ?? '') || Date.now());
            setLive({ n: act.length, since: Math.min(...ts) });
            liveRef.current = true;
          } else {
            setLive(null);
            if (liveRef.current) { liveRef.current = false; void refresh(); }   // 刚跑完：拉一次最新报告
          }
        } catch { /* 轮询失败保持上次状态 */ }
      };
      void poll();
      const t = setInterval(() => void poll(), 2_000);
      return () => { alive = false; clearInterval(t); };
    }, [taskId]);
    if (tasks.length === 0) return <Empty icon="▤" title="还没有任务" hint="在会话里说一句就能建，例如「每天早上八点巡检所有节点」" />;
    if (task === undefined) return null;
    const Panel = getTaskPanel(task.type) ?? DefaultTaskPanel;
    /**
     * 任务操作区（2026-08-22 user：dsh 的会话内长任务有暂停/删除/修改交互，我们也要有）。
     * 走 ui-opendb 既有 RPC：tasks/update（启停）、tasks/runNow（立即执行）、tasks/remove（删除）。
     * 「修改」仍在会话里说（纲领：策略变更靠对话），这里只放三个不可含糊的动作。
     */
    const act = async (key: string, fn: () => Promise<unknown>, confirmText?: string) => {
      if (busy !== '') return;                                  // 状态锁：飞行中的操作未回来，后续点击一律吞掉
      if (confirmText !== undefined && !window.confirm(confirmText)) return;
      setBusy(key);
      try { await fn(); } catch (e) { window.alert(String((e as Error)?.message ?? e)); }
      finally { setBusy(''); }
      await refresh();
    };
    /**
     * 操作按钮：飞行期间整组禁用，当事按钮换成进行时文案。
     * hold=额外锁（「立即运行」传 live!==null）——runNow 的 RPC 只是入队，90ms 就返回，
     * 光靠 busy 挡不住连点；真正的闸门是"还有 run 在跑就不许再发"。
     */
    const opBtn = (key: string, label: string, busyLabel: string, onClick: () => void, danger = false, hold = false) => {
      const locked = busy !== '' || hold;
      return (
        <button
          disabled={locked}
          style={{
            ...S.btn,
            ...(danger ? { color: 'var(--dsw-alias-state-error-primary)' } : {}),
            ...(locked ? { opacity: 0.45, cursor: 'default' } : {}),
          }}
          onClick={onClick}
        >{busy === key ? busyLabel : label}</button>
      );
    };
    const pt = (key: 'report' | 'history' | 'config', label: string) => (
      <span onClick={() => setTab(key)} style={{
        fontSize: 15, cursor: 'pointer', padding: '4px 1px 9px', borderBottom: `2px solid ${tab === key ? 'var(--dsw-alias-label-brand, #4176e6)' : 'transparent'}`,
        color: tab === key ? 'var(--dsw-alias-label-brand, #4176e6)' : 'var(--dsw-alias-label-secondary)', fontWeight: tab === key ? 500 : 400,
      }}>{label}</span>
    );
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 18, fontWeight: 600 }}>{task.name}</span>
          <span style={{ ...S.dim, fontSize: 13.5 }}>
            任务 · {task.cron ?? '手动触发'} · {task.enabled ? '启用' : '停用'}
            {task.lastReport !== undefined ? <span> · 最近 <span style={{ color: sevColor(task.lastReport.severity) }}>{task.lastReport.severity}</span></span> : null}
            {' '}· 调整周期或范围，在会话里说一句即可
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {opBtn('run', live !== null ? '● 运行中' : '▶ 立即运行', '提交中…',
              () => void act('run', async () => {
                await call('tasks/runNow', { id: task.id });
                // 乐观点亮：不等 2s 轮询，松手即锁 + 即刻出 thinking 条；ref 同步置位，
                // 否则 run 秒完时轮询判不出"从有到无"，报告不会自动刷出来
                liveRef.current = true;
                setLive({ n: 1, since: Date.now() });
              }), false, live !== null)}
            {opBtn('toggle', task.enabled ? '⏸ 暂停' : '▶ 启用', '处理中…',
              () => void act('toggle', () => call('tasks/update', { id: task.id, patch: { enabled: !task.enabled } })))}
            {opBtn('del', '🗑 删除', '删除中…',
              () => void act('del', () => call('tasks/remove', { id: task.id }), `确认删除任务「${task.name}」？其运行记录与报告一并删除，不可恢复。`), true)}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 22, borderBottom: '1px solid var(--dsw-alias-border-l1)', margin: '10px 0 20px' }}>
          {pt('report', '报告')}{pt('history', '历史')}{pt('config', '配置')}
        </div>
        {live !== null && <RunningBar n={live.n} since={live.since} />}
        {tab === 'report' && hs.selectedRunId !== '' && (
          <div style={{ ...S.dim, fontSize: 13, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>正在看历史某次运行的报告</span>
            <span onClick={() => setState({ selectedRunId: '' })}
              style={{ cursor: 'pointer', color: 'var(--dsw-alias-label-brand, #4176e6)' }}>回到最新 →</span>
          </div>
        )}
        {tab === 'report'
          ? <Panel task={task} runId={hs.selectedRunId} call={call} />
          : tab === 'history'
            ? <TaskHistory task={task} onOpenReport={(runId) => { setState({ selectedRunId: runId }); setTab('report'); }} />
            : <TaskConfig task={task} />}
      </div>
    );
  }

  /** 24h 趋势折线（自绘 SVG，无图表库；纲领：大盘只展示不交互）。面积渐变 + 弱网格 + 端点强调。 */
  function Sparkline({ points, color, height = 56, fmt }: { points: { t: number; v: number }[]; color: string; height?: number; fmt?: (v: number) => string }) {
    const W = 260;
    if (points.length === 0) return <div style={{ ...S.dim, fontSize: 12, height, display: 'flex', alignItems: 'center' }}>暂无数据</div>;
    const vs = points.map((p) => p.v);
    const min = Math.min(...vs);
    const max = Math.max(...vs);
    const span = max - min || 1;
    const px = (i: number) => (i / Math.max(points.length - 1, 1)) * (W - 8) + 4;
    const py = (v: number) => height - 8 - ((v - min) / span) * (height - 20) + 4;
    const xy = points.map((p, i) => `${px(i)},${py(p.v)}`);
    const last = points[points.length - 1];
    const gid = `sg-${color.replace(/[^a-zA-Z0-9]/g, '')}-${height}`;
    return (
      <div>
        <svg width={W} height={height} style={{ display: 'block' }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={color} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {[0.5].map((f) => (
            <line key={f} x1="4" y1={py(min + span * f)} x2={W - 4} y2={py(min + span * f)} stroke="var(--dsw-alias-border-l1)" strokeWidth="1" strokeDasharray="3 4" />
          ))}
          <line x1="4" y1={height - 4} x2={W - 4} y2={height - 4} stroke="var(--dsw-alias-border-l1)" strokeWidth="1" />
          <polygon points={`4,${height - 4} ${xy.join(' ')} ${W - 4},${height - 4}`} fill={`url(#${gid})`} />
          <polyline points={xy.join(' ')} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={px(points.length - 1)} cy={py(last.v)} r="2.8" fill={color} />
        </svg>
        <div style={{ ...S.dim, fontSize: 12, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
          当前 <span style={{ color: 'var(--dsw-alias-label-primary)', fontWeight: 600 }}>{fmt ? fmt(last.v) : Math.round(last.v * 100) / 100}</span>
          <span style={{ margin: '0 4px' }}>·</span>区间 {fmt ? `${fmt(min)}~${fmt(max)}` : `${Math.round(min * 100) / 100}~${Math.round(max * 100) / 100}`}
        </div>
      </div>
    );
  }

  /** 统一空态（视觉集中优化）：居中、留白、主/副文案两级。 */
  function Empty({ icon, title, hint }: { icon?: string; title: string; hint?: string }) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--dsw-alias-label-tertiary)' }}>
        {icon !== undefined && <div style={{ fontSize: 26, marginBottom: 10, opacity: 0.5 }}>{icon}</div>}
        <div style={{ fontSize: 14, color: 'var(--dsw-alias-label-secondary)' }}>{title}</div>
        {hint !== undefined && <div style={{ fontSize: 12.5, marginTop: 6 }}>{hint}</div>}
      </div>
    );
  }

  /** 节点监控详情：最新指标卡 + 24h 趋势 + 字典变更流（数据 nodes/detail）。 */
  function NodeDetail({ nodeId }: { nodeId: string }) {
    const [d, setD] = useState<any>(null);
    const [err, setErr] = useState('');
    const refresh = async () => {
      try { setD(await call('nodes/detail', { nodeId })); setErr(''); } catch (e) { setErr(String((e as Error).message ?? e)); }
    };
    useEffect(() => { setD(null); void refresh(); const t = setInterval(() => void refresh(), 60_000); return () => clearInterval(t); }, [nodeId]);
    if (err !== '') return <div style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 }}>{err}</div>;
    if (d === null) return <div style={S.dim}>加载中…</div>;
    const { node, latest, series, dictChanges } = d;
    const lv = (m: string) => latest.find((x: any) => x.metric === m)?.value;
    const sizeEntries = latest.filter((x: any) => x.metric.startsWith('db.size_bytes.'));
    const totalSize = sizeEntries.reduce((s: number, x: any) => s + x.value, 0);
    const fmtBytes = (b: number) => b > 1 << 30 ? `${(b / (1 << 30)).toFixed(1)}GB` : b > 1 << 20 ? `${(b / (1 << 20)).toFixed(1)}MB` : `${Math.round(b / 1024)}KB`;
    const statCard = (label: string, value: React.ReactNode) => (
      <div style={{ ...S.card, minWidth: 130, padding: '10px 14px' }}>
        <div style={{ ...S.dim, fontSize: 12 }}>{label}</div>
        <div style={{ fontSize: 20, fontWeight: 600, marginTop: 2 }}>{value}</div>
      </div>
    );
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span style={{ color: node.status === 'online' ? '#3fa552' : 'var(--dsw-alias-state-error-primary)', fontSize: 12 }}>●</span>
          <b style={{ fontSize: 16 }}>{node.name}</b>
          <span style={S.dim}>{node.engine} · {node.host}:{node.port}/{node.dbname} · {node.status}</span>
        </div>
        <div style={{ ...S.cards, marginBottom: 18 }}>
          {statCard('活跃会话', lv('db.sessions.active') ?? '-')}
          {statCard('空闲会话', lv('db.sessions.idle') ?? '-')}
          {statCard('等待锁', lv('db.waiting_locks') ?? '-')}
          {statCard('连接使用率', lv('db.connections_used_ratio') !== undefined ? `${(lv('db.connections_used_ratio') * 100).toFixed(1)}%` : '-')}
          {statCard('库总大小', totalSize > 0 ? fmtBytes(totalSize) : '-')}
        </div>
        <div style={S.h2}>24 小时趋势（15 分钟均值）</div>
        <div style={S.cards}>
          <div style={S.card}><div style={{ ...S.dim, fontSize: 12, marginBottom: 6 }}>活跃会话</div><Sparkline points={series['db.sessions.active'] ?? []} color="#4D6BFE" /></div>
          <div style={S.card}><div style={{ ...S.dim, fontSize: 12, marginBottom: 6 }}>等待锁</div><Sparkline points={series['db.waiting_locks'] ?? []} color="#c9862d" /></div>
          <div style={S.card}><div style={{ ...S.dim, fontSize: 12, marginBottom: 6 }}>连接使用率</div><Sparkline points={series['db.connections_used_ratio'] ?? []} color="#3fa552" fmt={(v) => `${(v * 100).toFixed(1)}%`} /></div>
        </div>
        <div style={S.h2}>数据字典变更（近 7 天）</div>
        <table style={S.table}>
          <thead><tr><th style={S.th}>时间</th><th style={S.th}>变更</th><th style={S.th}>类型</th><th style={S.th}>对象</th></tr></thead>
          <tbody>
            {dictChanges.map((c: any, i: number) => (
              <tr key={i}>
                <td style={S.td}>{String(c.time).replace('T', ' ').slice(0, 16)}</td>
                <td style={S.td}><span style={{ color: c.change === 'removed' ? 'var(--dsw-alias-state-error-primary)' : c.change === 'added' ? '#3fa552' : '#c9862d' }}>{c.change}</span></td>
                <td style={S.td}><span style={S.dim}>{c.kind}</span></td>
                <td style={S.td}>{c.object}</td>
              </tr>
            ))}
            {dictChanges.length === 0 && <tr><td style={S.td} colSpan={4}><span style={S.dim}>近 7 天没有结构变更</span></td></tr>}
          </tbody>
        </table>
      </div>
    );
  }

  /** 数据库页（W6 规模适配：950 节点用 统计条+搜索+过滤+表格，不再铺卡片）。 */
  function DatabasesPage() {
    const hs = useSyncExternalStore(subscribe, getState);
    const [nodes, setNodes] = useState<any[]>([]);
    const [q, setQ] = useState('');
    const [st, setSt] = useState('all');
    const [limit, setLimit] = useState(50);
    const refresh = async () => { try { setNodes((await call('nodes/list', {})).nodes); } catch { /* retry */ } };
    useEffect(() => { void refresh(); const t = setInterval(() => void refresh(), 20_000); return () => clearInterval(t); }, []);
    if (hs.selectedNodeId !== '' && nodes.some((n) => n.id === hs.selectedNodeId)) {
      // W6 拆包：优先 ui-node-monitor 插件注册的面板；内置实现保留为降级备用
      const Panel = getNodePanel() ?? NodeDetail;
      return (
        <div>
          <div style={{ marginBottom: 12 }}>
            <span style={{ ...S.dim, fontSize: 13, cursor: 'pointer' }} onClick={() => setState({ selectedNodeId: '' })}>← 节点列表</span>
          </div>
          <Panel nodeId={hs.selectedNodeId} />
        </div>
      );
    }
    const counts = { online: 0, offline: 0, other: 0 };
    for (const n of nodes) (counts as any)[n.status === 'online' ? 'online' : n.status === 'offline' ? 'offline' : 'other'] += 1;
    const filtered = nodes.filter((n) =>
      (st === 'all' || n.status === st)
      && (q === '' || n.name.includes(q) || `${n.host}:${n.port}`.includes(q)));
    const shown = filtered.slice(0, limit);
    const statChip = (label: string, value: number, color?: string) => (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
        {color !== undefined && <span style={{ width: 8, height: 8, borderRadius: 4, background: color, display: 'inline-block' }} />}
        <span style={S.dim}>{label}</span>
        <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      </div>
    );
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 14, flexWrap: 'wrap' }}>
          {statChip('节点', nodes.length)}
          {statChip('在线', counts.online, '#3fa552')}
          {statChip('离线', counts.offline, 'var(--dsw-alias-state-error-primary)')}
          {counts.other > 0 && statChip('其它', counts.other, 'var(--dsw-alias-label-tertiary)')}
          <span style={{ flex: 1 }} />
          <select style={{ ...S.input, padding: '5px 8px' }} value={st} onChange={(e) => { setSt(e.target.value); setLimit(50); }}>
            <option value="all">全部状态</option>
            <option value="online">在线</option>
            <option value="offline">离线</option>
          </select>
          <input style={{ ...S.input, width: 200 }} placeholder="搜索名称 / 地址" value={q} onChange={(e) => { setQ(e.target.value); setLimit(50); }} />
        </div>
        {nodes.length === 0
          ? <Empty icon="◫" title="还没有数据库节点" hint="在会话里让智能体登记，或去 设置 → OpenDB 添加" />
          : (
            <div>
              <table style={S.table} className="odbTable">
                <thead><tr><th style={S.th}>节点</th><th style={S.th}>引擎</th><th style={S.th}>地址</th><th style={{ ...S.th, width: 90 }}>状态</th></tr></thead>
                <tbody>
                  {shown.map((n) => (
                    <tr key={n.id} style={{ cursor: 'pointer' }} onClick={() => setState({ selectedNodeId: n.id })}>
                      <td style={{ ...S.td, fontWeight: 500 }}>{n.name}</td>
                      <td style={S.td}><span style={S.dim}>{n.engine}</span></td>
                      <td style={{ ...S.td, fontVariantNumeric: 'tabular-nums' }}><span style={S.dim}>{n.host}:{n.port}/{n.dbname}</span></td>
                      <td style={S.td}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ width: 7, height: 7, borderRadius: 4, background: n.status === 'online' ? '#3fa552' : n.status === 'offline' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)', display: 'inline-block' }} />
                          <span style={{ fontSize: 12.5 }}>{n.status}</span>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                <span style={{ ...S.dim, fontSize: 12.5 }}>显示 {shown.length} / 匹配 {filtered.length}</span>
                {filtered.length > shown.length && (
                  <span style={{ fontSize: 12.5, color: '#4D6BFE', cursor: 'pointer' }} onClick={() => setLimit(limit + 200)}>显示更多</span>
                )}
              </div>
            </div>
          )}
      </div>
    );
  }

  function ResourcesPage() {
    const Panel = getResourcePanel();
    if (Panel !== undefined) return <Panel />;
    const [agents, setAgents] = useState<any[]>([]);
    useEffect(() => { void call('agents/list', {}).then((a) => setAgents(a.agents)).catch(() => {}); }, []);
    return (
      <div>
        <div style={S.h2}>资源大盘（全局）—— 当前 k8s 集群各 Pod 与组件的资源与状态（实时拓扑/模型用量下一批上线）</div>
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
          {hs.view !== 'resources' && <span style={S.dim}>agent：{hs.agentName || '…'}</span>}
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
