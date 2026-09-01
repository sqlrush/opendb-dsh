/**
 * task-wdr — WDR 窗口报告（R2，2026-08-29 user 定稿 docs/prototypes/wdr-r2.html）。
 * 只读定位：窗口 = 既有 WDR 快照对（绝不 create_wdr_snapshot / 不动 enable_wdr_snapshot）；
 * 全部数字由 tool-wdr-collect 按快照增量确定性产出并存档 opendb_task_collects，面板直读；
 * 模型只做解读（Top SQL 逐条 note / 发现逐条解读 / 根因串联 / 优先级）。
 * 换窗口在会话里说（"看下 14 点到 15 点"→ 重跑传 beginSnap/endSnap）。
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { TaskType, TaskRecord, TaskBuildContext } from '@opendb-dsh/tasks';
import { WDR_THRESHOLD_SPECS } from './wdr.ts';

export {
  deltaInstanceTime, dbTimeClasses, deltaTopSql, deltaStatDatabase, deltaWaits,
  judgeWindow, worstOf, attributeSql, LEVEL_ORDER, WDR_THRESHOLDS,
  WDR_THRESHOLD_SPECS, withWdrThresholds,
} from './wdr.ts';
export type { WdrFinding, WdrLevel, TopSqlItem, DbStatDelta, WdrThresholds } from './wdr.ts';
export {
  pick, sumBy, delta, aasTrend, dbTimeBreakdown, topSqlFull, isProbe, waitsFull, loadProfile,
  hostStat, efficiency, summaryOf, checksOf, insightsOf, fmtBytes,
} from './window.ts';
export type {
  Snap, InstRow, TrendPoint, Breakdown, StmtRowFull, TopSqlFull, WaitRowFull, WaitItem, Waits, WindowRaw,
  LpRow, LpUnit, OsRow, HostStat, Efficiency, Summary, CheckRow, Insight,
} from './window.ts';

export const name = 'task-wdr';
export const inject = ['opendbTasks', 'opendbThresholds'];

interface WdrConfig { node: string; beginSnap: number; endSnap: number; topN: number; hideProbes: boolean; focus: string }

export const WDR_TASK_TYPE: TaskType<WdrConfig> = {
  key: 'wdr',
  title: 'WDR 窗口报告',
  runMode: 'session',
  report: 'required',
  defaultCron: '0 9 * * *',
  configSchema: z.object({
    node: z.string().default('').description('目标节点名；空 = 该 agent 唯一绑定节点'),
    beginSnap: z.number().step(1).default(0).description('窗口起始快照 id；0 = 自动取最近一对相邻快照'),
    endSnap: z.number().step(1).default(0).description('窗口结束快照 id；0 = 自动'),
    topN: z.number().step(1).min(3).max(40).default(10).description('模型解读的 Top SQL 条数（面板可看更多）'),
    hideProbes: z.boolean().default(false).description('面板默认隐藏连接探针类语句（select version() / current_user 等）'),
    focus: z.string().default('').description('本任务额外关注点'),
  }),
  // R2：报告只装解读——所有数字在采集存档里（面板直读），模型不再复制数据
  reportSchema: z.object({
    scope: z.string().default('wdr-window'),
    node: z.string().default(''),
    window: z.object({ beginSnap: z.number().default(0), endSnap: z.number().default(0) }).default({ beginSnap: 0, endSnap: 0 }),
    det: z.object({
      worst: z.string().required(),
      counts: z.object({ ok: z.number().default(0), notice: z.number().default(0), warn: z.number().default(0), critical: z.number().default(0) }).default({ ok: 0, notice: 0, warn: 0, critical: 0 }),
    }).required(),
    situation: z.string().default('').description('窗口态势一句话（这段时间数据库在忙什么）'),
    topSql: z.array(z.object({
      sqlId: z.string().required(), note: z.string().required().description('这条 SQL 在窗口里做了什么 / 问题去向（转 Top SQL 优化任务 / 锁链视角 / 属预期负载）'),
    })).default([]),
    findings: z.array(z.object({ code: z.string().required(), note: z.string().required().description('对该项发现的解读（跨维度互证 / 影响面）') })).default([]),
    priorities: z.array(z.object({ p: z.string().required().description('优先级档位，只填 P0/P1/P2；标题与理由写进 action'), action: z.string().required(), refs: z.array(z.string()).default([]) })).default([]),
    rootCause: z.string().default(''),
    collectionNotes: z.array(z.string()).default([]),
  }),
  async buildPrompt(task: TaskRecord<WdrConfig>, _run, ctx: TaskBuildContext): Promise<string> {
    const bound = await ctx.nodesOf(task.agentId);
    const nodeName = task.config.node !== '' ? task.config.node : (bound.length === 1 ? bound[0].name : '');
    const windowArg = task.config.beginSnap > 0 && task.config.endSnap > 0
      ? `，beginSnap 传 ${task.config.beginSnap}、endSnap 传 ${task.config.endSnap}` : '（不传窗口 = 最近一对相邻快照）';
    return [
      `请对节点 ${nodeName !== '' ? `「${nodeName}」` : '（先用 db_nodes 确认目标节点并在报告里说明）'} 生成并解读 WDR 窗口报告（解读 Top ${task.config.topN} SQL）。`,
      ``,
      `## 步骤（锚定式）`,
      `1. 调用 wdr_collect${nodeName !== '' ? `（node 传 "${nodeName}"${task.config.topN !== 10 ? `，topN 传 ${task.config.topN}` : ''}${windowArg}）` : ''}——它基于既有 WDR 快照对计算窗口增量：摘要（vs 上一窗口）/ 最近 24 窗口 AAS 趋势 / DB Time 构成 / 等待事件 / Load Profile / Top SQL（多维指标 + 归因徽章）/ IO·WAL·Checkpoint·主机 / 阈值判定，并把全部数字存档给任务面板直读。`,
      `2. 解读（这是你的价值所在；数字都在工具输出里，不要复述表格）：`,
      `   - situation：一句话说清"这段时间数据库在忙什么"（结合 AAS 与趋势中位、DB Time 构成、主导等待）；`,
      `   - topSql[].note：逐条解释这条 SQL 在窗口里做了什么、问题去向（转 Top SQL 优化任务 / 转健康检查锁链视角 / 属预期负载）——attr 是脚本按纪律定的（tmp=有下盘、cpu=cpu 占自身 ≥50%、io=物理读占自身 ≥30%、blk=耗时高而 cpu/io 双低），不要改它；probe=true 的连接探针只需一句"采集器心跳，无需处理"；`,
      `   - findings[].note：对每条非 ok 的判定给跨维度互证（如 CACHE_LOW 与大扫描 SQL、TEMP_SPILL 与 BufFileWrite 等待与 Top SQL 下盘）；`,
      `   - rootCause / priorities：把上面串成一条因果链并给处置顺序（priorities[].p 只填 P0/P1/P2，具体做什么写进 action；refs 填 sqlId 或判定 code）。`,
      `3. 需要补充细节时可用 db_query（只读；禁止 EXPLAIN ANALYZE；绝不调用 create_wdr_snapshot 或修改任何 GUC）。`,
      task.config.focus !== '' ? `4. 本次额外关注：${task.config.focus}` : ``,
      ``,
      `## 诚实守卫`,
      `- 工具列表没有 wdr_collect：task_report severity=warn，summary 写明"wdr_collect 工具缺失"，det.worst=warn——禁止退回自由分析；`,
      `- 快照不足两个/窗口无效时工具会明说：如实转述，不要臆造窗口数据。`,
      ``,
      `## 锚定纪律（违反会被驳回）`,
      `- det 与 window 逐字来自 wdr_collect 输出；引用的每个数字必须能在工具输出里找到，禁止编造；`,
      `- 不得改 attr、不得下调判定 level；topSql 的 sqlId 只能是工具输出里的 id。`,
      ``,
      `## 报告（task_report）`,
      `- severity = det.worst 映射：critical→critical，warn→warn，notice/ok→ok；`,
      `- summary 一句话：窗口态势 + 驱动性结论（如"10:30–10:39 窗口 AAS 10.8 为 24 小时最重，三条串行大聚合下盘主导"）；`,
      `- data 只填解读字段：scope/node/window/det/situation/topSql[{sqlId,note}]/findings[{code,note}]/priorities/rootCause。`,
    ].filter((l) => l !== '').join('\n');
  },
};

export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  ctx.effect(() => anyCtx.opendbTasks.register(WDR_TASK_TYPE), 'task-wdr.type');
  ctx.effect(() => anyCtx.opendbThresholds.register(WDR_THRESHOLD_SPECS), 'task-wdr.thresholds');
}
