/**
 * opendb-harness 前端壳（W5.5）：
 * - 替换 sidebar.workspaces hole → HarnessSidebar
 * - shell.overlay → HarnessMain（主区页面，贴齐侧栏右缘——user 定案：不单开全屏页）
 * - 品牌接管：document.title + 纯 CSS 覆盖左上角字标（绝不改 React 管理的 DOM——
 *   innerHTML 替换曾令 React reconcile 崩溃整页白屏，W5.5 事故）
 * - ErrorBoundary 包裹自研组件：我们的 UI bug 最多空白自身区域，不炸整页
 * - 导出 registerTaskPanel：任务类型插件的 client 半边注册专属面板
 */
import { Component, type ReactNode } from 'react';
import { makeSidebar } from './sidebar.tsx';
import { makeOverlay } from './overlay.tsx';
import { startQueueSync, currentSessionId } from './queue-sync.ts';
import { getState, setState } from './state.ts';

/** 构建期由 build-client.mjs 从根 package.json 注入（esbuild define）；类型检查时只需声明 */
declare const __OPENDB_VERSION__: string;
const VERSION: string = typeof __OPENDB_VERSION__ === 'string' ? __OPENDB_VERSION__ : '0.0.0';

export { registerTaskPanel } from './state.ts';

export const inject = ['connection', 'slots', 'workspaces', 'sessions'];

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: unknown): void {
    // eslint-disable-next-line no-console
    console.error('[ui-harness] component crashed:', error);
  }
  render(): ReactNode {
    if (this.state.failed) return <div style={{ padding: 8, fontSize: 12, opacity: 0.6 }}>opendb-harness 组件出错（见控制台）</div>;
    return this.props.children;
  }
}

/** 品牌接管：只动 title 与注入 CSS —— 零 DOM 结构改动。 */
function takeOverBranding(): void {
  try {
    document.title = 'opendb-harness';
    const style = document.createElement('style');
    style.setAttribute('data-opendb-harness', 'brand');
    // 新会话主页顶部的图标（替代官方海豚）：34×25 数据库圆柱，与左上角字标同款画法。
    // 作为 mask 使用——形状用不透明黑描边，实际颜色由 background: currentColor 决定，
    // 因此明暗主题都不用各配一份。
    const DB_MASK = '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="25" viewBox="0 0 34 25">'
      + '<g fill="none" stroke="%23000" stroke-width="2" stroke-linecap="round">'
      + '<ellipse cx="17" cy="5.4" rx="10.6" ry="3.9"/>'
      + '<path d="M6.4 5.4v14.2c0 2.15 4.75 3.9 10.6 3.9s10.6-1.75 10.6-3.9V5.4"/>'
      + '<path d="M6.4 12.5c0 2.15 4.75 3.9 10.6 3.9s10.6-1.75 10.6-3.9"/>'
      + '</g></svg>';
    // 官方 logo 行原位替换：隐藏海豚 svg 与 deepseek 字（保留右侧折叠按钮），
    // ::before 注入整行 opendb 版 SVG（db 圆柱 + opendb 粗字 + HARNESS 黑胶囊）。
    const logoSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="196" height="26" viewBox="0 0 196 26"><g fill="none" stroke="%23111" stroke-width="1.7" stroke-linecap="round"><ellipse cx="12" cy="6.8" rx="8.6" ry="3.3"/><path d="M3.4 6.8v12.4c0 1.8 3.85 3.3 8.6 3.3s8.6-1.5 8.6-3.3V6.8"/><path d="M3.4 13c0 1.8 3.85 3.3 8.6 3.3s8.6-1.5 8.6-3.3"/></g><text x="28" y="19.5" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="18" font-weight="700" fill="%23111">opendb</text><rect x="97" y="5.5" width="64" height="16" rx="4" fill="%23111"/><text x="129" y="17" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="9.5" font-weight="700" letter-spacing="1.2" fill="%23fff">HARNESS</text></svg>';
    style.textContent = [
      '[class*="logoRow"] svg, [class*="logoRow"] img, [class*="logoRow"] span, [class*="logoRow"] a { display: none !important; }',
      `[class*="logoRow"]::before { content: ""; display: block; width: 196px; height: 26px; margin-right: auto; background: url('data:image/svg+xml;utf8,${logoSvg}') no-repeat left center / contain; }`,
      // 列表行 hover 照抄官方 sessionRow：纯 CSS :hover（无 JS 状态残留，移开即退，与原生会话行为一致）
      '.odbRow{cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary);border-radius:8px;align-items:center;padding:0 8px;display:flex;height:32px;box-sizing:border-box;min-width:0}',
      '.odbRow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      // 表格行 hover（视觉集中优化）：与列表条目同一反馈语言；表头与行间留呼吸感
      '.odbTable tbody tr:hover td{background:var(--dsw-alias-interactive-bg-hover)}',
      '.odbTable tbody td{transition:background .08s ease}',
      '.odbTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px;margin:0 6px 0 4px}',
      '.odbTime{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;flex:none}',
      // ── 新会话主页品牌化（user 2026-08-24）：海豚→数据库图标、标语、版本徽章 ──
      // 全程纯 CSS 覆盖官方组件，绝不碰它的 DOM（W5.5 白屏事故）；class 名带 CSS Modules
      // 哈希前缀（pXSMma_），一律用 [class*=] 前缀匹配，官方改版换哈希也不会失配。
      // 图标走 mask + currentColor 而非 background-image：颜色自动跟随明暗主题。
      `[class*="fishHitbox"] svg{display:none !important}`,
      // 不覆盖 display——官方是 flex+align-items:center，与文字中心线严丝合缝（实测中心差 0）；
      // 之前改成 inline-block 会退化成基线对齐，图标整体下沉，就是 user 说的「没对齐」。
      // 只补尺寸（svg 隐藏后容器会塌）与着色。
      `[class*="fishHitbox"]{width:34px;height:25px;flex:none;background:currentColor;` +
        `-webkit-mask:url('data:image/svg+xml;utf8,${DB_MASK}') no-repeat center/contain;` +
        `mask:url('data:image/svg+xml;utf8,${DB_MASK}') no-repeat center/contain}`,
      // 标语：原文字号归零隐藏（保留节点与 grid 布局），::before 注入新文案
      `[class*="headlineText"]{font-size:0 !important}`,
      `[class*="headlineText"]::before{content:"交互皆对话，万物皆插件";font-size:26px;line-height:32px;` +
        `font-weight:500;color:var(--dsw-alias-label-primary, #0f1115);white-space:nowrap}`,
      // 徽章：父元素 font-size:0 会让行盒按 0 算、由 ::before 撑高，比原生高出几 px；
      // 显式给回 line-height 并让伪元素以 inline-block 参与，量回原生的 21px 高度。
      `[class*="previewBadge"]{font-size:0 !important;line-height:18px !important}`,
      `[class*="previewBadge"]::before{content:"opendb-harness v${VERSION} 预览版";display:inline-block;` +
        `font-size:12px;line-height:18px;font-weight:500;vertical-align:top}`,
      // 首页 hero 行的「工作区选择器 + Agent 预设选择器」整行隐藏（user 2026-08-24）：
      // ① 工作区——对外已不暴露智能体概念（侧栏那层同期撤掉），且只有一个工作区，选择无意义；
      // ② Agent 预设（「标准模式」）——dsh 四种内置预设（标准/PTC/极简/创造）依赖 tool-bash、
      //    tool-fs、tool-str-replace-editor、tool-web、tool-workflow，这些按设计 D5 在
      //    bundle-runtime 里全部 disabled，四种预设在本平台一个都跑不动，留着是错误入口。
      // 以后要做面向 DBA 的自有预设（巡检/优化/应急）时，去掉这条即可放出选择器。
      `[class*="heroWorkspaceRow"]{display:none !important}`,
      // 例外（user 2026-08-25 报障）：草稿未绑定工作区时原生会禁用输入框并提示「选择一个工作区开始」，
      // 此时必须让原生的工作区选择行露出来，否则用户没有任何自救入口（只藏"正常态"那一行）
      `body:has(textarea:disabled) [class*="heroWorkspaceRow"]{display:flex !important}`,
      // 行尾三点：常驻 DOM、hover 才显形（对齐 dsh 原生列表行的隐藏操作菜单）
      '.odbDots{opacity:0;transition:opacity .1s ease;color:var(--dsw-alias-label-tertiary)}',
      '.odbRow:hover .odbDots{opacity:1}',
      '.odbDots:hover{color:var(--dsw-alias-label-primary)}',
      // 三点弹出菜单项的 hover（纯 CSS，避免每项一个 JS 状态）
      '.odbMenuItem:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      // 任务运行中的脉冲点（RunningBar）——与会话等模型时的呼吸反馈同一语言
      '@keyframes odbPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.72)}}',
      '.odbPulse{animation:odbPulse 1.15s ease-in-out infinite}',
      '@media (prefers-reduced-motion: reduce){.odbPulse{animation:none;opacity:.75}}',
    ].join('\n');
    document.head.appendChild(style);
  } catch { /* branding is cosmetic — never block boot */ }
}

export function apply(ctx: any): void {
  const call = async (endpoint: string, payload: unknown = {}): Promise<any> => {
    const r = await ctx.connection.rpc.call('/opendb', endpoint, payload);
    if (!r.ok) throw new Error(r.error?.message ?? 'request failed');
    return r.value;
  };

  const HarnessSidebar = makeSidebar(ctx, call);
  const HarnessMain = makeOverlay(ctx, call);
  const SafeSidebar = () => <Boundary><HarnessSidebar /></Boundary>;
  const SafeMain = () => <Boundary><HarnessMain /></Boundary>;

  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    {
      name: 'sidebar.workspaces',
      id: 'harness-sidebar',
      children: { 'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' } },
      inject: () => ({}),
    },
    SafeSidebar,
  ));

  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'harness-main', order: 40, inject: () => ({}) },
    SafeMain,
  ));

  // 任务面板「在会话里深挖」要跳到聊天区并打开新会话：把切视图的能力挂到桥上（task-health 客户端调用）
  try {
    const w = window as any;
    w.__opendbHarness__ = w.__opendbHarness__ ?? {};
    w.__opendbHarness__.openSession = (id: string) => { setState({ view: 'chat' }); ctx.sessions.open(id); };
  } catch { /* 桥不可用时面板退回 ctx.sessions.open */ }

  // 2026-08-28 user 报障：在任务报表页点侧栏顶部「新会话」没反应——那个按钮是官方侧栏的，它在聊天区起草新会话，
  // 但我们的 shell.overlay（任务/数据库/资源页）还盖在上面，看起来就是没反应。两道保险，都不碰官方 DOM：
  // ① 捕获阶段监听侧栏里「新会话」的点击 → 切回聊天区；② 当前会话 id 变成一个新 id（任何原生入口打开会话）→ 同样切回。
  try {
    const isNewSessionControl = (start: HTMLElement | null): boolean => {
      let el: HTMLElement | null = start;
      for (let i = 0; i < 5 && el !== null; i += 1, el = el.parentElement) {
        const text = (el.textContent ?? '').trim();
        if (/^(新会话|New session|New chat)$/i.test(text)) return el.getBoundingClientRect().left < 400;
      }
      return false;
    };
    document.addEventListener('click', (ev) => {
      if (getState().view !== 'chat' && isNewSessionControl(ev.target as HTMLElement | null)) setState({ view: 'chat' });
    }, true);
    let lastCurrent = currentSessionId(ctx);
    const watch = setInterval(() => {
      const c = currentSessionId(ctx);
      if (c === lastCurrent) return;
      lastCurrent = c;
      if (c !== undefined && getState().view !== 'chat') setState({ view: 'chat' });
    }, 500);
    if (typeof ctx.effect === 'function') ctx.effect(() => () => clearInterval(watch), 'harness.currentSessionWatch');
  } catch { /* 切视图保险失效不影响启动 */ }

  // 排队投影 → 原生 queue dock（见 queue-sync.ts）；同步器自身永不抛，这里再兜一层不让它影响启动
  try {
    const stop = startQueueSync(ctx, call);
    if (typeof ctx.effect === 'function') ctx.effect(() => stop, 'harness.queueSync');
  } catch { /* 无排队展示也不能挡住整个 UI */ }

  takeOverBranding();
}
