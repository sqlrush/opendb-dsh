/**
 * tool-wdr-collect — wdr_collect 工具（task-wdr 的采集半边，Runtime 侧）。
 * 只读铁律：只消费既有快照（snapshot.snapshot），绝不 create_wdr_snapshot、不碰任何 GUC。
 * 独立成包（工具注册定论：独立 function plugin + 顶层 inject 数据服务 + 嵌套仅 inject(['tools'])）。
 * 表结构以 og5（og-lite 5.0.3）实探为准：snap_* 列带 snap_ 前缀、µs 时间单位。
 *
 * R2（2026-08-29 user 定稿）：窗口全景——摘要 vs 上一窗口、24 窗口 AAS 趋势、DB Time 构成、等待事件按类、
 * AWR 式 Load Profile、多维 Top SQL、IO/WAL/Checkpoint/主机、实例效率、检查清单（含通过项）、一眼结论；
 * 整包存档 opendb_task_collects 供面板直读，给模型的是精简视图（它只写解读）。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type pg from 'pg';
import { pickNode, clampText } from '@opendb-dsh/tool-db';
import { createPool } from '@opendb-dsh/session-persistence-pg';
import {
  deltaStatDatabase, judgeWindow, worstOf, withWdrThresholds,
  delta, sumBy, aasTrend, dbTimeBreakdown, topSqlFull, waitsFull, loadProfile, hostStat, efficiency, summaryOf, checksOf, insightsOf,
} from '@opendb-dsh/task-wdr';
import type { WdrFinding, WdrLevel, WindowRaw, Snap, Breakdown } from '@opendb-dsh/task-wdr';

export const name = 'tool-wdr-collect';
export const inject = ['opendbDb', 'opendbRegistry', 'opendbThresholds'];
export const Config = z.object({
  maxContentBytes: z.number().step(1).min(4096).default(40000),
  /** 存档用 PG（opendb_task_collects）；不配则不存档，面板退回兼容视图 */
  connectionString: z.string().default(''),
  /** 趋势图的窗口数（连续快照对） */
  trendWindows: z.number().step(1).min(6).max(96).default(24),
});

const LEVEL_CN: Record<string, string> = { ok: '正常', notice: '关注', warn: '告警', critical: '严重' };
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
/** pg 返回 Date 对象，String() 会变 "Thu Aug 21…" 切片错位——统一 ISO */
const iso = (v: unknown): string => {
  const d = new Date(v as any);
  return Number.isNaN(d.getTime()) ? str(v) : d.toISOString();
};
const errMsg = (cause: unknown): string => String((cause as Error)?.message ?? cause).slice(0, 120);

interface Deps { db: any; registry: any; thresholds: any; maxContentBytes: number; trendWindows: number; pool?: pg.Pool }
type Q = (sql: string, maxRows?: number) => Promise<{ rows: any[] }>;

const STMT_COLS = 'snapshot_id, snap_unique_sql_id, snap_user_name, snap_query, snap_n_calls, snap_total_elapse_time, snap_cpu_time, snap_data_io_time, snap_n_returned_rows, snap_n_blocks_fetched, snap_n_blocks_hit, snap_sort_spill_size, snap_hash_spill_size';

async function archive(pool: pg.Pool, sessionId: string | undefined, node: string, worst: string, payload: unknown): Promise<number | undefined> {
  const r = await pool.query(
    `INSERT INTO opendb_task_collects (task_type, session_id, node, worst, collected_at, payload) VALUES ('wdr', $1, $2, $3, now(), $4) RETURNING id`,
    [sessionId ?? null, node, worst, JSON.stringify(payload)],
  );
  return r.rows[0] !== undefined ? Number(r.rows[0].id) : undefined;
}

/** 窗口选择：显式 begin/end 须都存在且 begin<end；省略 = 最近一对相邻快照 */
async function resolveWindow(q: Q, beginArg: number, endArg: number): Promise<{ begin: Snap; end: Snap; prevBegin?: Snap; trendSnaps: Snap[] } | string> {
  const toSnap = (row: any): Snap => ({ id: num(row.snapshot_id), ts: iso(row.start_ts) });
  let begin: Snap | undefined; let end: Snap | undefined;
  if (beginArg > 0 && endArg > 0) {
    const r = await q(`SELECT snapshot_id, start_ts FROM snapshot.snapshot WHERE snapshot_id IN (${beginArg}, ${endArg})`, 2);
    begin = r.rows.map(toSnap).find((s) => s.id === beginArg); end = r.rows.map(toSnap).find((s) => s.id === endArg);
    if (begin === undefined || end === undefined || beginArg >= endArg) return `窗口无效：beginSnap=${beginArg} endSnap=${endArg}（须为存在的快照且 begin<end）。`;
  } else {
    const r = await q('SELECT snapshot_id, start_ts FROM snapshot.snapshot ORDER BY snapshot_id DESC LIMIT 2', 2);
    if (r.rows.length < 2) return `WDR 快照不足两个（现有 ${r.rows.length} 个）——无法构成窗口。本工具只消费既有快照，不会调用 create_wdr_snapshot（只读纪律）；请等待下一个自动快照周期。`;
    end = toSnap(r.rows[0]); begin = toSnap(r.rows[1]);
  }
  return { begin, end, trendSnaps: [], prevBegin: undefined };
}

function defineWdrCollectTool(deps: Deps) {
  return defineTool({
    name: 'wdr_collect',
    description: 'WDR 窗口报告确定性采集器：基于既有 WDR 快照对（不新建快照、不改配置）计算窗口增量——摘要（vs 上一窗口）、最近 24 窗口 AAS 趋势、DB Time 构成、等待事件（按类 + Top10）、AWR 式 Load Profile、Top SQL（多维指标 + 归因徽章 cpu/io/tmp/blk + 探针标记）、IO/WAL/Checkpoint/主机、实例效率、阈值判定与通过项、脚本生成的一眼结论；整包存档给任务面板直读。省略窗口参数 = 最近一对相邻快照。',
    parameters: {
      node: { type: 'string', description: '目标节点名称；agent 只绑定一个节点时可省略。' },
      beginSnap: { type: 'integer', description: '窗口起始快照 id。' },
      endSnap: { type: 'integer', description: '窗口结束快照 id（须大于 beginSnap）。' },
      topN: { type: 'integer', description: '给模型解读的 Top SQL 条数（默认 10，最多 40；存档里始终保留最多 40 条）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true } } },
      render: (_args: unknown, value: any) => [{ type: 'text', text: value.content }],
    },
    async execute(args: any, exec: any) {
      const { node } = await pickNode(deps.registry, exec, typeof args.node === 'string' && args.node !== '' ? args.node : undefined);
      const q: Q = (sql, maxRows = 400) => deps.db.query(node, sql, { maxRows });
      const notes: string[] = [];
      const topN = Math.max(3, Math.min(Number(args.topN ?? 10), 40));

      // 0) 窗口 + 上一窗口 + 趋势快照序列（只消费既有快照）
      let win: Awaited<ReturnType<typeof resolveWindow>>;
      try { win = await resolveWindow(q, Number(args.beginSnap ?? 0), Number(args.endSnap ?? 0)); } catch (cause) {
        return { content: `WDR 快照不可读（${errMsg(cause)}）——该实例可能未开启 enable_wdr_snapshot。按只读纪律，本工具不会代为开启：请人工确认后由 DBA 开启（guc: enable_wdr_snapshot），开启后每 60 分钟自动产生快照。` };
      }
      if (typeof win === 'string') return { content: win };
      const { begin, end } = win;
      const secs = Math.max(1, Math.round((new Date(end.ts).getTime() - new Date(begin.ts).getTime()) / 1000));
      const minutes = Math.max(1, Math.round(secs / 60));
      let prevBegin: Snap | undefined;
      try {
        const r = await q(`SELECT snapshot_id, start_ts FROM snapshot.snapshot WHERE snapshot_id < ${begin.id} ORDER BY snapshot_id DESC LIMIT 1`, 1);
        if (r.rows[0] !== undefined) prevBegin = { id: num(r.rows[0].snapshot_id), ts: iso(r.rows[0].start_ts) };
      } catch (cause) { notes.push(`上一窗口不可得：${errMsg(cause)}`); }
      const prevSecs = prevBegin !== undefined ? Math.max(1, Math.round((new Date(begin.ts).getTime() - new Date(prevBegin.ts).getTime()) / 1000)) : 0;
      let trendSnaps: Snap[] = [begin, end];
      try {
        const lim = deps.trendWindows + 1;
        const r = await q(`SELECT snapshot_id, start_ts FROM snapshot.snapshot WHERE snapshot_id <= ${end.id} ORDER BY snapshot_id DESC LIMIT ${lim}`, lim);
        trendSnaps = r.rows.map((row: any) => ({ id: num(row.snapshot_id), ts: iso(row.start_ts) })).reverse();
      } catch (cause) { notes.push(`趋势快照序列降级：${errMsg(cause)}`); }
      const pairIds = [prevBegin?.id, begin.id, end.id].filter((x): x is number => x !== undefined);
      const inList = (ids: number[]) => [...new Set(ids)].join(', ');

      // 1) instance_time：趋势 + 本窗口/上窗口构成
      let instRows: any[] = [];
      try {
        const r = await q(`SELECT snapshot_id, snap_stat_name, snap_value FROM snapshot.snap_global_instance_time WHERE snapshot_id IN (${inList([...trendSnaps.map((s) => s.id), ...pairIds])})`, 1200);
        instRows = r.rows;
      } catch (cause) { notes.push(`instance_time 降级：${errMsg(cause)}`); }
      const trend = aasTrend(instRows, trendSnaps);
      const breakdown: Breakdown = dbTimeBreakdown(instRows, begin.id, end.id);
      const prevBreakdown = prevBegin !== undefined ? dbTimeBreakdown(instRows, prevBegin.id, begin.id) : undefined;

      // 2) 库级 Stat（分库判定 + 全库汇总）
      let dbRows: any[] = [];
      try {
        const r = await q(`SELECT snapshot_id, snap_datname, snap_xact_commit, snap_xact_rollback, snap_blks_read, snap_blks_hit, snap_tup_returned, snap_tup_fetched, snap_tup_inserted, snap_tup_updated, snap_tup_deleted, snap_temp_files, snap_temp_bytes, snap_deadlocks, snap_numbackends FROM snapshot.snap_summary_stat_database WHERE snapshot_id IN (${inList(pairIds)})`, 120);
        dbRows = r.rows;
      } catch (cause) { notes.push(`库级 Stat 降级：${errMsg(cause)}`); }
      const dbStats = deltaStatDatabase(dbRows, begin.id, end.id);
      const dbAgg = (b: number, e: number): WindowRaw['db'] => ({
        commits: delta(dbRows, b, e, 'snap_xact_commit'), rollbacks: delta(dbRows, b, e, 'snap_xact_rollback'),
        blksRead: delta(dbRows, b, e, 'snap_blks_read'), blksHit: delta(dbRows, b, e, 'snap_blks_hit'),
        tupReturned: delta(dbRows, b, e, 'snap_tup_returned'), tupFetched: delta(dbRows, b, e, 'snap_tup_fetched'),
        ins: delta(dbRows, b, e, 'snap_tup_inserted'), upd: delta(dbRows, b, e, 'snap_tup_updated'), del: delta(dbRows, b, e, 'snap_tup_deleted'),
        tempFiles: delta(dbRows, b, e, 'snap_temp_files'), tempBytes: delta(dbRows, b, e, 'snap_temp_bytes'), deadlocks: delta(dbRows, b, e, 'snap_deadlocks'),
        backends: sumBy(dbRows, e, 'snap_numbackends'),
      });

      // 3) Top SQL：end 快照按累计耗时 Top300 + 按累计次数 Top100，再取这些 id 在 begin 快照的行（增量精确）
      let stmtRows: any[] = [];
      try {
        const e1 = await q(`SELECT ${STMT_COLS} FROM snapshot.snap_summary_statement WHERE snapshot_id = ${end.id} ORDER BY snap_total_elapse_time DESC LIMIT 300`, 300);
        const e2 = await q(`SELECT ${STMT_COLS} FROM snapshot.snap_summary_statement WHERE snapshot_id = ${end.id} ORDER BY snap_n_calls DESC LIMIT 100`, 100);
        const seen = new Set<string>();
        const endRows = [...e1.rows, ...e2.rows].filter((r: any) => { const k = `${str(r.snap_unique_sql_id)}|${str(r.snap_user_name)}`; if (seen.has(k)) return false; seen.add(k); return true; });
        const ids = [...new Set(endRows.map((r: any) => str(r.snap_unique_sql_id)).filter((id: string) => /^\d+$/.test(id)))];
        const b = ids.length > 0 ? await q(`SELECT ${STMT_COLS} FROM snapshot.snap_summary_statement WHERE snapshot_id = ${begin.id} AND snap_unique_sql_id IN (${ids.join(', ')})`, 800) : { rows: [] };
        stmtRows = [...endRows, ...b.rows];
      } catch (cause) { notes.push(`Top SQL 降级：${errMsg(cause)}`); }
      const top = topSqlFull(stmtRows, begin.id, end.id, 40);

      // 4) 等待事件（STATUS 空闲类在 SQL 里剔除，避免行数上限截掉真事件——旧版 maxRows 400 曾把整段截空）
      let waitRows: any[] = [];
      try {
        const r = await q(`SELECT snapshot_id, snap_type, snap_event, snap_total_wait_time, snap_wait FROM snapshot.snap_global_wait_events WHERE snapshot_id IN (${begin.id}, ${end.id}) AND snap_type <> 'STATUS'`, 2000);
        waitRows = r.rows;
      } catch (cause) { notes.push(`等待事件降级：${errMsg(cause)}`); }
      const waits = waitsFull(waitRows, begin.id, end.id, 10);

      // 5) bgwriter / redo / file io / statement_count（三快照一次取，窗口与上窗口都算）
      let bgwRows: any[] = []; let redoRows: any[] = []; let fileRows: any[] = []; let cntRows: any[] = [];
      try { bgwRows = (await q(`SELECT snapshot_id, snap_checkpoints_timed, snap_checkpoints_req, snap_checkpoint_write_time, snap_checkpoint_sync_time, snap_buffers_checkpoint, snap_buffers_clean, snap_buffers_backend FROM snapshot.snap_global_bgwriter_stat WHERE snapshot_id IN (${inList(pairIds)})`, 12)).rows; } catch (cause) { notes.push(`Checkpoint 降级：${errMsg(cause)}`); }
      try { redoRows = (await q(`SELECT snapshot_id, snap_phywrts, snap_phyblkwrt, snap_writetim, snap_maxiowtm FROM snapshot.snap_summary_file_redo_iostat WHERE snapshot_id IN (${inList(pairIds)})`, 12)).rows; } catch (cause) { notes.push(`WAL(redo) 降级：${errMsg(cause)}`); }
      try { fileRows = (await q(`SELECT snapshot_id, sum(snap_phyrds) AS reads, sum(snap_phywrts) AS writes, sum(snap_readtim) AS readtim, sum(snap_writetim) AS writetim FROM snapshot.snap_summary_file_iostat WHERE snapshot_id IN (${inList(pairIds)}) GROUP BY snapshot_id`, 12)).rows; } catch (cause) { notes.push(`文件 IO 降级：${errMsg(cause)}`); }
      try { cntRows = (await q(`SELECT snapshot_id, sum(snap_select_count) AS sel, sum(snap_update_count) AS upd, sum(snap_insert_count) AS ins, sum(snap_delete_count) AS del, sum(snap_mergeinto_count) AS mrg, sum(snap_ddl_count) AS ddl, sum(snap_dml_count) AS dml, sum(snap_dcl_count) AS dcl FROM snapshot.snap_summary_statement_count WHERE snapshot_id IN (${inList(pairIds)}) GROUP BY snapshot_id`, 12)).rows; } catch (cause) { notes.push(`SQL 执行计数降级：${errMsg(cause)}`); }
      const bgw = (b: number, e: number): WindowRaw['bgw'] => ({
        timed: delta(bgwRows, b, e, 'snap_checkpoints_timed'), req: delta(bgwRows, b, e, 'snap_checkpoints_req'),
        writeMs: delta(bgwRows, b, e, 'snap_checkpoint_write_time'), syncMs: delta(bgwRows, b, e, 'snap_checkpoint_sync_time'),
        bufCkpt: delta(bgwRows, b, e, 'snap_buffers_checkpoint'), bufClean: delta(bgwRows, b, e, 'snap_buffers_clean'), bufBackend: delta(bgwRows, b, e, 'snap_buffers_backend'),
      });
      const wal = (b: number, e: number): WindowRaw['wal'] => ({ writes: delta(redoRows, b, e, 'snap_phywrts'), blocks: delta(redoRows, b, e, 'snap_phyblkwrt'), writeUs: delta(redoRows, b, e, 'snap_writetim'), maxUs: sumBy(redoRows, e, 'snap_maxiowtm') });
      const fileio = (b: number, e: number): WindowRaw['fileio'] => ({ reads: delta(fileRows, b, e, 'reads'), writes: delta(fileRows, b, e, 'writes'), readUs: delta(fileRows, b, e, 'readtim'), writeUs: delta(fileRows, b, e, 'writetim') });
      // dml_count 在不同版本里可能已含 select：取 max(dml, 四类之和) 避免双算
      const execs = (b: number, e: number): number => Math.max(delta(cntRows, b, e, 'dml'), delta(cntRows, b, e, 'sel') + delta(cntRows, b, e, 'upd') + delta(cntRows, b, e, 'ins') + delta(cntRows, b, e, 'del') + delta(cntRows, b, e, 'mrg')) + delta(cntRows, b, e, 'ddl') + delta(cntRows, b, e, 'dcl');
      const sqlKinds = { select: delta(cntRows, begin.id, end.id, 'sel'), update: delta(cntRows, begin.id, end.id, 'upd'), insert: delta(cntRows, begin.id, end.id, 'ins'), delete: delta(cntRows, begin.id, end.id, 'del'), ddl: delta(cntRows, begin.id, end.id, 'ddl') };

      const cur: WindowRaw = { secs, db: dbAgg(begin.id, end.id), inst: { dbTimeUs: breakdown.totalUs, cpuUs: breakdown.cpuUs, execUs: breakdown.execUs }, sqlExecs: execs(begin.id, end.id), wal: wal(begin.id, end.id), fileio: fileio(begin.id, end.id), bgw: bgw(begin.id, end.id) };
      const prev: WindowRaw | undefined = prevBegin !== undefined && prevBreakdown !== undefined
        ? { secs: prevSecs, db: dbAgg(prevBegin.id, begin.id), inst: { dbTimeUs: prevBreakdown.totalUs, cpuUs: prevBreakdown.cpuUs, execUs: prevBreakdown.execUs }, sqlExecs: execs(prevBegin.id, begin.id), wal: wal(prevBegin.id, begin.id), fileio: fileio(prevBegin.id, begin.id), bgw: bgw(prevBegin.id, begin.id) }
        : undefined;

      // 6) 主机 / 响应分位 / 双写 / 内存
      let host = hostStat([], begin.id, end.id);
      try { host = hostStat((await q(`SELECT snapshot_id, snap_name, snap_value FROM snapshot.snap_global_os_runtime WHERE snapshot_id IN (${begin.id}, ${end.id})`, 80)).rows, begin.id, end.id); } catch (cause) { notes.push(`主机 os_runtime 降级：${errMsg(cause)}`); }
      let pct: { p80: number; p95: number } | undefined;
      try { const r = await q(`SELECT snap_p80, snap_p95 FROM snapshot.snap_statement_responsetime_percentile WHERE snapshot_id = ${end.id}`, 2); if (r.rows[0] !== undefined) pct = { p80: num(r.rows[0].snap_p80), p95: num(r.rows[0].snap_p95) }; } catch (cause) { notes.push(`响应分位降级：${errMsg(cause)}`); }
      let dwWrites = 0;
      try { const rows = (await q(`SELECT snapshot_id, sum(snap_total_writes) AS w FROM snapshot.snap_global_double_write_status WHERE snapshot_id IN (${begin.id}, ${end.id}) GROUP BY snapshot_id`, 4)).rows; dwWrites = delta(rows, begin.id, end.id, 'w'); } catch { /* 双写状态非必需 */ }
      const mem: Record<string, number> = {};
      try { for (const r of (await q(`SELECT snap_memorytype, snap_memorymbytes FROM snapshot.snap_global_memory_node_detail WHERE snapshot_id = ${end.id} AND snap_memorytype IN ('shared_used_memory', 'process_used_memory', 'max_process_memory', 'max_shared_memory')`, 8)).rows) mem[str(r.snap_memorytype)] = num(r.snap_memorymbytes) * 1024 * 1024; } catch { /* 内存明细非必需 */ }

      // 7) 判定 + 派生
      const T = withWdrThresholds(await deps.thresholds.resolve('wdr').catch(() => ({})));
      // 判定用精确墙钟（secs/60，不取整）：9 分钟窗口按 540 s 算出的 AAS 10.75 与摘要卡的 10.81（537 s）曾对不上
      const findings: WdrFinding[] = judgeWindow({ windowMinutes: secs / 60, dbTimeUs: breakdown.totalUs, dbStats, ckpt: { timed: cur.bgw.timed, req: cur.bgw.req }, topSql: top.items }, T);
      const counts: Record<WdrLevel, number> = { ok: 0, notice: 0, warn: 0, critical: 0 };
      for (const f of findings) counts[f.level] += 1;
      const worst = worstOf(findings);
      const eff = efficiency(cur, pct);
      const summary = summaryOf(cur, prev, host.cores);
      const blkShare = top.items.filter((i) => i.attr === 'blk').reduce((acc, i) => acc + i.share, 0);
      const checks = checksOf(findings, { aas: summary.aas, tempBytes: cur.db.tempBytes, hitRatio: eff.hitRatio, ckptTimed: cur.bgw.timed, ckptReq: cur.bgw.req, rollbackRatio: eff.rollbackRatio, blkShare, deadlocks: cur.db.deadlocks }, T);
      const insights = insightsOf({ cur, prev, trend, breakdown, waits, host }, T);
      const lp = loadProfile(cur, prev);

      // 8) 原生 WDR 留底可用性（只探测函数存在性，不生成）
      let nativeReport = '';
      try {
        const r = await q("SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'generate_wdr_report'", 1);
        nativeReport = num(r.rows[0]?.n) > 0
          ? `原生 WDR 可留底：DBA 可执行 select generate_wdr_report(${begin.id}, ${end.id}, 'all', 'node', '<node_name>') 归档（平台只读，不代执行）`
          : '原生 WDR 函数不存在（og-lite 精简版可能移除）——以本结构化报告为准';
      } catch { nativeReport = '原生 WDR 可用性探测降级'; }

      const payload = {
        scope: 'wdr-window', version: 2, node: node.name, collectedAt: new Date().toISOString(),
        window: { beginSnap: begin.id, endSnap: end.id, beginTs: begin.ts, endTs: end.ts, secs, minutes },
        prevWindow: prevBegin !== undefined ? { beginSnap: prevBegin.id, endSnap: begin.id, beginTs: prevBegin.ts, endTs: begin.ts, secs: prevSecs, minutes: Math.max(1, Math.round(prevSecs / 60)) } : undefined,
        det: { worst, counts }, findings, checks, insights, summary,
        trend, breakdown: { totalUs: breakdown.totalUs, classes: breakdown.classes }, waits, loadProfile: lp, efficiency: eff, host: { ...host, mem },
        topSql: top.items, topSqlTotalUs: top.totalUs, topSqlCount: top.count, sqlKinds,
        io: { fileReads: cur.fileio.reads, fileWrites: cur.fileio.writes, readAvgUs: cur.fileio.reads > 0 ? Math.round(cur.fileio.readUs / cur.fileio.reads) : 0, writeAvgUs: cur.fileio.writes > 0 ? Math.round(cur.fileio.writeUs / cur.fileio.writes) : 0, walWrites: cur.wal.writes, walBytes: cur.wal.blocks * 8192, walAvgUs: cur.wal.writes > 0 ? Math.round(cur.wal.writeUs / cur.wal.writes) : 0, walMaxUs: cur.wal.maxUs, dwWrites, bufFileWrites: waits.top.find((w) => w.event === 'BufFileWrite')?.count ?? 0, bufFileReads: waits.top.find((w) => w.event === 'BufFileRead')?.count ?? 0 },
        ckpt: { ...cur.bgw, bufBytes: cur.bgw.bufCkpt * 8192, prev: prev !== undefined ? { timed: prev.bgw.timed, req: prev.bgw.req, bufCkpt: prev.bgw.bufCkpt } : undefined },
        dbStats, snapshots: trendSnaps.map((s) => ({ id: s.id, ts: s.ts, inWindow: s.id >= begin.id && s.id <= end.id })),
        nativeReport, collectionNotes: notes,
      };

      let archiveLine = '';
      if (deps.pool !== undefined) {
        try {
          const sessionId = typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : undefined;
          const id = await archive(deps.pool, sessionId, node.name, worst, payload);
          if (id !== undefined) archiveLine = `\n-- 采集已存档 opendb_task_collects#${id}（任务面板直读全部数字；报告里只写解读，不复述表格）`;
        } catch (cause) { archiveLine = `\n-- 采集存档失败：${errMsg(cause)}`; }
      }

      // 给模型的精简视图：判定 + 结论 + 摘要 + 构成 + 等待 Top + Load Profile 变化 + Top SQL（前 topN）+ IO/主机
      const forModel = {
        node: node.name, window: payload.window, prevWindow: payload.prevWindow, det: payload.det,
        insights: insights.map((i) => i.text), summary, checks: checks.map((c) => ({ code: c.code, level: c.level, detail: c.detail, value: c.value, threshold: c.threshold, evidence: c.evidence })),
        dbTime: { totalS: Math.round(breakdown.totalUs / 1e6), classes: breakdown.classes.map((c) => `${c.name} ${Math.round(c.us / 1e6)} s（${Math.round(c.share * 100)}%）`) },
        trendAas: trend.map((t) => t.aas), waits: { totalS: Math.round(waits.totalUs / 1e6), classes: waits.classes.map((c) => `${c.type} ${Math.round(c.share * 100)}%`), top: waits.top.map((w) => `${w.event} ${Math.round(w.waitUs / 1e6)} s · ${w.count} 次 · 均 ${w.avgUs} µs`) },
        loadProfile: lp.map((r) => ({ k: r.label, perSec: r.perSec, prevPerSec: r.prevPerSec, ratio: r.ratio })),
        efficiency: eff, host: { load: host.load, cores: host.cores, busyPct: host.busyPct, iowaitPct: host.iowaitPct },
        topSql: top.items.slice(0, topN).map((i) => ({ sqlId: i.sqlId, attr: i.attr, probe: i.probe, sharePct: Math.round(i.share * 1000) / 10, elapsedS: Math.round(i.elapsedMs / 1000), calls: i.calls, avgMs: i.avgMs, cpuPct: i.cpuPct, ioPct: i.ioPct, blocks: i.blocks, hitPct: i.hitPct, rowsRet: i.rowsRet, spillMB: Math.round((i.spillBytes / 1048576) * 10) / 10, text: i.text.replace(/\s+/g, ' ').slice(0, 300) })),
        io: payload.io, ckpt: { timed: cur.bgw.timed, req: cur.bgw.req, bufMB: Math.round(cur.bgw.bufCkpt * 8192 / 1048576) }, nativeReport, collectionNotes: notes,
      };
      const header = [
        `-- wdr_collect · ${node.name} · 窗口 snap ${begin.id}→${end.id}（${minutes} 分钟）· worst=${worst}（${LEVEL_CN[worst]}）· AAS ${summary.aas}${summary.prevAas !== null ? `（上窗 ${summary.prevAas}）` : ''}`,
        `-- 一眼结论（脚本按增量生成）：${insights.map((i) => i.text).join('；')}`,
        `-- 以下 JSON 是唯一事实来源：det 逐字进报告；你只写 situation / topSql[].note / findings[].note / rootCause / priorities，数字不必复述`,
      ].join('\n');
      return { content: clampText(`${header}${archiveLine}\n${JSON.stringify(forModel, null, 1)}`, deps.maxContentBytes) };
    },
  } as any);
}

export function apply(ctx: Context, config: { maxContentBytes?: number; connectionString?: string; trendWindows?: number } = {}): void {
  const anyCtx = ctx as any;
  const conn = config.connectionString ?? '';
  const pool = conn !== '' ? createPool(conn) : undefined;
  if (pool !== undefined) ctx.effect(() => () => pool.end(), 'tool-wdr-collect.pool');
  anyCtx.inject(['tools'], (c: any) => {
    const deps: Deps = {
      db: anyCtx.opendbDb,
      registry: anyCtx.opendbRegistry,
      thresholds: anyCtx.opendbThresholds,
      maxContentBytes: config.maxContentBytes ?? 40000,
      trendWindows: config.trendWindows ?? 24,
      pool,
    };
    c.effect(() => c.tools.register(defineWdrCollectTool(deps)), 'tool-wdr-collect.wdr_collect');
  });
}
