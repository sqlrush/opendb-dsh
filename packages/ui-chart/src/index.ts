import type { Context } from '@deepseek-ai/cordis';

export const name = 'ui-chart';

/** Host 半边无逻辑：本包只承载会话内图表卡的浏览器 bundle（tool.call.toolview 键控渲染器）。 */
export function apply(_ctx: Context): void { /* client-only plugin */ }
