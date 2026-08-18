import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { TaskType, TaskRecord, TaskBuildContext } from '@opendb-dsh/tasks';

export const name = 'task-sql-audit';
export const inject = ['opendbTasks'];

interface SqlAuditConfig { node: string; topN: number; minCalls: number }

export const SQL_AUDIT_TASK_TYPE: TaskType<SqlAuditConfig> = {
  key: 'sql-audit',
  title: 'SQL 审核',
  runMode: 'session',
  report: 'required',
  defaultCron: '0 9 * * *',
  configSchema: z.object({
    node: z.string().default('').description('要审核的节点名；空 = agent 的唯一绑定节点'),
    topN: z.number().step(1).min(1).max(50).default(10).description('按总耗时取前 N 条真实负载 SQL'),
    minCalls: z.number().step(1).min(1).default(2).description('至少执行过几次才纳入审核'),
  }),
  reportSchema: z.object({
    findings: z.array(z.object({
      sql: z.string().required().description('被审核 SQL（可截断）'),
      issue: z.string().required().description('发现的问题/反模式'),
      suggestion: z.string().required().description('优化建议（索引/改写/参数）'),
      evidence: z.string().default('').description('依据：调用次数/耗时/EXPLAIN 关键行'),
    })).required(),
  }),
  async buildPrompt(task: TaskRecord<SqlAuditConfig>, _run, ctx: TaskBuildContext): Promise<string> {
    const bound = await ctx.nodesOf(task.agentId);
    const target = task.config.node !== '' ? task.config.node : (bound[0]?.name ?? '');
    return [
      `请对节点「${target}」的真实负载 SQL 做一轮审核：`,
      ``,
      `1. 用 db_query 从监控视图取按总耗时排序的前 ${task.config.topN} 条语句（执行次数 ≥ ${task.config.minCalls}），openGauss 参考：`,
      '   SELECT left(query, 300) AS query, n_calls, total_elapse_time, n_returned_rows FROM dbe_perf.statement WHERE n_calls >= ' + String(task.config.minCalls) + ' ORDER BY total_elapse_time DESC LIMIT ' + String(task.config.topN),
      `2. 逐条审查反模式：SELECT *、无 WHERE 全表扫、缺失索引、隐式类型转换、大批量单条提交、排序/聚合溢出、N+1 等；`,
      `3. 可疑的用 EXPLAIN <语句> 验证访问路径（只读，EXPLAIN ANALYZE 会被平台拒绝，不要用）；必要时用 db_query 查表结构与既有索引辅助判断；`,
      `4. 平台内部管控语句（dbe_perf/pg_catalog 自身查询）跳过不审。`,
      ``,
      `报告要求：data.findings 每项 {sql, issue, suggestion, evidence}；没有任何问题时 findings 给一条 {sql:'-', issue:'无', suggestion:'保持现状', evidence:'Top ${task.config.topN} 均无反模式'} 并 severity=ok；有建索引级别建议 → warn；有正在造成明显性能问题的 → critical。`,
    ].join('\n');
  },
};

export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  ctx.effect(() => anyCtx.opendbTasks.register(SQL_AUDIT_TASK_TYPE), 'task-sql-audit.type');
}
