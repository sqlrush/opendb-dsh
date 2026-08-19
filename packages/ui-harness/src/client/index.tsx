/**
 * opendb-harness 前端壳（W5.5）：
 * - 替换 sidebar.workspaces hole → HarnessSidebar
 * - shell.overlay → HarnessMain（主区页面，贴齐侧栏右缘——user 定案：不单开全屏页）
 * - 品牌接管：document.title + 左上角 DeepSeek Harness 字标替换为 opendb-harness
 * - 导出 registerTaskPanel：任务类型插件的 client 半边注册专属面板（不同任务对应不同插件）
 */
import { makeSidebar } from './sidebar.tsx';
import { makeOverlay } from './overlay.tsx';

export { registerTaskPanel } from './state.ts';

export const inject = ['connection', 'slots', 'workspaces', 'sessions'];

/** 左上角官方字标（ui-sidebar 的 logoRow/Wordmark，无插槽）→ DOM 接管为产品名。 */
function takeOverBranding(): void {
  document.title = 'opendb-harness';
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    const nodes = document.querySelectorAll('[class*="logoRow"], [class*="Wordmark"], [class*="wordmark"]');
    let done = false;
    nodes.forEach((el) => {
      const text = el.textContent ?? '';
      if (text.includes('opendb-harness')) { done = true; return; }
      if (/harness/i.test(text) || el.querySelector('svg') !== null) {
        (el as HTMLElement).innerHTML = '<span style="font-weight:700;font-size:14px;letter-spacing:.3px">opendb-harness</span>';
        done = true;
      }
    });
    if (done || attempts >= 20) clearInterval(timer);
  }, 500);
}

export function apply(ctx: any): void {
  const call = async (endpoint: string, payload: unknown = {}): Promise<any> => {
    const r = await ctx.connection.rpc.call('/opendb', endpoint, payload);
    if (!r.ok) throw new Error(r.error?.message ?? 'request failed');
    return r.value;
  };

  const HarnessSidebar = makeSidebar(ctx, call);
  const HarnessMain = makeOverlay(ctx, call);

  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    {
      name: 'sidebar.workspaces',
      id: 'harness-sidebar',
      children: { 'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' } },
      inject: () => ({}),
    },
    HarnessSidebar,
  ));

  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'harness-main', order: 40, inject: () => ({}) },
    HarnessMain,
  ));

  takeOverBranding();
}
