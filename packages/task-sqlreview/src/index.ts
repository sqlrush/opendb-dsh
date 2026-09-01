/**
 * task-sqlreview — Top SQL 报表（原「SQL 审核与优化」，R5 重构 2026-08-27，user 定稿）。
 * 榜单维度由任务配置决定（会话里说"按执行次数和耗时"即写入 dimensions；说"跟踪这几条"即 sqls + dimensions=[]），采集器产出
 * 负载总量 / 各维度榜单 / 去重 Top SQL 明细（指标·占比·榜位·类型·耗时构成·等待事件·计划）/ 一眼结论，
 * 全部存档供面板直读；模型只做逐条优化解读（改写 → EXPLAIN 实证）与优先级/根因叙述。
 * 规范规则（rules.ts 的 12 条）不再进这张大盘（user 2026-08-27：规范与优化方案没关系）——引擎保留给规则总览/阈值配置。
 * 只读定位：平台只呈现建议与验证结论，不代执行任何 DDL/变更。
 * 工具半边在独立包 tool-sqlreview-collect（W4/task-health 两次事故的定论：工具必须独立 function plugin）。
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { TaskType, TaskRecord, TaskBuildContext } from '@opendb-dsh/tasks';
import { SQLREVIEW_THRESHOLD_SPECS } from './rules.ts';
import { DIMENSIONS, DIM_KEYS, DEFAULT_DIMENSIONS, normalizeDimensions, resolveMode } from './topsql.ts';

export { runCatalogRules, textRules, worstRuleLevel, LEVEL_ORDER, SQLREVIEW_THRESHOLDS, SQLREVIEW_THRESHOLD_SPECS, withSqlreviewThresholds } from './rules.ts';
export type { SqlreviewThresholds } from './rules.ts';
export type { RuleFinding, RuleLevel, SlowSqlText } from './rules.ts';
export { scanSql, explainOne, annotatePlan, topCost, shortKey } from './sqlscan.ts';
export type { SqlItem, PlanFinding } from './sqlscan.ts';
export {
  DIMENSIONS, DIM_KEYS, DEFAULT_DIMENSIONS, normalizeDimensions, buildTopSql, fetchWorkload, attributeRules, insightsOf,
  classify, referencedTables, dimValue, sharesOf, STATEMENT_FILTER, fingerprint, parseWaitDetails, profileFromRows, fetchExecProfile,
  resolveMode, matchStatements, TRACK_SHARE_DIMS,
} from './topsql.ts';
export type { DimKey, DimSpec, DimUnit, SqlMetrics, Workload, SqlKind, TopSqlItem, Board, Insight, TopSqlResult, ExecProfile, WaitEvent, ReportMode } from './topsql.ts';

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
    dimensions: z.array(z.string()).default([...DEFAULT_DIMENSIONS]).description(`榜单模式：每个维度各出一榜（用户说"按执行次数和耗时"→ ["calls","elapsed"]）：${DIM_HELP}。跟踪模式（用户要跟踪对话里那几条具体 SQL）传 []，不出榜`),
    topN: z.number().step(1).min(1).max(20).default(5).description('每个维度榜单条数（Top-N）；跟踪模式忽略'),
    sqls: z.array(z.string()).default([]).description('跟踪模式：用户在对话里讨论/贴出并要求跟踪的 SQL 原文（配合 dimensions=[]，报表只含这几条）。榜单模式留空——榜单里会出现的语句不要复制进来'),
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
      baseCost: z.string().default('').description('同口径基线：你本会话 EXPLAIN 原 SQL（与优化后 SQL 用同样的参数/LIMIT）得到的总 cost；工具的 origCost 来自 ?→NULL 归一化文本时口径不同，必须给 baseCost'),
      newCost: z.string().default('').description('新计划总 cost（必须来自你实际执行的 EXPLAIN 输出，与 baseCost 同口径）'),
      costDropPct: z.string().default('').description('cost 降幅百分比 = (baseCost − newCost) / baseCost（仅 verify=explain-verified 时给）'),
      verify: z.string().required().description('explain-verified | estimated | no-gain | plan-unavailable'),
      detail: z.string().default('').description('解读：瓶颈归因 + 建议（索引类建议写明[需人工执行·预估]）；引用数字须有出处'),
    })).required(),
    priorities: z.array(z.object({
      p: z.string().required().description('优先级档位，只填 P0/P1/P2；标题与理由写进 action'),
      action: z.string().required(), refs: z.array(z.string()).default([]),
    })).default([]),
    rootCause: z.string().default(''),
    collectionNotes: z.array(z.string()).default([]),
  }),
  async buildPrompt(task: TaskRecord<SqlReviewConfig>, _run, ctx: TaskBuildContext): Promise<string> {
    const bound = await ctx.nodesOf(task.agentId);
    const nodeName = task.config.node !== '' ? task.config.node : (bound.length === 1 ? bound[0].name : '');
    const mode = resolveMode(task.config);
    const dims = mode === 'track' ? [] : normalizeDimensions(task.config.dimensions);
    const dimLabels = dims.map((d) => DIMENSIONS[d].label).join('、');
    const sqls = Array.isArray(task.config.sqls) ? task.config.sqls : [];
    const args = [
      nodeName !== '' ? `node 传 "${nodeName}"` : '',
      `dimensions 传 ${JSON.stringify(dims)}`,
      mode === 'top' ? `topN 传 ${task.config.topN}` : '',
      sqls.length > 0 ? `sqls 逐字转传任务配置里的 ${sqls.length} 条 SQL：${JSON.stringify(sqls)}` : '',
    ].filter((s) => s !== '').join('，');
    const nodeText = nodeName !== '' ? `「${nodeName}」` : '（agent 绑定多节点：先用 db_nodes 确认目标，配置未指定时选第一个在线节点并在报告里说明）';
    return [
      mode === 'track'
        ? `请对节点 ${nodeText} 生成 Top SQL 报表（跟踪模式）：只跟踪会话里指定的 ${sqls.length} 条 SQL，不出榜单。`
        : `请对节点 ${nodeText} 生成 Top SQL 报表：榜单维度 = ${dimLabels}（各 Top ${task.config.topN}）${sqls.length > 0 ? ` + ${sqls.length} 条指定 SQL` : ''}。`,
      ``,
      `## 步骤（锚定式，不是自由分析）`,
      `1. 调用 sqlreview_collect（${args}）——它产出并已存档：负载总量、${mode === 'track' ? '每条跟踪 SQL 在 dbe_perf.statement 里的运行记录（指标/占全库比例/榜位/类型判定/单次耗时构成/等待事件/执行计划/脚本标注的优化点）' : '各维度榜单（含占全库比例）、去重后的 Top SQL 明细（指标/占比/榜位/类型判定/单次耗时构成/等待事件/执行计划/脚本标注的优化点）'}、脚本生成的「一眼结论」。**任务面板直接读取存档，你不必复述这些数字。** 本报表只谈性能，不谈规范（不要调用规则/审核类内容）。`,
      `2. 逐条优化（对工具返回的每一条 sqlItems，按 key 一一对应；只对有优化空间的做改写）：`,
      `   - 改写类（SQL 写法问题）：先用 db_query 执行 \`EXPLAIN <原SQL，带你选定的真实参数/LIMIT>\` 取 baseCost，再执行 \`EXPLAIN <优化后SQL，同样的参数/LIMIT>\`（不要 EXPLAIN ANALYZE）取 newCost，降幅按 baseCost 算——同口径对比才算 verify=explain-verified（工具的 origCost 来自 ?→NULL 归一化文本，LIMIT 无界，不能拿来直接比）；`,
      `   - 索引类（缺索引）：给出 CREATE INDEX 建议文本，verify 只能填 estimated（本实例无 hypopg，无法虚拟索引实证），detail 写明「[需人工执行·预估]」；`,
      `   - 事务控制 / 监控类 / OLTP 高频短语句：语句本身多半无改写空间，verify=no-gain，detail 说清"为什么总量大"（调用次数、提交等待、轮询频率、来源需确认等）；`,
      `   - 工具未取到计划的：verify=plan-unavailable，不做任何 cost 断言。`,
      `3. detail 里结合单次耗时构成与等待事件解释瓶颈在哪（CPU / IO / 下盘 / 锁 / 提交等待），引用的数字要有出处。`,
      task.config.focus !== '' ? `4. 本次额外关注：${task.config.focus}` : ``,
      ``,
      `## 诚实守卫`,
      `- 工具列表没有 sqlreview_collect 时：直接 task_report severity=warn、summary 写明"sqlreview_collect 工具缺失"，det.worst=warn，sqlItems 留一条 key="-" verify=plan-unavailable 说明——禁止退回自由分析。`,
      ``,
      `## 锚定纪律（违反会被驳回）`,
      `- data.det 逐字复制工具输出的 det；data.sqlItems 的 key 必须逐字来自工具，工具给的每条 SQL 都要有对应一项，不得漏条；`,
      `- baseCost / newCost 只能来自你本会话里 db_query EXPLAIN 的真实输出且同口径，costDropPct 只在 explain-verified 时计算；`,
      `- 引用数字必须有出处（工具输出或你的 EXPLAIN），禁止编造。`,
      ``,
      `## 报告（task_report）`,
      `- severity = det.worst 映射：critical→critical，warn→warn，notice/ok→ok；`,
      `- summary 一句话：负载集中在哪（引用一眼结论）+ 最有价值的优化结论；`,
      `- data 结构：{ scope:"sql-set", det:{worst,counts}, sqlItems:[{key,optimizedSql,baseCost,newCost,costDropPct,verify,detail}], priorities:[{p,action,refs}], rootCause, collectionNotes }。`,
    ].filter((l) => l !== '').join('\n');
  },
};

export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  ctx.effect(() => anyCtx.opendbTasks.register(SQLREVIEW_TASK_TYPE), 'task-sqlreview.type');
  ctx.effect(() => anyCtx.opendbThresholds.register(SQLREVIEW_THRESHOLD_SPECS), 'task-sqlreview.thresholds');
}
