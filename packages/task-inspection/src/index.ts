import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { TaskType, TaskRecord, TaskBuildContext } from '@opendb-dsh/tasks';

export const name = 'task-inspection';
export const inject = ['opendbTasks'];

interface InspectionConfig { nodes: string[]; focus: string }

export const INSPECTION_TASK_TYPE: TaskType<InspectionConfig> = {
  key: 'inspection',
  title: '定期巡检',
  runMode: 'session',
  report: 'required',
  defaultCron: '0 8 * * *',
  configSchema: z.object({
    nodes: z.array(z.string()).default([]).description('要巡检的节点名单；空 = 该 agent 绑定的全部节点'),
    focus: z.string().default('').description('本任务额外关注点（如"重点看锁等待"）'),
  }),
  reportSchema: z.object({
    findings: z.array(z.object({
      node: z.string().required(),
      item: z.string().required().description('检查项，如 sessions/locks/storage/replication/dict'),
      level: z.string().required().description('ok | warn | critical'),
      detail: z.string().default(''),
    })).required(),
  }),
  async buildPrompt(task: TaskRecord<InspectionConfig>, _run, ctx: TaskBuildContext): Promise<string> {
    const bound = await ctx.nodesOf(task.agentId);
    const picked = task.config.nodes.length > 0 ? bound.filter((n) => task.config.nodes.includes(n.name)) : bound;
    const nodeList = picked.map((n) => `- ${n.name}（${n.engine} ${n.host}:${n.port}，当前状态 ${n.status}）`).join('\n');
    return [
      `请对以下数据库节点执行例行巡检：`,
      nodeList !== '' ? nodeList : '（该 agent 未绑定节点——如属异常请在报告中说明）',
      ``,
      `巡检步骤（每个节点）：`,
      `1. db_overview 看整体（版本/会话/Top SQL/等待事件/锁/库大小/复制）；`,
      `2. metrics_recent 看采集指标最新值，留意 db.sessions.*、db.waiting_locks、db.connections_used_ratio 的异常；`,
      `3. dict_changes 看最近 24 小时数据字典变更，判断是否有预期外的结构改动；`,
      `4. 对发现的问题可用 db_query 追查（只读）。`,
      task.config.focus !== '' ? `\n本次额外关注：${task.config.focus}` : '',
      ``,
      `报告要求：data.findings 数组每项 {node, item, level(ok|warn|critical), detail}；正常项也要有一条 level=ok 的记录（证明查过）；severity 取全部 findings 的最高级别。`,
    ].join('\n');
  },
};

export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  ctx.effect(() => anyCtx.opendbTasks.register(INSPECTION_TASK_TYPE), 'task-inspection.type');
}
