/**
 * ui-kb — 知识库大盘（client-only 插件，P1，2026-09-01 user 通过 docs/prototypes/knowledge-r1.html 后开发）。
 * server 半边在 ui-knowledge（/opendb-knowledge 的 dashboard 端点，只读聚合记忆/向量/图三库）；
 * 本包只承载面板浏览器 bundle，经 window 桥 registerKnowledgePanel('dashboard', Panel) 进驻「知识库 › 知识库大盘」。
 */
import type { Context } from '@deepseek-ai/cordis';

export const name = 'ui-kb';

/** Host 半边无逻辑（同 ui-cluster）——但 apply 必须有：cordis 只接受函数或带 apply 的对象。 */
export function apply(_ctx: Context): void { /* client-only plugin */ }
