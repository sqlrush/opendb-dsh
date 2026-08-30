/**
 * task-ddl — 表结构变更追溯（R2，2026-08-30 user 定稿 docs/prototypes/ddl-r2.html；首版 2026-08-21）。
 * 时间轴回答三问：什么时间、由哪个用户、把哪张表的结构改成了什么。三源（字典含定义 / pg_object / 审计）由
 * tool-ddl-collect 合成结构历史并存档，面板直读（主干+分支演进图、线段=生命时段结构差异、GitHub 式版本比较）；
 * 模型只做解读。规则 DDLR00–07/90 与阈值沿用首版（借鉴规则不动）。
 * 会话版本 = ddl_collect 工具在任意会话可用（"og5 最近一周谁改过表"）；任务版本 = 本类型。
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { TaskType, TaskRecord, TaskBuildContext } from '@opendb-dsh/tasks';
import { DDL_THRESHOLD_SPECS } from './ddl.ts';

export { dictToTimeline, auditToTimeline, mergeTimeline, scanDdlRules, worstOf, timelineStats, LEVEL_ORDER, DDL_THRESHOLDS, DDL_THRESHOLD_SPECS, withDdlThresholds } from './ddl.ts';
export type { DdlThresholds } from './ddl.ts';
export type { TimelineEntry, DdlRuleFinding, DdlLevel } from './ddl.ts';
export { buildHistory, stateAt, diffDefinition, compareVersions, toTimelineEntries, objKey } from './history.ts';
export type { DictChangeFull, CurrentObject, PgObjectRow, AuditDdl, IndexOwner, DdlEvent, Version, Lane, SubLane, ObjectHistory, History, DiffRow, ObjectDiff, Compare } from './history.ts';

export const name = 'task-ddl';
export const inject = ['opendbTasks', 'opendbThresholds'];

interface DdlConfig { node: string; hours: number; schemas: string[]; focus: string }

export const DDL_TASK_TYPE: TaskType<DdlConfig> = {
  key: 'ddl',
  title: '表结构变更追溯',
  runMode: 'session',
  report: 'required',
  defaultCron: '0 10 * * *',
  configSchema: z.object({
    node: z.string().default('').description('目标节点名；空 = 该 agent 唯一绑定节点'),
    hours: z.number().step(1).min(1).max(24 * 30).default(168).description('回溯窗口（小时，默认 7 天）'),
    schemas: z.array(z.string()).default([]).description('只看这些 schema（空 = 全部非系统 schema）'),
    focus: z.string().default('').description('本任务额外关注点（如"重点看谁动了 orders 表"）'),
  }),
  // R2：报告只装解读——结构历史全部在采集存档里（面板直读），模型不再复制时间轴
  reportSchema: z.object({
    scope: z.string().default('ddl-trace'),
    node: z.string().default(''),
    windowHours: z.number().default(0),
    det: z.object({
      worst: z.string().required(),
      counts: z.object({ ok: z.number().default(0), notice: z.number().default(0), warn: z.number().default(0), critical: z.number().default(0) }).default({ ok: 0, notice: 0, warn: 0, critical: 0 }),
    }).required(),
    situation: z.string().default('').description('一句话：窗口内结构变更态势'),
    versionNotes: z.array(z.object({ v: z.string().required(), note: z.string().required().description('这一版（DDL 批次）的意图/风险判断') })).default([]),
    findings: z.array(z.object({ rule: z.string().required(), object: z.string().default(''), note: z.string().required().description('对该条规范发现的解读') })).default([]),
    priorities: z.array(z.object({ p: z.string().required(), action: z.string().required(), refs: z.array(z.string()).default([]) })).default([]),
    rootCause: z.string().default('').description('变更故事线（谁在什么阶段做了什么、是否成体系）'),
    collectionNotes: z.array(z.string()).default([]),
  }),
  async buildPrompt(task: TaskRecord<DdlConfig>, _run, ctx: TaskBuildContext): Promise<string> {
    const bound = await ctx.nodesOf(task.agentId);
    const nodeName = task.config.node !== '' ? task.config.node : (bound.length === 1 ? bound[0].name : '');
    const schemasArg = task.config.schemas.length > 0 ? `，schemas 传 ${JSON.stringify(task.config.schemas)}` : '';
    return [
      `请对节点 ${nodeName !== '' ? `「${nodeName}」` : '（先用 db_nodes 确认目标并在报告里说明）'} 做表结构变更追溯与规范扫描（回溯 ${task.config.hours} 小时${task.config.schemas.length > 0 ? `，只看 schema ${task.config.schemas.join(', ')}` : ''}）。`,
      ``,
      `## 步骤（锚定式）`,
      `1. 调用 ddl_collect${nodeName !== '' ? `（node 传 "${nodeName}"${task.config.hours !== 168 ? `，hours 传 ${task.config.hours}` : ''}${schemasArg}）` : ''}——它先做一次字典快照，再合并字典变更（含列/索引定义）、pg_object 建改时间与创建者、审计 DDL 原文，产出：主干版本（每个 DDL 批次一版）、各 schema/表的生命线、窗口首末结构差异、时间轴、确定性规范扫描；全部数字已存档给任务面板直读。`,
      `2. 解读（这是你的价值；数字都在工具输出里，不要复述表格）：`,
      `   - situation：一句话说清窗口内的结构变更态势（几代/几批、谁在改、有无破坏性）；`,
      `   - versionNotes[].note：对每个主干版本说明意图与风险（成体系的部署？孤立可疑的删表？建表后立刻二改？）；`,
      `   - findings[].note：对每条非 ok 的规范发现给出判断（计划内 / 需确认 / 平台自检可白名单）；`,
      `   - rootCause / priorities：串成变更故事线并给处置顺序（refs 填版本号 v3、对象名或规则码）。`,
      `3. 需要核对对象现状时可用 db_query / db_describe（只读）。`,
      task.config.focus !== '' ? `4. 本次额外关注：${task.config.focus}` : ``,
      ``,
      `## 诚实守卫`,
      `- 工具列表没有 ddl_collect：task_report severity=warn，summary 写明工具缺失——禁止自由分析；`,
      `- auditAvailable=false 时如实说明"DDL 原文与执行者不可得，建表者取自 pg_object"，不要猜测操作者。`,
      ``,
      `## 锚定纪律（违反会被驳回）`,
      `- det 逐字来自 ddl_collect；引用的时间/对象/用户/版本号必须能在工具输出里找到，禁止编造；不得下调 level。`,
      ``,
      `## 报告（task_report）`,
      `- severity = det.worst 映射：critical→critical，warn→warn，notice/ok→ok；`,
      `- summary 一句话：窗口内变更态势 + 最值得注意的一条（含操作者，若可归因）；`,
      `- data 只填解读字段：scope/node/windowHours/det/situation/versionNotes/findings/priorities/rootCause。`,
    ].filter((l) => l !== '').join('\n');
  },
};

export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  ctx.effect(() => anyCtx.opendbTasks.register(DDL_TASK_TYPE), 'task-ddl.type');
  ctx.effect(() => anyCtx.opendbThresholds.register(DDL_THRESHOLD_SPECS), 'task-ddl.thresholds');
}
