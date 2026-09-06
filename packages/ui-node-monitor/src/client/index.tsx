/**
 * 数据库大盘（每个节点的专属页）——client-only 插件，经 window 桥 registerNodePanel 进驻 ui-harness 的数据库页。
 * 2026-09-06 重构（设计稿 docs/prototypes/node-r1.html，user 批准）：一次 RPC（/opendb nodes/dashboard）出全页，
 * 数字全部确定性直读；深挖走会话（DigLink 三态），页面零按钮。数据装配见 ui-opendb/src/node-dashboard.ts。
 */
import { NodeDashboardPage } from './panel.tsx';
import { setClientCtx } from './dig.ts';

// 深挖要用 sessions / connection / workspaces：列进 inject 保证 apply 时服务已就绪（CLAUDE.md 第 6 条）
export const inject = ['connection', 'slots', 'workspaces', 'sessions'];

export function apply(ctx: any): void {
  setClientCtx(ctx);
  const call = async (endpoint: string, payload: unknown = {}): Promise<any> => {
    const r = await ctx.connection.rpc.call('/opendb', endpoint, payload);
    if (!r.ok) throw new Error(r.error?.message ?? 'request failed');
    return r.value;
  };
  const Panel = ({ nodeId }: { nodeId: string }) => <NodeDashboardPage nodeId={nodeId} call={call} />;
  registerNodePanelSafe(Panel);
}

/**
 * 注册节点面板：与 ui-harness 的加载顺序无关。桥已在就直接注册，否则排进 __pending，
 * 由后到的 ui-harness 兑现（2026-08-24 根治的加载竞态）。
 */
function registerNodePanelSafe(Comp: any): void {
  if (typeof window === 'undefined') return;
  const w = window as any;
  if (w.__opendbHarness__?.registerNodePanel !== undefined) { w.__opendbHarness__.registerNodePanel(Comp); return; }
  w.__opendbHarness__ = w.__opendbHarness__ ?? {};
  w.__opendbHarness__.__pending = [...(w.__opendbHarness__.__pending ?? []), { kind: 'node', comp: Comp }];
}
