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
import { collectNode, summarize, withThresholds, type HealthCollectResult } from '@opendb-dsh/task-health';

export const name = 'tool-health-collect';
export const inject = ['opendbDb', 'opendbRegistry', 'opendbThresholds'];
export const Config = z.object({
  maxContentBytes: z.number().step(1).min(4096).default(28000),
  maxNodes: z.number().step(1).min(1).default(16).description('单次采集允许的最大实例数（防 token 爆炸）'),
});

const LEVEL_CN: Record<string, string> = { ok: '正常', notice: '关注', warn: '告警', critical: '严重' };

interface Deps { db: any; registry: any; thresholds: any; maxContentBytes: number; maxNodes: number }

function defineHealthCollectTool(deps: Deps) {
  return defineTool({
    name: 'health_collect',
    description: '健康检查确定性采集器：对指定节点（默认本智能体全部绑定节点）运行 12 维只读采集（总览/等待/慢SQL/长事务/膨胀/LWLock/锁链/连接/ckpt·WAL/复制/对象/并发），返回证据包 + Deterministic Findings（阈值判定由脚本完成）。多节点时附跨实例分析（共性/配置漂移/最差上浮）。',
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
      // 运行时阈值：平台阈值服务的覆盖值套回常量形状；服务不可用则退回代码默认值（不阻塞采集）
      let thresholdNote = '';
      let flat: Record<string, number> = {};
      let T = withThresholds({});
      try { flat = await deps.thresholds.resolve('health'); T = withThresholds(flat); }
      catch (cause) { thresholdNote = `阈值服务不可读（${String((cause as Error).message ?? cause).slice(0, 80)}），本次按代码默认阈值判定`; }
      // 报告自证：本次判定用的是哪套阈值（覆盖项单列），历史报告回看时不必猜当时的阈值
      const defaults = withThresholds({});
      const flatDefaults: Record<string, number> = {};
      for (const [g, v] of Object.entries(defaults)) {
        if (typeof v === 'number') flatDefaults[g] = v;
        else for (const [tier, n] of Object.entries(v as Record<string, number>)) flatDefaults[`${g}.${tier}`] = n;
      }
      const overrides = Object.fromEntries(Object.entries(flat).filter(([k, v]) => flatDefaults[k] !== undefined && flatDefaults[k] !== v));
      const results = [];
      for (const node of picked) {
        const q = (sql: string, maxRows = 20) => deps.db.query(node, sql, { maxRows });
        try {
          const nh = await collectNode(node.name, q, dims, T);
          results.push(thresholdNote === '' ? nh : { ...nh, collectionNotes: [...nh.collectionNotes, thresholdNote] });
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
        // 本次判定所用阈值：只列与代码默认值不同的键（空 = 全部默认）；完整清单用 threshold_list
        thresholds: { overrides, source: Object.keys(overrides).length > 0 ? 'platform-overrides' : 'code-defaults' },
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
      thresholds: anyCtx.opendbThresholds,
      maxContentBytes: config.maxContentBytes ?? 28000,
      maxNodes: config.maxNodes ?? 16,
    };
    c.effect(() => c.tools.register(defineHealthCollectTool(deps)), 'tool-health-collect.health_collect');
  });
}
