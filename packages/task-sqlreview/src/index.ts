/**
 * task-sqlreview — Top SQL 报表（原「SQL 审核与优化」，R5 重构 2026-08-27，user 定稿）。
 * 榜单维度由任务配置决定（会话里说"按执行次数和耗时"即写入 dimensions），采集器产出
 * 负载总量 / 各维度榜单 / 去重 Top SQL 明细（指标·占比·榜位·类型·计划·归因的规范违规）/ 一眼结论，
 * 全部存档供面板直读；模型只做逐条优化解读（改写 → EXPLAIN 实证）与优先级/根因叙述。
 * 只读定位：平台只呈现建议与验证结论，不代执行任何 DDL/变更。
 * 工具半边在独立包 tool-sqlreview-collect（W4/task-health 两次事故的定论：工具必须独立 function plugin）。
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { TaskType, TaskRecord, TaskBuildContext } from '@opendb-dsh/tasks';
import { SQLREVIEW_THRESHOLD_SPECS } from './rules.ts';
import { DIMENSIONS, DIM_KEYS, DEFAULT_DIMENSIONS, normalizeDimensions } from './topsql.ts';

export { runCatalogRules, textRules, worstRuleLevel, LEVEL_ORDER, SQLREVIEW_THRESHOLDS, SQLREVIEW_THRESHOLD_SPECS, withSqlreviewThresholds } from './rules.ts';
export type { SqlreviewThresholds } from './rules.ts';
export type { RuleFinding, RuleLevel, SlowSqlText } from './rules.ts';
export { scanSql, explainOne, annotatePlan, topCost, shortKey } from './sqlscan.ts';
export type { SqlItem, PlanFinding } from './sqlscan.ts';
export {
  DIMENSIONS, DIM_KEYS, DEFAULT_DIMENSIONS, normalizeDimensions, buildTopSql, fetchWorkload, attributeRules, insightsOf,
  classify, referencedTables, dimValue, sharesOf, STATEMENT_FILTER,
} from './topsql.ts';
export type { DimKey, DimSpec, DimUnit, SqlMetrics, Workload, SqlKind, TopSqlItem, Board, Insight, TopSqlResult } from './topsql.ts';

export const name = 'task-sqlreview';
export const inject = ['opendbTasks', 'opendbThresholds'];

interface SqlReviewConfig { node: string; dimensions: string[]; topN: number; sqls: string[]; focus: string }

const DIM_HELP = DIM_KEYS.map((k) => `${k}=${DIMENSIONS[k].label}`).join('、');

export const SQLREVIEW_TASK_TYPE: TaskType<SqlReviewConfig> = {
  key: 'sqlreview',
  title: 'Top SQL 报表',
  runMode: 'session',
  report: 'required',
  defaultCron: '0 18 * * *',
  configSchema: z.object({
    node: z.string().default('').description('目标节点名；空 = 该 agent 唯一绑定节点'),
    dimensions: z.array(z.string()).default([...DEFAULT_DIMENSIONS]).description(`榜单维度，每个维度各出一榜（用户说"按执行次数和耗时"→ ["calls","elapsed"]）：${DIM_HELP}`),
    topN: z.number().step(1).min(1).max(20).default(5).description('每个维度榜单条数（Top-N）'),
    sqls: z.array(z.string()).default([]).description('额外指定要分析的 SQL 文本（会话贴 SQL 场景；与榜单并存）'),
    focus: z.string().default('').description('本任务额外关注点（只影响模型解读，不改采集）'),
  }),
  /**
   * 报告只装叙述：数字/榜单/违规全部在采集存档里（面板直读）。每条上榜 SQL 按 key 对应一项
   * 优化解读；旧版报告（含 text/plan/ruleFindings 的大对象）面板按兼容视图显示。
   */
  reportSchema: z.object({
    scope: z.string().required().description('sql-set'),
    det: z.object({
      worst: z.string().required().description('ok|notice|warn|critical，逐字来自 sqlreview_collect'),
      counts: z.object({ ok: z.number(), notice: z.number(), warn: z.number(), critical: z.number() }).required(),
    }).required(),
    sqlItems: z.array(z.object({
      key: z.string().required().description('逐字来自工具 sqlItems[].key'),
      optimizedSql: z.string().default('').description('优化后 SQL；无优化空间时空串'),
      newCost: z.string().default('').description('新计划总 cost（必须来自你实际执行的 EXPLAIN 输出）'),
      costDropPct: z.string().default('').description('cost 降幅百分比（仅 verify=explain-verified 时给）'),
      verify: z.string().required().description('explain-verified | estimated | no-gain | plan-unavailable'),
      detail: z.string().default('').description('解读：瓶颈归因 + 建议（索引类建议写明[需人工执行·预估]）；引用数字须有出处'),
    })).required(),
    priorities: z.array(z.object({
      p: z.string().required(), action: z.string().required(), refs: z.array(z.string()).default([]),
    })).default([]),
    rootCause: z.string().default(''),
    collectionNotes: z.array(z.string()).default([]),
  }),
  async buildPrompt(task: TaskRecord<SqlReviewConfig>, _run, ctx: TaskBuildContext): Promise<string> {
    const bound = await ctx.nodesOf(task.agentId);
    const nodeName = task.config.node !== '' ? task.config.node : (bound.length === 1 ? bound[0].name : '');
    const dims = normalizeDimensions(task.config.dimensions);
    const dimLabels = dims.map((d) => DIMENSIONS[d].label).join('、');
    const sqls = Array.isArray(task.config.sqls) ? task.config.sqls : [];
    const args = [
      nodeName !== '' ? `node 传 "${nodeName}"` : '',
      `dimensions 传 ${JSON.stringify(dims)}`,
      `topN 传 ${task.config.topN}`,
      sqls.length > 0 ? `sqls 逐字转传任务配置里的 ${sqls.length} 条指定 SQL：${JSON.stringify(sqls)}` : '',
    ].filter((s) => s !== '').join('，');
    return [
      `请对节点 ${nodeName !== '' ? `「${nodeName}」` : '（agent 绑定多节点：先用 db_nodes 确认目标，配置未指定时选第一个在线节点并在报告里说明）'} 生成 Top SQL 报表：榜单维度 = ${dimLabels}（各 Top ${task.config.topN}）${sqls.length > 0 ? ` + ${sqls.length} 条指定 SQL` : ''}。`,
      ``,
      `## 步骤（锚定式，不是自由分析）`,
      `1. 调用 sqlreview_collect（${args}）——它产出并已存档：负载总量、各维度榜单（含占全库比例）、去重后的 Top SQL 明细（指标/占比/榜位/类型判定/执行计划/脚本标注的优化点/归到该 SQL 名下的规范违规）、脚本生成的「一眼结论」。**任务面板直接读取存档，你不必复述这些数字。**`,
      `2. 逐条优化（对工具返回的每一条 sqlItems，按 key 一一对应；只对有优化空间的做改写）：`,
      `   - 改写类（SQL 写法问题）：给出优化后 SQL，然后用 db_query 执行 \`EXPLAIN <优化后SQL>\`（不要 EXPLAIN ANALYZE）取新计划总 cost，与工具给的原 cost 对比算降幅——这才算 verify=explain-verified；`,
      `   - 索引类（缺索引）：给出 CREATE INDEX 建议文本，verify 只能填 estimated（本实例无 hypopg，无法虚拟索引实证），detail 写明「[需人工执行·预估]」；`,
      `   - 事务控制 / 监控类 / OLTP 高频短语句：语句本身多半无改写空间，verify=no-gain，detail 说清"为什么总量大"（调用次数、提交等待、轮询频率、来源需确认等）；`,
      `   - 工具未取到计划的：verify=plan-unavailable，不做任何 cost 断言。`,
      `3. 规范违规已由脚本归到各条 SQL 名下（级别不可改）；detail 里可以结合它们解释瓶颈。`,
      task.config.focus !== '' ? `4. 本次额外关注：${task.config.focus}` : ``,
      ``,
      `## 诚实守卫`,
      `- 工具列表没有 sqlreview_collect 时：直接 task_report severity=warn、summary 写明"sqlreview_collect 工具缺失"，det.worst=warn，sqlItems 留一条 key="-" verify=plan-unavailable 说明——禁止退回自由分析。`,
      ``,
      `## 锚定纪律（违反会被驳回）`,
      `- data.det 逐字复制工具输出的 det；data.sqlItems 的 key 必须逐字来自工具，工具给的每条 SQL 都要有对应一项，不得漏条；`,
      `- newCost 只能来自你本会话里 db_query EXPLAIN 的真实输出，costDropPct 只在 explain-verified 时计算；`,
      `- 引用数字必须有出处（工具输出或你的 EXPLAIN），禁止编造。`,
      ``,
      `## 报告（task_report）`,
      `- severity = det.worst 映射：critical→critical，warn→warn，notice/ok→ok；`,
      `- summary 一句话：负载集中在哪（引用一眼结论）+ 最有价值的优化结论；`,
      `- data 结构：{ scope:"sql-set", det:{worst,counts}, sqlItems:[{key,optimizedSql,newCost,costDropPct,verify,detail}], priorities:[{p,action,refs}], rootCause, collectionNotes }。`,
    ].filter((l) => l !== '').join('\n');
  },
};

export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  ctx.effect(() => anyCtx.opendbTasks.register(SQLREVIEW_TASK_TYPE), 'task-sqlreview.type');
  ctx.effect(() => anyCtx.opendbThresholds.register(SQLREVIEW_THRESHOLD_SPECS), 'task-sqlreview.thresholds');
}
