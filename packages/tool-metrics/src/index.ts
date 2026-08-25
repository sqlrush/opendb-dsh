import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { pickNode, renderTable, clampText, resolvePlatformAgent } from '@opendb-dsh/tool-db';

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
    description: '查看节点的监控指标（collector 定时采集）：不带 metric 时返回每个指标的最新值；带 metric 时返回该指标最近 N 分钟的时间序列（文本表格）。**用户要看曲线/趋势/对比图时不要用本工具，用 metrics_chart——它会在会话里渲染成交互式图表，并自动完成计数器差分。**',
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

function defineFleetOverviewTool(deps: Deps) {
  return defineTool({
    name: 'metrics_fleet_overview',
    description: '舰队级指标总览（大规模巡检入口）：一次汇总本智能体全部绑定节点最近 5 分钟的指标——采集覆盖率、每指标 min/avg/max、异常值 Top 节点、无数据节点。适合先总览再对可疑节点用 db_overview/metrics_recent 钻取。',
    parameters: {
      topN: { type: 'integer', description: '异常榜长度（默认 15）。' },
    },
    output: TEXT_OUTPUT,
    async execute(args: any, exec: any) {
      const agent = await resolvePlatformAgent(deps.registry, exec?.agent);
      if (agent === undefined) return { content: '无法确定当前会话所属的平台 agent（会话没有绑定工作区）' };
      const nodes = await deps.registry.listNodes({ agentId: agent.id });
      if (nodes.length === 0) return { content: `智能体「${agent.name}」没有绑定任何节点` };
      const byId = new Map<string, string>(nodes.map((n: any) => [n.id, n.name]));
      const ov = await deps.metrics.fleetOverview(
        nodes.map((n: any) => n.id),
        ['db.waiting_locks', 'db.connections_used_ratio', 'db.sessions.active', 'db.sessions.total'],
        Number(args.topN ?? 15),
      );
      const coveredSet = new Set(ov.coveredIds);
      const missing = nodes.filter((n: any) => !coveredSet.has(n.id)).slice(0, 10);
      const aggTable = renderTable(['metric', 'nodes', 'min', 'avg', 'max'],
        ov.agg.map((a: any) => ({ metric: a.metric, nodes: a.n, min: round3(a.min), avg: round3(a.avg), max: round3(a.max) })));
      const topTable = ov.top.length === 0 ? '（无非零异常值）' : renderTable(['node', 'metric', 'value'],
        ov.top.map((t: any) => ({ node: byId.get(t.nodeId) ?? t.nodeId, metric: t.metric, value: round3(t.value) })));
      return {
        content: clampText([
          `-- 舰队总览：绑定 ${nodes.length} 节点，最近 5 分钟有采集的 ${ov.covered} 个`,
          missing.length > 0 ? `无数据节点（前 ${missing.length} 个）：${missing.map((n: any) => n.name).join(', ')}${nodes.length - ov.covered > missing.length ? ` …共 ${nodes.length - ov.covered} 个` : ''}` : '采集覆盖完整',
          ``, `== 每指标聚合 ==`, aggTable,
          ``, `== 异常值 Top（按值降序，>0）==`, topTable,
        ].join('\n'), deps.maxContentBytes),
      };
    },
  } as any);
}

function round3(v: number): number { return Math.round(v * 1000) / 1000; }

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
    c.effect(() => c.tools.register(defineFleetOverviewTool(deps)), 'tool-metrics.metrics_fleet_overview');
  });
}
