import type { Context } from '@deepseek-ai/cordis';

export const name = 'ui-node-monitor';

/** Host 半边无逻辑：数据走 ui-opendb 的 /opendb 通道；本包只承载节点监控面板的浏览器 bundle。 */
export function apply(_ctx: Context): void { /* client-only plugin */ }
