/**
 * tool-wdr-collect — wdr_collect 工具（task-wdr 的采集半边，Runtime 侧）。
 * 只读铁律：只消费既有快照（snapshot.snapshot），绝不 create_wdr_snapshot、不碰任何 GUC。
 * 独立成包（工具注册定论：独立 function plugin + 顶层 inject 数据服务 + 嵌套仅 inject(['tools'])）。
 * 表结构以 og5（og-lite 5.0.3）实探为准（2026-08-21 探针）：snap_* 列带 snap_ 前缀、µs 时间单位。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { pickNode, clampText } from '@opendb-dsh/tool-db';
import {
  deltaInstanceTime, dbTimeClasses, deltaTopSql, deltaStatDatabase, deltaWaits,
  judgeWindow, worstOf,
} from '@opendb-dsh/task-wdr';
import type { WdrFinding, WdrLevel } from '@opendb-dsh/task-wdr';
import { withWdrThresholds } from '@opendb-dsh/task-wdr';

export const name = 'tool-wdr-collect';
export const inject = ['opendbDb', 'opendbRegistry', 'opendbThresholds'];
export const Config = z.object({
  maxContentBytes: z.number().step(1).min(4096).default(30000),
});

const LEVEL_CN: Record<string, string> = { ok: '正常', notice: '关注', warn: '告警', critical: '严重' };
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
/** pg 返回 Date 对象，String() 会变 "Thu Aug 21…" 切片错位——统一 ISO */
const iso = (v: unknown): string => {
  const d = new Date(v as any);
  return Number.isNaN(d.getTime()) ? str(v) : d.toISOString();
};

interface Deps { db: any; registry: any; thresholds: any; maxContentBytes: number }

function defineWdrCollectTool(deps: Deps) {
  return defineTool({
    name: 'wdr_collect',
    description: 'WDR 窗口报告确定性采集器：基于既有 WDR 快照对（不新建快照、不改配置）计算窗口 delta——Load Profile、DB Time 构成、库级 Stat、Top SQL（含归因徽章 cpu/io/tmp/blk）、等待事件、Checkpoint、Cache，并产出阈值判定 findings。省略窗口参数 = 最近一对相邻快照。',
    parameters: {
      node: { type: 'string', description: '目标节点名称；agent 只绑定一个节点时可省略。' },
      beginSnap: { type: 'integer', description: '窗口起始快照 id。' },
      endSnap: { type: 'integer', description: '窗口结束快照 id（须大于 beginSnap）。' },
      topN: { type: 'integer', description: 'Top SQL 条数（默认 10）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true } } },
      render: (_args: unknown, value: any) => [{ type: 'text', text: value.content }],
    },
    async execute(args: any, exec: any) {
      const { node } = await pickNode(deps.registry, exec, typeof args.node === 'string' && args.node !== '' ? args.node : undefined);
      const q = (sql: string, maxRows = 400) => deps.db.query(node, sql, { maxRows });
      const notes: string[] = [];
      const topN = Math.max(3, Math.min(Number(args.topN ?? 10), 20));

      // 0) 快照时间轴 + 窗口选择（只消费既有快照）
      let snaps: { id: number; ts: string }[];
      try {
        const r = await q('SELECT snapshot_id, start_ts FROM snapshot.snapshot ORDER BY snapshot_id DESC LIMIT 24', 24);
        snaps = r.rows.map((row: any) => ({ id: num(row.snapshot_id), ts: iso(row.start_ts) })).reverse();
      } catch (cause) {
        return { content: `WDR 快照不可读（${String((cause as Error).message ?? cause).slice(0, 140)}）——该实例可能未开启 enable_wdr_snapshot。按只读纪律，本工具不会代为开启：请人工确认后由 DBA 开启（guc: enable_wdr_snapshot），开启后每 60 分钟自动产生快照。` };
      }
      if (snaps.length < 2) {
        return { content: `WDR 快照不足两个（现有 ${snaps.length} 个）——无法构成窗口。本工具只消费既有快照，不会调用 create_wdr_snapshot（只读纪律）；请等待下一个自动快照周期。` };
      }
      let beginSnap = Number(args.beginSnap ?? 0);
      let endSnap = Number(args.endSnap ?? 0);
      if (beginSnap <= 0 || endSnap <= 0) {
        endSnap = snaps[snaps.length - 1].id;
        beginSnap = snaps[snaps.length - 2].id;
      }
      const bRow = snaps.find((s) => s.id === beginSnap);
      const eRow = snaps.find((s) => s.id === endSnap);
      if (bRow === undefined || eRow === undefined || beginSnap >= endSnap) {
        return { content: `窗口无效：beginSnap=${beginSnap} endSnap=${endSnap}（须为存在的快照且 begin<end）。现有快照 ${snaps[0].id}..${snaps[snaps.length - 1].id}（每小时一个）。` };
      }
      const minutes = Math.max(1, Math.round((new Date(eRow.ts).getTime() - new Date(bRow.ts).getTime()) / 60000));
      const pair = `snapshot_id IN (${beginSnap}, ${endSnap})`;

      // 1) Load Profile / DB Time（instance_time delta）
      let loadProfile: { stat: string; deltaUs: number }[] = [];
      try {
        const r = await q(`SELECT snapshot_id, snap_stat_name, snap_value FROM snapshot.snap_global_instance_time WHERE ${pair}`, 60);
        loadProfile = deltaInstanceTime(r.rows as any, beginSnap, endSnap);
      } catch (cause) { notes.push(`Load Profile 降级：${String((cause as Error).message ?? cause).slice(0, 120)}`); }
      const dbTime = dbTimeClasses(loadProfile);
      const avgActive = minutes > 0 ? Math.round((dbTime.total / (minutes * 60 * 1_000_000)) * 100) / 100 : 0;

      // 2) 库级 Stat（cache/temp/deadlock/rollback）
      let dbStats: ReturnType<typeof deltaStatDatabase> = [];
      try {
        const r = await q(`SELECT snapshot_id, snap_datname, snap_xact_commit, snap_xact_rollback, snap_blks_read, snap_blks_hit, snap_temp_bytes, snap_deadlocks FROM snapshot.snap_summary_stat_database WHERE ${pair}`, 60);
        dbStats = deltaStatDatabase(r.rows as any, beginSnap, endSnap);
      } catch (cause) { notes.push(`库级 Stat 降级：${String((cause as Error).message ?? cause).slice(0, 120)}`); }

      // 3) Top SQL（归因）
      let topSql: ReturnType<typeof deltaTopSql> = [];
      try {
        const r = await q(`SELECT snapshot_id, snap_unique_sql_id, snap_query, snap_n_calls, snap_total_elapse_time, snap_cpu_time, snap_data_io_time, snap_sort_spill_size
FROM snapshot.snap_summary_statement WHERE ${pair} ORDER BY snap_total_elapse_time DESC LIMIT 380`, 380);
        topSql = deltaTopSql(r.rows as any, beginSnap, endSnap, topN);
      } catch (cause) { notes.push(`Top SQL 降级：${String((cause as Error).message ?? cause).slice(0, 120)}`); }

      // 4) 等待事件（剔除 STATUS 空闲类）
      let waits: ReturnType<typeof deltaWaits> = [];
      try {
        const r = await q(`SELECT snapshot_id, snap_type, snap_event, snap_total_wait_time FROM snapshot.snap_global_wait_events WHERE ${pair}`, 400);
        waits = deltaWaits(r.rows as any, beginSnap, endSnap);
      } catch (cause) { notes.push(`等待事件降级：${String((cause as Error).message ?? cause).slice(0, 120)}`); }

      // 5) Checkpoint
      let ckpt = { timed: 0, req: 0 };
      try {
        const r = await q(`SELECT snapshot_id, snap_checkpoints_timed, snap_checkpoints_req FROM snapshot.snap_global_bgwriter_stat WHERE ${pair}`, 4);
        const b = r.rows.find((row: any) => num(row.snapshot_id) === beginSnap);
        const e = r.rows.find((row: any) => num(row.snapshot_id) === endSnap);
        if (e !== undefined) {
          ckpt = {
            timed: Math.max(0, num(e.snap_checkpoints_timed) - num(b?.snap_checkpoints_timed)),
            req: Math.max(0, num(e.snap_checkpoints_req) - num(b?.snap_checkpoints_req)),
          };
        }
      } catch (cause) { notes.push(`Checkpoint 降级：${String((cause as Error).message ?? cause).slice(0, 120)}`); }

      // 6) 确定性判定
      // 运行时阈值：平台阈值服务的覆盖值；服务不可读则退回代码默认值
      const T = withWdrThresholds(await deps.thresholds.resolve('wdr').catch(() => ({})));
      const findings: WdrFinding[] = judgeWindow({ windowMinutes: minutes, dbTimeUs: dbTime.total, dbStats, ckpt, topSql }, T);
      const counts: Record<WdrLevel, number> = { ok: 0, notice: 0, warn: 0, critical: 0 };
      for (const f of findings) counts[f.level] += 1;
      const worst = worstOf(findings);

      // 7) 原生 WDR 留底可用性（只探测函数存在性，不生成——生成属重查询且需权限，由 DBA 按需执行）
      let nativeReport = '';
      try {
        const r = await q("SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'generate_wdr_report'", 1);
        nativeReport = num(r.rows[0]?.n) > 0
          ? `原生 WDR 可留底：库内存在 generate_wdr_report；DBA 可执行 gsql -c "select generate_wdr_report(${beginSnap}, ${endSnap}, 'all', 'node', '<node_name>')" \\o wdr_${beginSnap}_${endSnap}.html 归档（平台只读，不代执行）`
          : '原生 WDR 函数不存在（og-lite 精简版可能移除）——以本结构化报告为准';
      } catch { nativeReport = '原生 WDR 可用性探测降级'; }

      const payload = {
        scope: 'wdr-window',
        node: node.name,
        window: { beginSnap, endSnap, beginTs: bRow.ts, endTs: eRow.ts, minutes },
        det: { worst, counts },
        findings,
        dbTime: { totalUs: dbTime.total, avgActive, classes: dbTime.classes },
        loadProfile: loadProfile.slice(0, 12),
        topSql,
        waits,
        snapshots: snaps.map((s) => ({ id: s.id, ts: s.ts, inWindow: s.id >= beginSnap && s.id <= endSnap })),
        nativeReport,
        collectionNotes: notes,
      };
      const header = [
        `-- wdr_collect · ${node.name} · 窗口 snap ${beginSnap}→${endSnap}（${minutes} 分钟）· worst=${worst}（${LEVEL_CN[worst]}）· avgActive=${avgActive}`,
        `-- 以下 JSON 是唯一事实来源：除 topSql[].note / priorities / rootCause 外全部逐字进报告，attr/level 不得改动`,
      ].join('\n');
      return { content: clampText(`${header}\n${JSON.stringify(payload, null, 1)}`, deps.maxContentBytes) };
    },
  } as any);
}

export function apply(ctx: Context, config: { maxContentBytes?: number } = {}): void {
  const anyCtx = ctx as any;
  anyCtx.inject(['tools'], (c: any) => {
    const deps: Deps = {
      db: anyCtx.opendbDb,
      registry: anyCtx.opendbRegistry,
      thresholds: anyCtx.opendbThresholds,
      maxContentBytes: config.maxContentBytes ?? 30000,
    };
    c.effect(() => c.tools.register(defineWdrCollectTool(deps)), 'tool-wdr-collect.wdr_collect');
  });
}
