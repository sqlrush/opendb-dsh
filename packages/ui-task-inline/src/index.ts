import type { Context } from '@deepseek-ai/cordis';

export const name = 'ui-task-inline';

/** Host 半边无逻辑：本包只承载会话内嵌卡的浏览器 bundle（tool.call.toolview 键控渲染器）。 */
export function apply(_ctx: Context): void { /* client-only plugin */ }
