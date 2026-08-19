import type { Context } from '@deepseek-ai/cordis';

export const name = 'ui-harness';

/** Host 半边无逻辑：数据全走 ui-opendb 的 /opendb 通道；本包只承载浏览器 bundle。 */
export function apply(_ctx: Context): void { /* client-only plugin */ }
