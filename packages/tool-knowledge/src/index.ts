import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolvePlatformAgent, clampText } from '@opendb-dsh/tool-db';

export const name = 'tool-knowledge';
export const inject = ['opendbKnowledge', 'opendbRegistry', 'tools'];

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { content: { type: 'string', required: true } },
  },
  render: (_args: unknown, value: any) => [{ type: 'text', text: value.content }],
} as const;

function defineSearchTool(deps: { knowledge: any; registry: any }) {
  return defineTool({
    name: 'knowledge_search',
    description: '在知识库里语义检索（运维手册/SOP/架构文档等外部资料；与记忆不同——记忆是平台自身经历用 memory_search）。返回最相关的文档片段。',
    parameters: {
      query: { type: 'string', description: '检索问题或关键词。', required: true },
      top_k: { type: 'integer', description: '返回片段数（默认 5，最多 20）。' },
    },
    output: TEXT_OUTPUT,
    async execute(args: any, exec: any) {
      const agent = await resolvePlatformAgent(deps.registry, exec?.agent);
      const hits: any[] = await deps.knowledge.search({ agentId: agent?.id, query: String(args.query ?? ''), topK: Number(args.top_k ?? 5) });
      if (hits.length === 0) return { content: '知识库没有相关内容（可以让用户提供资料后用 knowledge_ingest 灌入）' };
      const blocks = hits.map((h, i) => `【${i + 1}】《${h.title}》第 ${h.seq + 1} 段${h.source ? `（来源 ${h.source}）` : ''}\n${h.content}`);
      return { content: clampText(blocks.join('\n\n---\n\n'), 18000) };
    },
  } as any);
}

function defineIngestTool(deps: { knowledge: any; registry: any }) {
  return defineTool({
    name: 'knowledge_ingest',
    description: '把一篇资料灌入知识库（自动切块+向量化，之后可用 knowledge_search 检索）。适用：用户粘贴的手册/SOP/架构说明等值得长期沉淀的外部资料。同 source 重灌会替换旧版本。',
    parameters: {
      title: { type: 'string', description: '文档标题。', required: true },
      text: { type: 'string', description: '文档正文（纯文本/markdown）。', required: true },
      source: { type: 'string', description: '来源标识（URL/文件名/工单号）；同源重灌替换旧版。' },
      global: { type: 'boolean', description: 'true = 全局知识（所有智能体可检索）；默认只归本智能体。' },
    },
    output: TEXT_OUTPUT,
    async execute(args: any, exec: any) {
      const agent = await resolvePlatformAgent(deps.registry, exec?.agent);
      const doc = await deps.knowledge.ingest({
        agentId: args.global === true ? undefined : agent?.id,
        title: String(args.title ?? ''),
        source: typeof args.source === 'string' && args.source !== '' ? args.source : undefined,
        text: String(args.text ?? ''),
      });
      return { content: `已入库：《${doc.title}》切成 ${doc.chunks} 段（${args.global === true ? '全局知识' : `归属 ${agent?.name ?? '本智能体'}`}${doc.source ? `，来源 ${doc.source}` : ''}）` };
    },
  } as any);
}

/** 知识库读写工具（function plugin 顶层 inject——W4 教训的正确姿势）。 */
export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  anyCtx.inject(['tools'], (c: any) => {
    const deps = { knowledge: anyCtx.opendbKnowledge, registry: anyCtx.opendbRegistry };
    c.effect(() => c.tools.register(defineSearchTool(deps)), 'tool-knowledge.search');
    c.effect(() => c.tools.register(defineIngestTool(deps)), 'tool-knowledge.ingest');
  });
}
