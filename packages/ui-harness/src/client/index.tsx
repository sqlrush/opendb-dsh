/**
 * opendb-harness 前端壳（W5.5 批次1）：
 * - 替换 sidebar.workspaces（官方 ui-workspace 已在 bundle 禁用）→ HarnessSidebar
 *   （按 hole 契约声明 sidebar.workspaces.directoryFlow 子槽，本实现不使用该流程）
 * - 注册 shell.overlay → HarnessOverlay（任务/数据库/资源全屏页）
 */
import { makeSidebar } from './sidebar.tsx';
import { makeOverlay } from './overlay.tsx';

export const inject = ['connection', 'slots', 'workspaces', 'sessions'];

export function apply(ctx: any): void {
  const call = async (endpoint: string, payload: unknown = {}): Promise<any> => {
    const r = await ctx.connection.rpc.call('/opendb', endpoint, payload);
    if (!r.ok) throw new Error(r.error?.message ?? 'request failed');
    return r.value;
  };

  const HarnessSidebar = makeSidebar(ctx, call);
  const HarnessOverlay = makeOverlay(ctx, call);

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
    { name: 'shell.overlay', id: 'harness-overlay', order: 40, inject: () => ({}) },
    HarnessOverlay,
  ));
}
