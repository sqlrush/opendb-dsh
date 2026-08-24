/**
 * tool-health-collect — health_collect 工具（task-health 的采集半边，Runtime 侧）。
 * 独立成包的原因（W4 事故复盘原话）：工具注册必须是独立 function plugin、顶层 inject 数据服务、
 * 嵌套只 inject(['tools'])——task-health 包内嵌套多依赖 inject 实测静默不生效（2026-08-21 两轮 e2e）。
 * 形状 1:1 对照 tool-metrics（已验证多年打法）。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolvePlatformAgent, clampText } from '@opendb-dsh/tool-db';
import { collectNode, summarize, type HealthCollectResult } from '@opendb-dsh/task-health';

export const name = 'tool-health-collect';
export const inject = ['opendbDb', 'opendbRegistry'];
export const Config = z.object({
  maxContentBytes: z.number().step(1).min(4096).default(28000),
  maxNodes: z.number().step(1).min(1).default(16).description('单次采集允许的最大实例数（防 token 爆炸）'),
});

const LEVEL_CN: Record<string, string> = { ok: '正常', notice: '关注', warn: '告警', critical: '严重' };

interface Deps { db: any; registry: any; maxContentBytes: number; maxNodes: number }

function defineHealthCollectTool(deps: Deps) {
  return defineTool({
    name: 'health_collect',
    description: '【实例健康 / 锁等待 / 容量水位 / 膨胀的首选入口，先调它再说】一次调用完成 12 维只读采集并给出阈值判定（总览·等待·慢SQL·长空闲事务·膨胀·LWLock·锁链[含 waiter↔holder 边]·连接占用率·ckpt/WAL·复制·对象索引·并发），返回证据包 + Deterministic Findings。**覆盖了手写 pg_locks 自连接、pg_stat_activity、pg_stat_user_tables、pg_settings 等一系列查询的全部结果，不要先用 db_overview + metrics_recent 去拼**。多节点时附跨实例分析（共性/配置漂移/最差上浮）。',
    parameters: {
      nodes: { type: 'array', items: { type: 'string' }, description: '节点名列表；省略 = 本智能体全部绑定节点。' },
      dims: { type: 'array', items: { type: 'string' }, description: '维度白名单；省略 = 全部 12 维。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true } } },
      render: (_args: unknown, value: any) => [{ type: 'text', text: value.content }],
    },
    async execute(args: any, exec: any) {
      const agent = await resolvePlatformAgent(deps.registry, exec?.agent);
      if (agent === undefined) return { content: '无法确定当前会话所属的平台 agent（会话没有绑定工作区）' };
      const bound = await deps.registry.listNodes({ agentId: agent.id });
      const wanted: string[] = Array.isArray(args.nodes) ? args.nodes.map(String) : [];
      const picked = wanted.length > 0 ? bound.filter((n: any) => wanted.includes(n.name)) : bound;
      if (picked.length === 0) return { content: `没有匹配的节点（agent「${agent.name}」绑定 ${bound.length} 个${wanted.length > 0 ? `，请求的 ${JSON.stringify(wanted)} 均不在其中` : ''}）` };
      if (picked.length > deps.maxNodes) {
        return { content: `实例数 ${picked.length} 超过单次上限 ${deps.maxNodes}——请用 metrics_fleet_overview 先聚合，或分批指定 nodes。` };
      }
      const dims: string[] = Array.isArray(args.dims) ? args.dims.map(String) : [];
      const results = [];
      for (const node of picked) {
        const q = (sql: string, maxRows = 20) => deps.db.query(node, sql, { maxRows });
        try {
          results.push(await collectNode(node.name, q, dims));
        } catch (cause) {
          results.push({
            node: node.name, worst: 'warn' as const,
            dims: [], findings: [{ dim: 'overview', code: 'NODE_UNREACHABLE', level: 'warn' as const, metric: 'reachable', value: 0, threshold: 'reachable', evidence: String((cause as Error).message ?? cause).slice(0, 160), detail: '节点不可达或连接失败' }],
            collectionNotes: [`节点「${node.name}」整体采集失败：${String((cause as Error).message ?? cause).slice(0, 160)}`],
            settings: {},
          });
        }
      }
      const summary: HealthCollectResult = summarize(results);
      const header = [
        `-- health_collect · ${summary.scope} · ${picked.length} 节点 · worst=${summary.worst}（${LEVEL_CN[summary.worst]}）`,
        `-- counts: critical=${summary.counts.critical} warn=${summary.counts.warn} notice=${summary.counts.notice}`,
        `-- 以下 JSON 是唯一事实来源：scope/det/findings/collectionNotes 必须逐字进报告，level 不得下调`,
      ].join('\n');
      const payload = {
        scope: summary.scope,
        det: {
          worst: summary.worst,
          counts: summary.counts,
          byNode: summary.nodes.map((n) => ({ node: n.node, worst: n.worst })),
        },
        nodes: summary.nodes.map((n) => ({
          node: n.node, worst: n.worst,
          dims: n.dims.map((d) => ({ dim: d.dim, title: d.title, ok: d.ok, worst: d.worst })),
          findings: n.findings,
          collectionNotes: n.collectionNotes,
          settings: n.settings,
        })),
        clusterFindings: summary.clusterFindings,
        collectedAt: summary.collectedAt,
      };
      return { content: clampText(`${header}\n${JSON.stringify(payload, null, 1)}`, deps.maxContentBytes) };
    },
  } as any);
}

export function apply(ctx: Context, config: { maxContentBytes?: number; maxNodes?: number } = {}): void {
  const anyCtx = ctx as any;
  anyCtx.inject(['tools'], (c: any) => {
    const deps: Deps = {
      db: anyCtx.opendbDb,
      registry: anyCtx.opendbRegistry,
      maxContentBytes: config.maxContentBytes ?? 28000,
      maxNodes: config.maxNodes ?? 16,
    };
    c.effect(() => c.tools.register(defineHealthCollectTool(deps)), 'tool-health-collect.health_collect');
  });
}
