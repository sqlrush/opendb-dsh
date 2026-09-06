/**
 * 深挖 = 一键开会话并把背景 + 任务发过去（沿用 task-health 的 DigLink 三态：`${label} →` / 开会话中… / 失败，重试）。
 * 需要 ctx.sessions / connection / workspaces——插件 inject 必须列出它们（CLAUDE.md 第 6 条，2026-08-27 教训）。
 */
let clientCtx: any;
export function setClientCtx(ctx: any): void { clientCtx = ctx; }

export async function digInSession(text: string): Promise<string> {
  if (clientCtx === undefined) throw new Error('客户端上下文未就绪');
  const ws = clientCtx.workspaces?.list?.getSnapshot?.()?.items?.[0];
  const sessionId: string = await clientCtx.sessions.create(ws?.workspaceId !== undefined ? { workspaceId: ws.workspaceId } : {});
  openSession(sessionId);
  const r = await clientCtx.connection.rpc.call('/api', 'session.prompt', {
    sessionId, mode: 'queue', content: [{ type: 'text', text }],
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  if (r?.ok === false) throw new Error(String(r.error?.message ?? 'prompt rejected'));
  return sessionId;
}

/** 打开已有会话（切回聊天区）：优先走 ui-harness 桥，没有桥就直接 sessions.open。 */
export function openSession(sessionId: string): void {
  const bridge = (window as any).__opendbHarness__;
  if (typeof bridge?.openSession === 'function') bridge.openSession(sessionId);
  else clientCtx?.sessions?.open?.(sessionId);
}

/** 打开任务页（ui-harness 桥 openTask；老版本桥没有这个方法时返回 false，调用方退回"看会话"）。 */
export function openTask(taskId: string): boolean {
  const bridge = (window as any).__opendbHarness__;
  if (typeof bridge?.openTask === 'function') { bridge.openTask(taskId); return true; }
  return false;
}

/** 深挖提示词：统一前缀 + 背景行 + 只读任务约束。 */
export function digPrompt(node: string, topic: string, lines: string[]): string {
  return [
    `【数据库大盘深挖】节点 ${node} · ${topic}`,
    ...lines.filter((s) => s.trim() !== ''),
    '任务：先用工具（metrics_chart / metrics_recent / health_collect / sqlreview_collect / wdr_collect / capacity_collect / db_query 等）取最近数据取证，再给出：1) 判断与依据；2) 影响面；3) 处置建议（本平台只读，不执行任何变更）。不要向我反问，直接给结论。',
  ].join('\n');
}
