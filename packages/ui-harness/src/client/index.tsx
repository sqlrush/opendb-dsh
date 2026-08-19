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
    // 官方 logo 行原位替换：隐藏海豚 svg 与 deepseek 字（保留右侧折叠按钮），
    // ::before 注入整行 opendb 版 SVG（db 圆柱 + opendb 粗字 + HARNESS 黑胶囊）。
    const logoSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="196" height="26" viewBox="0 0 196 26"><g fill="none" stroke="%23111" stroke-width="1.7" stroke-linecap="round"><ellipse cx="12" cy="6.8" rx="8.6" ry="3.3"/><path d="M3.4 6.8v12.4c0 1.8 3.85 3.3 8.6 3.3s8.6-1.5 8.6-3.3V6.8"/><path d="M3.4 13c0 1.8 3.85 3.3 8.6 3.3s8.6-1.5 8.6-3.3"/></g><text x="28" y="19.5" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="18" font-weight="700" fill="%23111">opendb</text><rect x="97" y="5.5" width="64" height="16" rx="4" fill="%23111"/><text x="129" y="17" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="9.5" font-weight="700" letter-spacing="1.2" fill="%23fff">HARNESS</text></svg>';
    style.textContent = [
      '[class*="logoRow"] svg, [class*="logoRow"] img, [class*="logoRow"] span, [class*="logoRow"] a { display: none !important; }',
      `[class*="logoRow"]::before { content: ""; display: block; width: 196px; height: 26px; margin-right: auto; background: url('data:image/svg+xml;utf8,${logoSvg}') no-repeat left center / contain; }`,
      // 列表行 hover 照抄官方 sessionRow：纯 CSS :hover（无 JS 状态残留，移开即退，与原生会话行为一致）
      '.odbRow{cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary);border-radius:8px;align-items:center;padding:0 8px;display:flex;height:32px;box-sizing:border-box;min-width:0}',
      '.odbRow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.odbTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px;margin:0 6px 0 4px}',
      '.odbTime{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;flex:none}',
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

  takeOverBranding();
}
