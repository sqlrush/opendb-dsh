/**
 * task-sqlreview — 任务重做 #2：SQL 审核与优化（设计稿 docs/2026-08-21-task-redo-design.md §3）。
 * 只读定位：审核=确定性规则引擎产出违规，优化=计划锚定（原计划脚本标注优化点 → 模型改写 →
 * 模型用 EXPLAIN 只读实证新计划 cost）。平台只呈现建议与验证结论，不代执行任何 DDL/变更。
 * 工具半边在独立包 tool-sqlreview-collect（W4/task-health 两次事故的定论：工具必须独立 function plugin）。
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { TaskType, TaskRecord, TaskBuildContext } from '@opendb-dsh/tasks';

export { runCatalogRules, textRules, worstRuleLevel, LEVEL_ORDER } from './rules.ts';
export type { RuleFinding, RuleLevel, SlowSqlText } from './rules.ts';
export { scanSql, explainOne, annotatePlan, topCost, shortKey } from './sqlscan.ts';
export type { SqlItem, PlanFinding } from './sqlscan.ts';

export const name = 'task-sqlreview';
export const inject = ['opendbTasks'];

interface SqlReviewConfig { node: string; topN: number; sqls: string[]; focus: string }

export const SQLREVIEW_TASK_TYPE: TaskType<SqlReviewConfig> = {
  key: 'sqlreview',
  title: 'SQL 审核与优化',
  runMode: 'session',
  report: 'required',
  defaultCron: '0 18 * * *',
  configSchema: z.object({
    node: z.string().default('').description('目标节点名；空 = 该 agent 唯一绑定节点'),
    topN: z.number().step(1).min(1).max(20).default(5).description('线上慢 SQL 扫描条数（按均耗时 Top-N）'),
    sqls: z.array(z.string()).default([]).description('额外指定要审核/优化的 SQL 文本（会话贴 SQL 场景）'),
    focus: z.string().default('').description('本任务额外关注点'),
  }),
  reportSchema: z.object({
    scope: z.string().required().description('sql-set'),
    det: z.object({
      worst: z.string().required().description('ok|notice|warn|critical，逐字来自 sqlreview_collect'),
      counts: z.object({ ok: z.number(), notice: z.number(), warn: z.number(), critical: z.number() }).required(),
    }).required(),
    ruleFindings: z.array(z.object({
      rule: z.string().required(),
      level: z.string().required(),
      object: z.string().required(),
      problem: z.string().required(),
      advice: z.string().default(''),
      evidence: z.string().default(''),
    })).required(),
    sqlItems: z.array(z.object({
      key: z.string().required(),
      text: z.string().required(),
      calls: z.number().default(0),
      avgMs: z.number().default(0),
      origCost: z.string().default('').description('原计划总 cost（来自工具；无计划时空串）'),
      plan: z.array(z.string()).default([]).description('原执行计划行（来自工具，逐字原样——面板做行内标注）'),
      planNotes: z.array(z.string()).default([]).description('原计划优化点标注（来自工具 planFindings，逐字）'),
      optimizedSql: z.string().default('').description('优化后 SQL；无优化空间时空串'),
      newCost: z.string().default('').description('新计划总 cost（必须来自你实际执行的 EXPLAIN 输出）'),
      costDropPct: z.string().default('').description('cost 降幅百分比（仅 verify=explain-verified 时给）'),
      verify: z.string().required().description('explain-verified | estimated | no-gain | plan-unavailable'),
      detail: z.string().default('').description('解读：瓶颈归因 + 建议（索引类建议写明[需人工执行·预估]）'),
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
    return [
      `请对节点 ${nodeName !== '' ? `「${nodeName}」` : '（agent 绑定多节点：先用 db_nodes 确认目标，配置未指定时选第一个在线节点并在报告里说明）'} 执行 SQL 审核与优化（Top ${task.config.topN} 慢 SQL${task.config.sqls.length > 0 ? ` + ${task.config.sqls.length} 条指定 SQL` : ''}）。`,
      ``,
      `## 步骤（锚定式，不是自由分析）`,
      `1. 调用 sqlreview_collect${nodeName !== '' ? `（node 传 "${nodeName}"${task.config.topN !== 5 ? `，topN 传 ${task.config.topN}` : ''}${task.config.sqls.length > 0 ? `，sqls 逐字转传任务配置里的 ${task.config.sqls.length} 条指定 SQL：${JSON.stringify(task.config.sqls)}` : ''}）` : ''}——它产出：12 条确定性规则的违规清单（ruleFindings）+ Top-N 慢 SQL 的执行计划锚定包（sqlItems：原计划行、总 cost、脚本标注的优化点 planFindings）。`,
      `2. 逐条优化（只对有优化空间的做）：`,
      `   - 改写类（SQL 写法问题）：给出优化后 SQL，然后用 db_query 执行 \`EXPLAIN <优化后SQL>\`（禁止 EXPLAIN ANALYZE，会被平台拒绝）取新计划总 cost，与工具给的原 cost 对比算降幅——这才算 verify=explain-verified；`,
      `   - 索引类（缺索引）：给出 CREATE INDEX 建议文本，verify 只能填 estimated（本实例无 hypopg，无法虚拟索引实证），detail 写明「[需人工执行·预估]」；`,
      `   - 无低风险优化空间：verify=no-gain，如实说明（诚实比华丽重要）；`,
      `   - 工具未取到计划的：verify=plan-unavailable，不做任何 cost 断言。`,
      `3. 规则违规解读：结合业务常识补充 advice，但规则/级别/对象不得改。`,
      task.config.focus !== '' ? `4. 本次额外关注：${task.config.focus}` : ``,
      ``,
      `## 诚实守卫`,
      `- 工具列表没有 sqlreview_collect 时：直接 task_report severity=warn、summary 写明"sqlreview_collect 工具缺失"，det.worst=warn，两个数组各留一条说明——禁止退回自由分析。`,
      ``,
      `## 锚定纪律（违反会被驳回）`,
      `- data.det 逐字复制工具输出的 det；data.ruleFindings 必须包含工具的每一条规则违规（rule/level/object/problem/evidence 原样，advice 可补充），不得删条、不得降级；`,
      `- data.sqlItems 每条的 key/text/calls/avgMs/origCost/plan/planNotes 逐字来自工具（plan = 工具输出的执行计划行数组原样带上；planNotes = planFindings 的 detail 列表）；`,
      `- newCost 只能来自你本会话里 db_query EXPLAIN 的真实输出，costDropPct 只在 explain-verified 时计算；`,
      `- 引用数字必须有出处，禁止编造。`,
      ``,
      `## 报告（task_report）`,
      `- severity = det.worst 映射：critical→critical，warn→warn，notice/ok→ok；`,
      `- summary 一句话：违规态势 + 最有价值的优化结论；`,
      `- data 结构：{ scope:"sql-set", det:{worst,counts}, ruleFindings:[{rule,level,object,problem,advice,evidence}], sqlItems:[{key,text,calls,avgMs,origCost,planNotes,optimizedSql,newCost,costDropPct,verify,detail}], priorities:[{p,action,refs}], rootCause, collectionNotes }。`,
    ].filter((l) => l !== '').join('\n');
  },
};

export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  ctx.effect(() => anyCtx.opendbTasks.register(SQLREVIEW_TASK_TYPE), 'task-sqlreview.type');
}
