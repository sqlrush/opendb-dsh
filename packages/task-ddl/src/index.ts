/**
 * task-ddl — 任务重做 #4：DDL 规范扫描与变更历史追溯（user 2026-08-21 增补）。
 * 时间轴回答三问：什么时间、由哪个用户、做过什么变更。三源阶梯（字典/审计/dbe_perf），
 * 用户归因依赖审计查询权限（AUDITADMIN），无权限时如实降级为"何时/何对象/何变更"。
 * 会话版本 = ddl_collect 工具在任意会话可用（"og5 最近一周谁改过表"）；任务版本 = 本类型。
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { TaskType, TaskRecord, TaskBuildContext } from '@opendb-dsh/tasks';
import { DDL_THRESHOLD_SPECS } from './ddl.ts';

export { dictToTimeline, auditToTimeline, mergeTimeline, scanDdlRules, worstOf, timelineStats, LEVEL_ORDER, DDL_THRESHOLDS, DDL_THRESHOLD_SPECS, withDdlThresholds } from './ddl.ts';
export type { DdlThresholds } from './ddl.ts';
export type { TimelineEntry, DdlRuleFinding, DdlLevel } from './ddl.ts';

export const name = 'task-ddl';
export const inject = ['opendbTasks', 'opendbThresholds'];

interface DdlConfig { node: string; hours: number; focus: string }

export const DDL_TASK_TYPE: TaskType<DdlConfig> = {
  key: 'ddl',
  title: 'DDL 规范与变更追溯',
  runMode: 'session',
  report: 'required',
  defaultCron: '0 10 * * *',
  configSchema: z.object({
    node: z.string().default('').description('目标节点名；空 = 该 agent 唯一绑定节点'),
    hours: z.number().step(1).min(1).max(24 * 30).default(168).description('回溯窗口（小时，默认 7 天）'),
    focus: z.string().default('').description('本任务额外关注点（如"重点看谁动了 orders 表"）'),
  }),
  reportSchema: z.object({
    scope: z.string().required().description('ddl-trace'),
    node: z.string().required(),
    windowHours: z.number().required(),
    det: z.object({
      worst: z.string().required(),
      counts: z.object({ ok: z.number(), notice: z.number(), warn: z.number(), critical: z.number() }).required(),
    }).required(),
    stats: z.object({
      total: z.number().required(), added: z.number().required(), removed: z.number().required(), changed: z.number().required(),
      users: z.array(z.string()).default([]),
    }).required(),
    timeline: z.array(z.object({
      time: z.string().required(),
      action: z.string().required(),
      kind: z.string().required(),
      object: z.string().required(),
      user: z.string().default(''),
      sqlText: z.string().default(''),
      sources: z.array(z.string()).default([]),
      count: z.number().default(0),
      note: z.string().default('').description('模型解读（这条变更的意图/风险/关联）——只对关键条目补'),
    })).required(),
    ruleFindings: z.array(z.object({
      rule: z.string().required(), level: z.string().required(), object: z.string().required(),
      time: z.string().default(''), problem: z.string().required(), advice: z.string().default(''), evidence: z.string().default(''),
    })).required(),
    auditAvailable: z.boolean().required().description('审计源是否可用（决定"由哪个用户"是否有答案）'),
    priorities: z.array(z.object({ p: z.string().required(), action: z.string().required(), refs: z.array(z.string()).default([]) })).default([]),
    rootCause: z.string().default('').description('变更故事线叙述（谁在什么阶段做了什么、是否成体系）'),
    collectionNotes: z.array(z.string()).default([]),
  }),
  async buildPrompt(task: TaskRecord<DdlConfig>, _run, ctx: TaskBuildContext): Promise<string> {
    const bound = await ctx.nodesOf(task.agentId);
    const nodeName = task.config.node !== '' ? task.config.node : (bound.length === 1 ? bound[0].name : '');
    return [
      `请对节点 ${nodeName !== '' ? `「${nodeName}」` : '（先用 db_nodes 确认目标并在报告里说明）'} 做 DDL 规范扫描与变更历史追溯（回溯 ${task.config.hours} 小时）。`,
      ``,
      `## 步骤（锚定式）`,
      `1. 调用 ddl_collect${nodeName !== '' ? `（node 传 "${nodeName}"${task.config.hours !== 168 ? `，hours 传 ${task.config.hours}` : ''}）` : ''}——它产出：变更时间轴（字典变更为主干，审计日志有权限时补齐"由哪个用户+DDL 原文"）+ 确定性规范扫描 ruleFindings + 统计。`,
      `2. 解读（你的价值）：把时间轴讲成"变更故事线"（rootCause）——哪些变更成体系（如一次部署批量建表）、哪些孤立可疑（业务时段单删一张表）、抖动对象背后可能是什么；对关键条目在 timeline[].note 里补一句意图/风险判断。`,
      `3. 需要核对对象现状时可用 db_query（只读）。`,
      task.config.focus !== '' ? `4. 本次额外关注：${task.config.focus}` : ``,
      ``,
      `## 诚实守卫`,
      `- 工具列表没有 ddl_collect：task_report severity=warn，summary 写明工具缺失——禁止自由分析；`,
      `- auditAvailable=false 时如实说明"用户归因不可用"（collectionNotes 里有解锁方法），不要猜测操作者。`,
      ``,
      `## 锚定纪律（违反会被驳回）`,
      `- data 的 scope/node/windowHours/det/stats/timeline/ruleFindings/auditAvailable/collectionNotes 全部逐字来自 ddl_collect（timeline 只允许新增 note 字段）；不得删条、不得下调 level、不得虚构 user；`,
      `- 引用时间/对象/用户必须来自证据。`,
      ``,
      `## 报告（task_report）`,
      `- severity = det.worst 映射：critical→critical，warn→warn，notice/ok→ok；`,
      `- summary 一句话：窗口内变更态势 + 最值得注意的一条（含操作者，若可归因）；`,
      `- data 以工具输出为骨架，附加 timeline[].note / priorities / rootCause。`,
    ].filter((l) => l !== '').join('\n');
  },
};

export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  ctx.effect(() => anyCtx.opendbTasks.register(DDL_TASK_TYPE), 'task-ddl.type');
  ctx.effect(() => anyCtx.opendbThresholds.register(DDL_THRESHOLD_SPECS), 'task-ddl.thresholds');
}
