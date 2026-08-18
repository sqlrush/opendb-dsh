import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolvePlatformAgent, renderTable, clampText } from '@opendb-dsh/tool-db';

export const name = 'tool-memory';
export const inject = ['opendbMemory', 'opendbRegistry', 'tools'];

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { content: { type: 'string', required: true } },
  },
  render: (_args: unknown, value: any) => [{ type: 'text', text: value.content }],
} as const;

const KINDS = ['episodic', 'fact', 'preference', 'report'];

function defineMemorySearchTool(deps: { memory: any; registry: any }) {
  return defineTool({
    name: 'memory_search',
    description: '检索当前 agent 的平台记忆库（历史巡检/审核结论、已存事实与偏好）。回答"上次/昨天/之前"类问题优先用它，不要重新巡检。',
    parameters: {
      query: { type: 'string', required: true, description: '检索内容（语义匹配）。' },
      kind: { type: 'string', description: '可选过滤：episodic|fact|preference|report。' },
      top_k: { type: 'integer', description: '返回条数（默认 5，最大 20）。' },
    },
    output: TEXT_OUTPUT,
    async execute(args: any, exec: any) {
      const agent = await resolvePlatformAgent(deps.registry, exec?.agent);
      if (agent === undefined) return { content: '无法确定当前会话所属的平台 agent' };
      const kind = KINDS.includes(String(args.kind)) ? String(args.kind) : undefined;
      const rows = await deps.memory.search({ agentId: agent.id, query: String(args.query ?? ''), topK: Number(args.top_k ?? 5), kind });
      if (rows.length === 0) return { content: `记忆库中没有与「${args.query}」相关的内容` };
      const table = renderTable(
        ['date', 'kind', 'content'],
        rows.map((m: any) => ({ date: new Date(m.createdAt).toISOString().slice(0, 10), kind: m.kind, content: m.content })),
      );
      return { content: clampText(`记忆检索「${args.query}」→ ${rows.length} 条\n${table}`, 20000) };
    },
  } as any);
}

function defineMemorySaveTool(deps: { memory: any; registry: any }) {
  return defineTool({
    name: 'memory_save',
    description: '把值得长期记住的结论/事实/用户偏好存入平台记忆库（跨会话可检索）。例：某节点的已知隐患、用户交代的运维偏好。',
    parameters: {
      content: { type: 'string', required: true, description: '要记住的内容（一段自洽的文字，含必要上下文）。' },
      kind: { type: 'string', description: 'episodic(事件)|fact(事实)|preference(偏好)，默认 fact。' },
    },
    output: TEXT_OUTPUT,
    async execute(args: any, exec: any) {
      const agent = await resolvePlatformAgent(deps.registry, exec?.agent);
      if (agent === undefined) return { content: '无法确定当前会话所属的平台 agent，未保存' };
      const kind = KINDS.includes(String(args.kind)) && args.kind !== 'report' ? String(args.kind) : 'fact';
      const rec = await deps.memory.write({ agentId: agent.id, kind, content: String(args.content ?? '') });
      return { content: `已存入记忆（${rec.kind}，id=${rec.id}）` };
    },
  } as any);
}

/** 记忆读写工具（function plugin 顶层 inject——W4 教训的正确姿势）。 */
export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  const deps = { memory: anyCtx.opendbMemory, registry: anyCtx.opendbRegistry };
  ctx.effect(() => anyCtx.tools.register(defineMemorySearchTool(deps)), 'tool-memory.memory_search');
  ctx.effect(() => anyCtx.tools.register(defineMemorySaveTool(deps)), 'tool-memory.memory_save');
}
