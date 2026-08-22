/**
 * task-health — 任务重做 #1：健康检查（设计稿 docs/2026-08-21-task-redo-design.md §2）。
 * 双半边 + 一个 Runtime 工具：
 *   - TaskType 'health'（Host/Runtime 都注册，引擎调度 + task_report 校验都要）
 *   - health_collect 工具（仅 Runtime 激活：确定性 12 维采集 → 证据包 + Deterministic Findings）
 *   - client registerTaskPanel（R4 原型①/④ 形态，见 src/client/）
 * 方法论：确定性归脚本、判断归模型、证据锚定——总体状态 = 最差确定性严重度，模型不可降级。
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { TaskType, TaskRecord, TaskBuildContext } from '@opendb-dsh/tasks';

// 采集半边（collectNode/summarize/analyzeCluster + 12 维采集器）供 tool-health-collect 复用
export { collectNode, summarize, analyzeCluster } from './collect.ts';
export type { HealthCollectResult, NodeHealth, ClusterFinding } from './collect.ts';
export { COLLECTORS, THRESHOLDS, worstOf, LEVEL_ORDER } from './collectors.ts';
export type { DetFinding, DetLevel, DimResult, QueryFn } from './collectors.ts';

export const name = 'task-health';
export const inject = ['opendbTasks'];

interface HealthConfig { nodes: string[]; node: string; dims: string[]; focus: string }

/**
 * 目标节点解析（2026-08-22 事故修复）：模型建任务时常填单数 `node`（与 sqlreview/wdr/ddl
 * 三个类型的字段名一致），此前只读 `nodes` 数组 → 单数被忽略 → 退化成「该 agent 全部绑定
 * 节点」，用户说"给 og5 建巡检"实际起了 403 节点的巡检。两种写法一律接受并合并。
 */
export function resolveTargets(config: { nodes?: string[]; node?: string }): string[] {
  const list = [
    ...(Array.isArray(config.nodes) ? config.nodes : []),
    ...(typeof config.node === 'string' && config.node !== '' ? [config.node] : []),
  ].map((s) => String(s).trim()).filter((s) => s !== '');
  return [...new Set(list)];
}

export const HEALTH_TASK_TYPE: TaskType<HealthConfig> = {
  key: 'health',
  title: '健康检查',
  runMode: 'session',
  report: 'required',
  defaultCron: '0 8 * * *',
  configSchema: z.object({
    nodes: z.array(z.string()).default([]).description('检查的节点名单；空 = 该 agent 绑定的全部节点（>1 个自动出集群汇总报告）'),
    node: z.string().default('').description('单个目标节点名（与 nodes 等价、可二选一；两者都填则合并）'),
    dims: z.array(z.string()).default([]).description('维度白名单（overview/waits/slowsql/xact/bloat/lwlock/lockchain/connections/ckpt/replication/objects/concurrency）；空 = 全部 12 维'),
    focus: z.string().default('').description('本任务额外关注点（如"重点看锁等待"）'),
  }),
  reportSchema: z.object({
    scope: z.string().required().description('instance | cluster'),
    det: z.object({
      worst: z.string().required().description('ok|notice|warn|critical，逐字来自 health_collect'),
      counts: z.object({ ok: z.number(), notice: z.number(), warn: z.number(), critical: z.number() }).required(),
      byNode: z.array(z.object({ node: z.string().required(), worst: z.string().required() })).required(),
    }).required(),
    findings: z.array(z.object({
      node: z.string().required(),
      dim: z.string().default('').description('所属维度 key（overview/waits/…，逐字来自 health_collect）'),
      item: z.string().required(),
      level: z.string().required().description('ok|notice|warn|critical'),
      detail: z.string().default(''),
      code: z.string().default(''),
      metric: z.string().default(''),
      value: z.string().default(''),
      threshold: z.string().default(''),
      evidence: z.string().default(''),
    })).required(),
    clusterFindings: z.array(z.object({
      item: z.string().required(), level: z.string().required(), detail: z.string().default(''), nodes: z.array(z.string()).default([]),
    })).default([]),
    priorities: z.array(z.object({
      p: z.string().required().description('P0|P1|P2'), action: z.string().required(), refs: z.array(z.string()).default([]),
    })).default([]),
    rootCause: z.string().default('').description('根因串联叙述（多条发现同源时说明因果链）'),
    collectionNotes: z.array(z.string()).default([]),
  }),
  async buildPrompt(task: TaskRecord<HealthConfig>, _run, ctx: TaskBuildContext): Promise<string> {
    const bound = await ctx.nodesOf(task.agentId);
    const targets = resolveTargets(task.config);
    const picked = targets.length > 0 ? bound.filter((n) => targets.includes(n.name)) : bound;
    const names = picked.map((n) => n.name);
    // 未指定目标且绑定节点很多时，逐节点采集不可行也没必要——转舰队聚合模式（W6 已验证打法）
    if (targets.length === 0 && bound.length > 16) {
      return [
        `请对本智能体管理的 ${bound.length} 个节点执行舰队健康巡检（聚合模式，不要逐节点采集）：`,
        `1. 先调 metrics_fleet_overview 拿全舰队总览：采集覆盖率、每指标聚合、异常值 Top 节点、无数据节点；`,
        `2. 对异常榜前几名挑最多 5 个节点，用 health_collect（nodes 传这几个节点名）做确定性深检；`,
        `3. 覆盖率不足 95% 本身就是 warn 级发现。`,
        task.config.focus !== '' ? `\n本次额外关注：${task.config.focus}` : '',
        ``,
        `报告 data 结构同单机模式：{ scope:"cluster", det:{worst,counts,byNode}, findings:[...], clusterFindings:[...], priorities, rootCause, collectionNotes }；`,
        `det/findings 必须逐字来自 health_collect 的输出，未深检的节点不得臆造发现。`,
      ].filter((l) => l !== '').join('\n');
    }
    return [
      `请对 ${names.length > 0 ? `以下 ${names.length} 个节点` : '本智能体绑定的全部节点'} 执行健康检查：${names.join(', ') || '（未绑定节点——如属异常请在报告中说明）'}`,
      ``,
      `## 步骤（严格遵循，这是锚定式健康检查，不是自由巡检）`,
      `1. 调用 health_collect${names.length > 0 ? `（nodes 传 ${JSON.stringify(names)}）` : '（不传 nodes = 全部绑定节点）'}——它运行 12 维确定性采集器，返回证据包 + Deterministic Findings（每条含 code/level/metric/value/threshold/evidence）。`,
      `2. 你只做解读，不做采集：不要用 db_query 重复采集已覆盖的维度；只有需要追查根因细节（如锁链持有者在跑什么）时才用 db_query 补充。`,
      `3. 根因串联：多条确定性发现同源时（如 XACT_LONG 卡住 vacuum → BLOAT_HIGH → LOCK_CHAIN），在 rootCause 里讲清因果链。`,
      `4. 处置排序：P0（立即）/P1（本周）/P2（排期）按影响面排——这与严重度是两个维度。`,
      task.config.focus !== '' ? `5. 本次额外关注：${task.config.focus}` : ``,
      ``,
      `## 诚实守卫`,
      `- 如果工具列表里没有 health_collect，说明采集器插件未就位：立即用 task_report 报告 severity=warn、summary 写明"health_collect 工具缺失，本次未执行锚定式检查"，det.worst 填 warn 且 findings 只写这一条——绝对禁止退回自由巡检然后自造 det。`,
      ``,
      `## 锚定纪律（违反会被驳回）`,
      `- data.scope 必须逐字取 health_collect 输出的 scope 字段（instance 或 cluster）；`,
      `- data.det 三个字段（worst/counts/byNode）必须逐字复制 health_collect 输出的同名字段，禁止改动；`,
      `- data.findings 必须包含 health_collect 的每一条 Deterministic Finding（dim/code/level/metric/value/threshold/evidence 原样带上，value 转成字符串），你可以补充 detail 解读，但不得删条、不得下调 level；`,
      `- 你自己发现的补充问题也进 findings，code 留空、level 只能是 notice；`,
      `- collectionNotes 原样带上（降级的维度不得出现任何结论）；`,
      `- 引用数字必须来自证据，禁止编造。`,
      ``,
      `## 报告（task_report）`,
      `- severity 参数 = det.worst 的映射：critical→critical，warn→warn，notice/ok→ok；`,
      `- summary 一句话：总体状态 + 驱动性发现（如"告警：长事务持锁 2h 卡住 vacuum，膨胀扩散中"）；`,
      `- data 结构：{ scope, det:{worst,counts,byNode}, findings:[{node,item,level,detail,code,metric,value,threshold,evidence}], clusterFindings:[{item,level,detail,nodes}](多实例时), priorities:[{p,action,refs}], rootCause, collectionNotes }。`,
    ].filter((l) => l !== '').join('\n');
  },
};


export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  // 本包只注册 TaskType（Host/Runtime 双侧）。health_collect 工具在独立包 tool-health-collect：
  // 包内嵌套 inject 注册工具两轮 e2e 均静默不生效（多依赖数组版 + 单依赖链式版都不行）——
  // W4 事故复盘的结论再次验证：工具注册必须独立 function plugin + 顶层 inject 数据服务。
  ctx.effect(() => anyCtx.opendbTasks.register(HEALTH_TASK_TYPE), 'task-health.type');
}
