import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { TaskType, TaskRecord, TaskBuildContext } from '@opendb-dsh/tasks';

export const name = 'task-incident';
export const inject = ['opendbTasks'];

interface IncidentConfig { lookbackMinutes: number; focus: string }

/**
 * 事故响应任务（P2 W1，事件驱动运维）：由 alert-ddl 检测到预期外 DDL 变更后触发（trigger_kind='alert'），
 * 也可手动/会话触发。闭环 = 告警 → 自动诊断 → 报告 → 签收；「处置」环节待暂缓池的动手能力解冻后补上。
 */
export const INCIDENT_TASK_TYPE: TaskType<IncidentConfig> = {
  key: 'incident',
  title: 'DDL 事故响应',
  runMode: 'session',
  report: 'required',
  configSchema: z.object({
    lookbackMinutes: z.number().default(120).description('诊断时回看的变更窗口（分钟）'),
    focus: z.string().default('').description('额外关注点（如"重点确认索引变更对慢查询的影响"）'),
  }),
  reportSchema: z.object({
    findings: z.array(z.object({
      node: z.string().required(),
      item: z.string().required().description('变更对象或检查项，如 table:public.orders / index / impact'),
      level: z.string().required().description('ok | warn | critical'),
      detail: z.string().default(''),
    })).required(),
    rootCause: z.string().default('').description('根因推测（谁/什么流程可能发起了该变更）'),
    actions: z.array(z.string()).default([]).description('建议动作清单（只建议，不执行——处置能力未开放）'),
  }),
  async buildPrompt(task: TaskRecord<IncidentConfig>, _run, ctx: TaskBuildContext): Promise<string> {
    const bound = await ctx.nodesOf(task.agentId);
    const minutes = task.config.lookbackMinutes > 0 ? task.config.lookbackMinutes : 120;
    return [
      `触发了 DDL 变更告警：本智能体管理的节点在近 ${minutes} 分钟内发生了数据字典结构变更，请立即诊断：`,
      `1. 用 dict_changes 查出这批变更（逐个有变更的节点看；本智能体共 ${bound.length} 个节点，`,
      `   节点多时先用 metrics_fleet_overview 确认整体水位，再聚焦有变更的节点）；`,
      `2. 判断每项变更是否像预期内操作（如临时表/巡检遗留）还是可疑改动（业务表结构被改/索引被删/权限对象变化）；`,
      `3. 对可疑变更用 db_query 追查影响面（表大小/依赖对象/近期慢查询），用 metrics_recent 看变更前后指标是否异动；`,
      `4. 综合产出事故报告。`,
      task.config.focus !== '' ? `\n额外关注：${task.config.focus}` : '',
      ``,
      `报告要求（task_report 提交）：`,
      `- data.findings：每项 {node, item, level(ok|warn|critical), detail}——每个受影响节点至少一条；`,
      `- data.rootCause：根因推测（一句话，说不清就写"未知，建议人工核查"）；`,
      `- data.actions：建议动作清单（只建议不执行，例如"如属误删索引，建议在业务低峰重建 idx_xxx"）；`,
      `- severity：无可疑变更=ok；可疑但影响可控=warn；业务对象被破坏性变更=critical。`,
    ].join('\n');
  },
};

export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  ctx.effect(() => anyCtx.opendbTasks.register(INCIDENT_TASK_TYPE), 'task-incident.type');
}
