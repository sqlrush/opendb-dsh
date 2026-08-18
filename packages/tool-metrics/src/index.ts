import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { pickNode, renderTable, clampText } from '@opendb-dsh/tool-db';

export const name = 'tool-metrics';
export const inject = ['opendbMetrics', 'opendbDictionary', 'opendbRegistry'];
export const Config = z.object({ maxContentBytes: z.number().step(1).min(1024).default(20000) });

interface Deps { metrics: any; dictionary: any; registry: any; maxContentBytes: number }

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { content: { type: 'string', required: true } },
  },
  render: (_args: unknown, value: any) => [{ type: 'text', text: value.content }],
} as const;

function defineMetricsRecentTool(deps: Deps) {
  return defineTool({
    name: 'metrics_recent',
    description: '查看节点的监控指标（collector 定时采集）：不带 metric 时返回每个指标的最新值；带 metric 时返回该指标最近 N 分钟的时间序列。',
    parameters: {
      node: { type: 'string', description: '目标节点名称；agent 只绑定一个节点时可省略。' },
      metric: { type: 'string', description: '指标名（如 db.sessions.active、db.size_bytes.postgres）；省略则列出全部指标的最新值。' },
      minutes: { type: 'integer', description: '时间序列回看窗口，分钟（默认 60）。' },
    },
    output: TEXT_OUTPUT,
    async execute(args: any, exec: any) {
      const { node } = await pickNode(deps.registry, exec, args.node);
      if (typeof args.metric === 'string' && args.metric !== '') {
        const rows = await deps.metrics.recent(node.id, args.metric, Number(args.minutes ?? 60));
        const table = renderTable(['time', 'value'], rows.map((r: any) => ({ time: r.time.toISOString(), value: r.value })));
        return { content: clampText(`-- ${node.name} · ${args.metric} · 最近 ${Number(args.minutes ?? 60)} 分钟（新→旧，${rows.length} 点）\n${table}`, deps.maxContentBytes) };
      }
      const rows = await deps.metrics.latest(node.id);
      if (rows.length === 0) return { content: `节点「${node.name}」还没有任何指标数据（collector 每分钟采集一次，请稍后再查）` };
      const table = renderTable(['metric', 'value', 'time'], rows.map((r: any) => ({ metric: r.metric, value: r.value, time: r.time.toISOString() })));
      return { content: clampText(`-- ${node.name} 各指标最新值（${rows.length} 个）\n${table}`, deps.maxContentBytes) };
    },
  } as any);
}

function defineDictChangesTool(deps: Deps) {
  return defineTool({
    name: 'dict_changes',
    description: '查看节点数据字典（表/索引/视图/函数/序列）的结构变更历史（collector 定时快照对比）。',
    parameters: {
      node: { type: 'string', description: '目标节点名称；agent 只绑定一个节点时可省略。' },
      hours: { type: 'integer', description: '回看窗口，小时（默认 24）。' },
    },
    output: TEXT_OUTPUT,
    async execute(args: any, exec: any) {
      const { node } = await pickNode(deps.registry, exec, args.node);
      const rows = await deps.dictionary.changes({ nodeId: node.id, sinceHours: Number(args.hours ?? 24) });
      if (rows.length === 0) return { content: `节点「${node.name}」最近 ${Number(args.hours ?? 24)} 小时没有数据字典变更` };
      const table = renderTable(
        ['time', 'change', 'kind', 'object'],
        rows.map((r: any) => ({ time: r.time.toISOString(), change: r.change, kind: r.kind, object: `${r.sch}.${r.name}` })),
      );
      return { content: clampText(`-- ${node.name} 数据字典变更（${rows.length} 条，新→旧）\n${table}`, deps.maxContentBytes) };
    },
  } as any);
}

/** Metric/dictionary read tools for Runtime pods; scoping mirrors tool-db (agent-bound nodes only). */
export function apply(ctx: Context, config: { maxContentBytes?: number } = {}): void {
  const anyCtx = ctx as any;
  anyCtx.inject(['tools'], (c: any) => {
    const deps: Deps = {
      metrics: anyCtx.opendbMetrics,
      dictionary: anyCtx.opendbDictionary,
      registry: anyCtx.opendbRegistry,
      maxContentBytes: config.maxContentBytes ?? 20000,
    };
    c.effect(() => c.tools.register(defineMetricsRecentTool(deps)), 'tool-metrics.metrics_recent');
    c.effect(() => c.tools.register(defineDictChangesTool(deps)), 'tool-metrics.dict_changes');
  });
}
