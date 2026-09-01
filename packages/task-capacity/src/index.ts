/**
 * task-capacity — 容量与增长报告（R1，2026-08-31 user 通过 docs/prototypes/capacity-r1.html 后开发）。
 * 回答四问：现在多大、涨多快、还能撑多久、空间花在哪（业务表 vs 非表占用）。
 * 数字全部由 tool-capacity-collect 确定性采集：库 / 表空间 / schema / Top 表 / 系统占用（statement_history、WDR、WAL、日志、审计、core）
 * + 采样时序（opendb_capacity_samples：增速回归、对象级 24h 增量、采集空窗）+ 字典建/删批次做趋势图事件标注；
 * 整包存档 opendb_task_collects，面板直读；模型只写解读（situation / findings[].note / rootCause / priorities）。
 * 会话版本 = capacity_collect 工具在任意会话可用（"og5 这库为什么这么大"）；任务版本 = 本类型（默认每日 02:00）。
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { TaskType, TaskRecord, TaskBuildContext } from '@opendb-dsh/tasks';
import { CAP_THRESHOLD_SPECS } from './capacity.ts';

export { CAP_THRESHOLDS, CAP_THRESHOLD_SPECS, withCapThresholds, linearSlope, growthStats, daysToFull, findGaps, judgeCapacity, worstOf, countLevels, LEVEL_ORDER, GIB } from './capacity.ts';
export type { CapLevel, CapThresholds, CapFinding, CapInput, GrowthStats, SamplePoint } from './capacity.ts';

export const name = 'task-capacity';
export const inject = ['opendbTasks', 'opendbThresholds'];

interface CapacityConfig { node: string; topN: number; growthWindowDays: number; focus: string }

export const CAPACITY_TASK_TYPE: TaskType<CapacityConfig> = {
  key: 'capacity',
  title: '容量与增长',
  runMode: 'session',
  report: 'required',
  defaultCron: '0 2 * * *',
  configSchema: z.object({
    node: z.string().default('').description('目标节点名；空 = 该 agent 唯一绑定节点'),
    topN: z.number().step(1).min(5).max(50).default(20).description('Top 对象条数（存档里始终保留 50）'),
    growthWindowDays: z.number().step(1).min(1).max(90).default(7).description('增速回归的观测窗（天）'),
    focus: z.string().default('').description('本任务额外关注点（如"重点看 statement_history 有没有继续涨"）'),
  }),
  // 报告只装解读——数字全在采集存档里（面板直读）
  reportSchema: z.object({
    scope: z.string().default('capacity'),
    node: z.string().default(''),
    det: z.object({
      worst: z.string().required(),
      counts: z.object({ ok: z.number().default(0), notice: z.number().default(0), warn: z.number().default(0), critical: z.number().default(0) }).default({ ok: 0, notice: 0, warn: 0, critical: 0 }),
    }).required(),
    situation: z.string().default('').description('一句话：现在多大、涨多快、空间主要花在哪'),
    findings: z.array(z.object({ rule: z.string().required(), object: z.string().default(''), note: z.string().required().description('对该条发现的解读：为什么、影响谁、要不要动') })).default([]),
    priorities: z.array(z.object({ p: z.string().required().description('优先级档位，只填 P0/P1/P2；标题与理由写进 action'), action: z.string().required(), refs: z.array(z.string()).default([]) })).default([]),
    rootCause: z.string().default('').description('串联：这个库"大"和"涨"的原因分别是什么'),
    collectionNotes: z.array(z.string()).default([]),
  }),
  async buildPrompt(task: TaskRecord<CapacityConfig>, _run, ctx: TaskBuildContext): Promise<string> {
    const bound = await ctx.nodesOf(task.agentId);
    const nodeName = task.config.node !== '' ? task.config.node : (bound.length === 1 ? bound[0].name : '');
    const args = [
      nodeName !== '' ? `node 传 "${nodeName}"` : '',
      task.config.topN !== 20 ? `topN 传 ${task.config.topN}` : '',
      task.config.growthWindowDays !== 7 ? `growthWindowDays 传 ${task.config.growthWindowDays}` : '',
    ].filter((s) => s !== '');
    return [
      `请对节点 ${nodeName !== '' ? `「${nodeName}」` : '（先用 db_nodes 确认目标并在报告里说明）'} 做容量与增长分析（观测窗 ${task.config.growthWindowDays} 天，Top ${task.config.topN} 对象）。`,
      ``,
      `## 步骤（锚定式）`,
      `1. 调用 capacity_collect${args.length > 0 ? `（${args.join('，')}）` : ''}——它一次采齐：库/表空间/schema/Top 表大小、死元组与 analyze 新鲜度、非表占用（WAL / 全量 SQL 追踪 statement_history / WDR 快照 / pg_log / pg_audit / core）、相关 GUC、`,
      `   平台里的历史采样（增速回归、对象级 24h 增量、采集空窗）与字典建/删批次；判定 CAP_* 由脚本给出；整包已存档，面板直读。`,
      `2. 解读（这是你的价值；数字都在工具输出里，不要复述表格）：`,
      `   - situation：一句话说清现在多大、涨多快、空间主要花在哪；`,
      `   - findings[].note：对每条非 ok 的发现说清为什么、影响谁、要不要动（平台只读，动作由 DBA 执行）；`,
      `   - rootCause：把"大"（构成）和"涨"（增速与 Top 增长对象）的原因分别串起来，非表占用要点名是哪个参数/保留策略在决定它；`,
      `   - priorities：处置顺序（refs 填规则码或对象名），P1 必须是最省事、收益最大的那条。`,
      `3. 需要核对某张表或某个参数时可用 db_query / db_describe（只读）。`,
      task.config.focus !== '' ? `4. 本次额外关注：${task.config.focus}` : ``,
      ``,
      `## 诚实守卫`,
      `- 工具列表没有 capacity_collect：task_report severity=warn，summary 写明工具缺失——禁止自由分析；`,
      `- 首次采样（firstRun=true）或采集空窗时如实说"增速/24h 增量暂不可得"，不要用当前大小编造增速；`,
      `- 没有主机侧磁盘数据（disk 缺失）时不要说"还能撑 N 天"，只说增速。`,
      ``,
      `## 锚定纪律（违反会被驳回）`,
      `- det 逐字来自 capacity_collect；引用的大小/行数/参数值必须能在工具输出里找到，禁止编造；不得下调 level。`,
      ``,
      `## 报告（task_report）`,
      `- severity = det.worst 映射：critical→critical，warn→warn，notice/ok→ok；`,
      `- summary 一句话：多大 + 涨多快 + 最值得先处理的一条；`,
      `- data 只填解读字段：scope/node/det/situation/findings/priorities/rootCause。`,
    ].filter((l) => l !== '').join('\n');
  },
};

export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  ctx.effect(() => anyCtx.opendbTasks.register(CAPACITY_TASK_TYPE), 'task-capacity.type');
  ctx.effect(() => anyCtx.opendbThresholds.register(CAP_THRESHOLD_SPECS), 'task-capacity.thresholds');
}
