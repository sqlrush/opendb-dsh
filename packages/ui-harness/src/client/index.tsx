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
    style.textContent = [
      // 官方海豚 logo 行整体隐藏（我们在自己的侧栏顶部画 opendb 版 logo）
      '[class*="logoRow"] { display: none !important; }',

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
