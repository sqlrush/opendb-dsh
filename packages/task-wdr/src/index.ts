/**
 * task-wdr — 任务重做 #3：WDR 报告生成与解读（设计稿 §4）。
 * 只读定位：窗口 = 既有 WDR 快照对（绝不 create_wdr_snapshot / 不动 enable_wdr_snapshot）；
 * 七维 delta + 归因纪律由 tool-wdr-collect 确定性产出；模型只做解读/串联/优先级。
 * 换窗口在会话里说（"看下 14 点到 15 点"→ 重跑传 beginSnap/endSnap）。
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { TaskType, TaskRecord, TaskBuildContext } from '@opendb-dsh/tasks';

export {
  deltaInstanceTime, dbTimeClasses, deltaTopSql, deltaStatDatabase, deltaWaits,
  judgeWindow, worstOf, attributeSql, LEVEL_ORDER, WDR_THRESHOLDS,
} from './wdr.ts';
export type { WdrFinding, WdrLevel, TopSqlItem, DbStatDelta } from './wdr.ts';

export const name = 'task-wdr';
export const inject = ['opendbTasks'];

interface WdrConfig { node: string; beginSnap: number; endSnap: number; topN: number; focus: string }

export const WDR_TASK_TYPE: TaskType<WdrConfig> = {
  key: 'wdr',
  title: 'WDR 报告与解读',
  runMode: 'session',
  report: 'required',
  defaultCron: '0 9 * * *',
  configSchema: z.object({
    node: z.string().default('').description('目标节点名；空 = 该 agent 唯一绑定节点'),
    beginSnap: z.number().step(1).default(0).description('窗口起始快照 id；0 = 自动取最近一对相邻快照'),
    endSnap: z.number().step(1).default(0).description('窗口结束快照 id；0 = 自动'),
    topN: z.number().step(1).min(3).max(20).default(10).description('Top SQL 条数'),
    focus: z.string().default('').description('本任务额外关注点'),
  }),
  reportSchema: z.object({
    scope: z.string().required().description('wdr-window'),
    node: z.string().required(),
    window: z.object({
      beginSnap: z.number().required(), endSnap: z.number().required(),
      beginTs: z.string().required(), endTs: z.string().required(), minutes: z.number().required(),
    }).required(),
    det: z.object({
      worst: z.string().required(),
      counts: z.object({ ok: z.number(), notice: z.number(), warn: z.number(), critical: z.number() }).required(),
    }).required(),
    findings: z.array(z.object({
      dim: z.string().required(), code: z.string().required(), level: z.string().required(),
      metric: z.string().default(''), value: z.string().default(''), threshold: z.string().default(''),
      evidence: z.string().default(''), detail: z.string().default(''),
    })).required(),
    dbTime: z.object({
      totalUs: z.number().required(), avgActive: z.number().required(),
      classes: z.array(z.object({ name: z.string().required(), us: z.number().required(), share: z.number().required() })).required(),
    }).required(),
    loadProfile: z.array(z.object({ stat: z.string().required(), deltaUs: z.number().required() })).required(),
    topSql: z.array(z.object({
      sqlId: z.string().required(), text: z.string().required(), calls: z.number().default(0),
      elapsedMs: z.number().default(0), avgMs: z.number().default(0), cpuPct: z.number().default(0),
      ioPct: z.number().default(0), spillKb: z.number().default(0), attr: z.string().required(),
      share: z.number().default(0), note: z.string().default('').description('模型解读（这条在窗口里干了什么/去向）'),
    })).required(),
    waits: z.array(z.object({ type: z.string().required(), event: z.string().required(), waitUs: z.number().required(), share: z.number().default(0) })).default([]),
    snapshots: z.array(z.object({ id: z.number().required(), ts: z.string().required(), inWindow: z.boolean().default(false) })).default([]),
    nativeReport: z.string().default('').description('原生 WDR HTML 留底状态说明（工具给出，逐字带上）'),
    priorities: z.array(z.object({ p: z.string().required(), action: z.string().required(), refs: z.array(z.string()).default([]) })).default([]),
    rootCause: z.string().default(''),
    collectionNotes: z.array(z.string()).default([]),
  }),
  async buildPrompt(task: TaskRecord<WdrConfig>, _run, ctx: TaskBuildContext): Promise<string> {
    const bound = await ctx.nodesOf(task.agentId);
    const nodeName = task.config.node !== '' ? task.config.node : (bound.length === 1 ? bound[0].name : '');
    const windowArg = task.config.beginSnap > 0 && task.config.endSnap > 0
      ? `，beginSnap 传 ${task.config.beginSnap}、endSnap 传 ${task.config.endSnap}` : '（不传窗口 = 最近一对相邻快照）';
    return [
      `请对节点 ${nodeName !== '' ? `「${nodeName}」` : '（先用 db_nodes 确认目标节点并在报告里说明）'} 生成并解读 WDR 窗口报告（Top ${task.config.topN} SQL）。`,
      ``,
      `## 步骤（锚定式）`,
      `1. 调用 wdr_collect${nodeName !== '' ? `（node 传 "${nodeName}"${task.config.topN !== 10 ? `，topN 传 ${task.config.topN}` : ''}${windowArg}）` : ''}——它基于既有 WDR 快照对计算窗口 delta 七维：Load Profile / DB Time 构成 / 库级 Stat / Top SQL（含归因徽章）/ 等待事件 / Checkpoint / Cache，并产出确定性 findings。`,
      `2. 解读（这是你的价值所在）：`,
      `   - 归因纪律复述：每条 Top SQL 的 attr 是脚本按纪律定的（tmp=有下盘、cpu=cpu占比高、io=物理读占比高、blk=elapsed 高而 cpu≈0 的等待型）——你在 note 里解释这条 SQL 在窗口里做了什么、问题去向（转 SQL 优化任务 / 转健康检查锁链视角 / 属预期负载）；`,
      `   - 跨任务串联：blk 型 SQL 与健康检查的锁链发现、tmp 型与 work_mem、CACHE_LOW 与大扫描 SQL 互相印证时，写进 rootCause；`,
      `   - 窗口态势：结合 avgActive 与 DB Time 构成说清"这一小时数据库在忙什么"。`,
      `3. 需要补充细节时可用 db_query（只读；禁止 EXPLAIN ANALYZE；绝不调用 create_wdr_snapshot 或修改任何 GUC）。`,
      task.config.focus !== '' ? `4. 本次额外关注：${task.config.focus}` : ``,
      ``,
      `## 诚实守卫`,
      `- 工具列表没有 wdr_collect：task_report severity=warn，summary 写明"wdr_collect 工具缺失"，det.worst=warn——禁止退回自由分析；`,
      `- 快照不足两个/窗口无效时工具会明说：如实转述，不要臆造窗口数据。`,
      ``,
      `## 锚定纪律（违反会被驳回）`,
      `- data 的 scope/node/window/det/findings/dbTime/loadProfile/waits/snapshots/nativeReport/collectionNotes 全部逐字来自 wdr_collect 输出（findings 的 value 转字符串）；`,
      `- topSql 的既有字段逐字带上，你只新增每条的 note 解读；不得删条、不得改 attr、不得下调 level；`,
      `- 引用数字必须来自证据，禁止编造。`,
      ``,
      `## 报告（task_report）`,
      `- severity = det.worst 映射：critical→critical，warn→warn，notice/ok→ok；`,
      `- summary 一句话：窗口态势 + 驱动性结论（如"10-11 点窗口负载低，Top 耗时被 gsbench 锁等待型 UPDATE 主导"）；`,
      `- data 结构以工具输出为骨架，附加 topSql[].note / priorities / rootCause。`,
    ].filter((l) => l !== '').join('\n');
  },
};

export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  ctx.effect(() => anyCtx.opendbTasks.register(WDR_TASK_TYPE), 'task-wdr.type');
}
