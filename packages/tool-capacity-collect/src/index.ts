/**
 * tool-capacity-collect — capacity_collect 工具（task-capacity 的采集半边，Runtime 侧）。
 * 一次采齐：库 / 表空间 / schema / Top 表大小、死元组与 analyze 新鲜度、非表占用（WAL / statement_history / WDR / pg_log / pg_audit / core）、
 * 相关 GUC；再从平台 PG 读历史采样（增速回归、对象级 24h 增量、采集空窗）与字典建/删批次（趋势图事件标注），
 * 判定 CAP_*（task-capacity 纯函数），采样写 opendb_capacity_samples，整包存档 opendb_task_collects，给模型精简视图。
 * 全程只读；文件级（pg_ls_dir / pg_stat_file）需要 sysadmin，不可读时如实降级；主机磁盘容量 openGauss 视图不暴露，缺失时不外推满盘。
 * 首次运行没有历史时，从 opendb_health_collects 里的库大小（overview.db_bytes）回填一次，趋势图不必等一周。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type pg from 'pg';
import { pickNode, clampText } from '@opendb-dsh/tool-db';
import { createPool } from '@opendb-dsh/session-persistence-pg';
import { withCapThresholds, growthStats, daysToFull, findGaps, judgeCapacity, worstOf, countLevels, GIB } from '@opendb-dsh/task-capacity';
import type { CapInput, SamplePoint, CapThresholds } from '@opendb-dsh/task-capacity';

export const name = 'tool-capacity-collect';
export const inject = ['opendbDb', 'opendbRegistry', 'opendbThresholds'];
export const Config = z.object({
  maxContentBytes: z.number().step(1).min(4096).default(40000),
  /** 平台 PG（opendb_capacity_samples / opendb_task_collects / 回填源 opendb_health_collects）；不配则无历史、不存档 */
  connectionString: z.string().default(''),
  /** 存档与采样里保留的 Top 表条数 */
  keepTables: z.number().step(1).min(20).max(200).default(50),
});

const LEVEL_CN: Record<string, string> = { ok: '正常', notice: '关注', warn: '告警', critical: '严重' };
const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast', 'dbe_perf', 'dbe_pldeveloper', 'dbe_pldebugger', 'dbe_sql_util', 'db4ai', 'pkg_service', 'sqladvisor', 'cstore', 'blockchain', 'snapshot', 'dbe_application_info_settings', 'dbe_xmldom', 'pkg_util', 'dbe_task', 'sys'];
const SEG_BYTES = 16 * 1024 * 1024;
const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const iso = (v: unknown): string | undefined => { if (v === null || v === undefined || v === '') return undefined; const d = new Date(v as any); return Number.isNaN(d.getTime()) ? String(v) : d.toISOString(); };
const errMsg = (cause: unknown): string => String((cause as Error)?.message ?? cause).slice(0, 120);
const gb = (b: number): string => `${(b / GIB).toFixed(b >= 10 * GIB ? 1 : 2)} GB`;
const sqlList = (xs: string[]): string => xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(', ');

interface Deps { db: any; registry: any; thresholds: any; maxContentBytes: number; keepTables: number; pool?: pg.Pool }
type Q = (sql: string, maxRows?: number) => Promise<{ rows: any[] }>;

/** 逐段采集，任一段失败只记 note 不中断 */
async function section<T>(notes: string[], label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch (cause) { notes.push(`${label}不可得：${errMsg(cause)}`); return fallback; }
}

// ───────────────────────────────────────────── 平台 PG：历史采样 / 回填 / 事件
/** 取某条序列的历史采样（面板趋势图的三条序列：库 / 数据目录 / 磁盘已用，都走这一个取法） */
async function loadSeries(pool: pg.Pool, node: string, kind: string, name: string, days: number): Promise<SamplePoint[]> {
  const r = await pool.query(
    `SELECT extract(epoch FROM collected_at) * 1000 AS t, bytes FROM opendb_capacity_samples
      WHERE node = $1 AND kind = $2 AND name = $3 AND collected_at > now() - ($4 || ' days')::interval ORDER BY collected_at`,
    [node, kind, name, String(days)]);
  return r.rows.map((row) => ({ t: num(row.t), bytes: num(row.bytes) }));
}
const loadHistory = (pool: pg.Pool, node: string, dbName: string, days: number): Promise<SamplePoint[]> => loadSeries(pool, node, 'db', dbName, days);
/**
 * 首次运行：从健康采集存档回填库大小（按小时去重），让趋势图不必等一周。
 * 守卫：只要该节点已有任何 db 采样就不回填——否则观测窗小于回填样本年龄时（如 growthWindowDays=1），
 * 每次运行都会看到"窗口内无历史"而重复插入。
 */
async function backfillFromHealth(pool: pg.Pool, node: string, dbName: string, days: number): Promise<SamplePoint[]> {
  const existing = await pool.query(`SELECT 1 FROM opendb_capacity_samples WHERE node = $1 AND kind = 'db' AND name = $2 LIMIT 1`, [node, dbName]);
  if (existing.rows.length > 0) return [];
  const r = await pool.query(
    `SELECT extract(epoch FROM collected_at) * 1000 AS t,
            (jsonb_path_query_first(payload, '$.nodes[*] ? (@.node == $n).dims[*].charts[*] ? (@.key == "db_bytes").items[*] ? (@.name == $d).value', jsonb_build_object('n', $1::text, 'd', $2::text)))::text::numeric AS bytes
       FROM opendb_health_collects WHERE collected_at > now() - ($3 || ' days')::interval ORDER BY collected_at`,
    [node, dbName, String(days)]);
  const byHour = new Map<number, SamplePoint>();
  for (const row of r.rows) { if (row.bytes === null || row.bytes === undefined) continue; const t = num(row.t); byHour.set(Math.floor(t / 3600_000), { t, bytes: num(row.bytes) }); }
  const pts = [...byHour.values()].sort((a, b) => a.t - b.t);
  // 行数 ≤ 数百（按小时去重），逐行写入即可
  for (const p of pts) await pool.query(`INSERT INTO opendb_capacity_samples (node, collected_at, kind, name, bytes, extra) VALUES ($1, to_timestamp($2::double precision / 1000), 'db', $3, $4, '{"source":"health"}'::jsonb)`, [node, p.t, dbName, Math.round(p.bytes)]);
  return pts;
}
async function prevTableSamples(pool: pg.Pool, node: string): Promise<{ at: number; map: Map<string, number> } | undefined> {
  // 优先取 ≥20 小时前的最近一次；没有就取上一次（任何时间），增量窗口按实际小时数报
  for (const cond of ["collected_at < now() - interval '20 hours'", 'true']) {
    const r = await pool.query(
      `SELECT name, bytes, extract(epoch FROM collected_at) * 1000 AS t FROM opendb_capacity_samples
        WHERE node = $1 AND kind = 'table' AND ${cond} AND collected_at = (SELECT max(collected_at) FROM opendb_capacity_samples WHERE node = $1 AND kind = 'table' AND ${cond})`,
      [node]);
    if (r.rows.length > 0) return { at: num(r.rows[0].t), map: new Map(r.rows.map((row) => [str(row.name), num(row.bytes)])) };
  }
  return undefined;
}
async function dictEvents(pool: pg.Pool, nodeId: string, days: number): Promise<{ t: number; kind: string; count: number; label: string }[]> {
  const r = await pool.query(
    `SELECT extract(epoch FROM date_trunc('minute', time)) * 1000 AS t, change, count(*) AS n, string_agg(DISTINCT sch, ', ') AS schs
       FROM opendb_dict_changes WHERE node_id = $1 AND time > now() - ($2 || ' days')::interval AND kind IN ('table', 'schema', 'index') AND change IN ('added', 'removed')
      GROUP BY 1, 2 HAVING count(*) >= 5 ORDER BY 1`,
    [nodeId, String(days)]);
  return r.rows.map((row) => ({ t: num(row.t), kind: str(row.change), count: num(row.n), label: `${str(row.change) === 'removed' ? '删除' : '新建'}批次 · ${num(row.n)} 对象（${str(row.schs).slice(0, 80)}）` }));
}

// ───────────────────────────────────────────── 工具
function defineCapacityCollectTool(deps: Deps) {
  return defineTool({
    name: 'capacity_collect',
    description: '容量与增长确定性采集器：库/表空间/schema/Top 表大小，死元组与 analyze 新鲜度，非表占用（WAL、全量 SQL 追踪 statement_history、WDR 快照、pg_log、pg_audit、core）及决定它们大小的 GUC；平台历史采样算增速回归、满盘估算、对象级 24h 增量与采集空窗；字典建/删批次做趋势事件；CAP_* 判定由脚本给出，整包存档给任务面板直读。只读，不改任何配置。',
    parameters: {
      node: { type: 'string', description: '目标节点名称；agent 只绑定一个节点时可省略。' },
      topN: { type: 'integer', description: '给模型解读的 Top 表条数（默认 20，最多 50；存档始终保留 50）。' },
      growthWindowDays: { type: 'integer', description: '增速回归的观测窗天数（默认 7，最多 90）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true } } },
      render: (_args: unknown, value: any) => [{ type: 'text', text: value.content }],
    },
    async execute(args: any, exec: any) {
      const { node } = await pickNode(deps.registry, exec, typeof args.node === 'string' && args.node !== '' ? args.node : undefined);
      const q: Q = (sql, maxRows = 400) => deps.db.query(node, sql, { maxRows });
      const notes: string[] = [];
      const topN = Math.max(5, Math.min(Number(args.topN ?? 20), 50));
      const days = Math.max(1, Math.min(Number(args.growthWindowDays ?? 7), 90));
      const T: CapThresholds = withCapThresholds(await deps.thresholds.resolve('capacity').catch(() => ({})));
      const nowMs = Date.now(); const collectedAt = new Date(nowMs).toISOString();
      const isSys = (sch: string) => SYSTEM_SCHEMAS.includes(sch) || sch.startsWith('pg_');

      // ① 库 / 表空间 / 当前库
      const dbName = await section(notes, '当前库名', async () => str((await q('SELECT current_database() AS db', 1)).rows[0]?.db), 'postgres');
      const databases = await section(notes, '库大小', async () => (await q('SELECT datname, pg_database_size(datname)::bigint AS bytes FROM pg_database WHERE datistemplate = false ORDER BY 2 DESC', 50)).rows.map((r) => ({ name: str(r.datname), bytes: num(r.bytes) })), [] as { name: string; bytes: number }[]);
      const tablespaces = await section(notes, '表空间', async () => (await q('SELECT spcname, pg_tablespace_size(oid)::bigint AS bytes, pg_tablespace_location(oid) AS loc FROM pg_tablespace ORDER BY 2 DESC', 50)).rows.map((r) => ({ name: str(r.spcname), bytes: num(r.bytes), loc: str(r.loc) })), [] as { name: string; bytes: number; loc: string }[]);
      const dbBytes = databases.find((d) => d.name === dbName)?.bytes ?? 0;
      const dbBytesAll = databases.reduce((a, d) => a + d.bytes, 0);

      // ② schema 构成（表 + 物化视图的 total，含索引与 toast；不重复计 relkind i/t）
      const schemas = await section(notes, 'schema 大小', async () => (await q(`SELECT n.nspname AS sch, sum(pg_total_relation_size(c.oid))::bigint AS bytes, count(*) AS rels FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'm') GROUP BY 1 ORDER BY 2 DESC LIMIT 80`, 80)).rows.map((r) => ({ name: str(r.sch), bytes: num(r.bytes), rels: num(r.rels) })), [] as { name: string; bytes: number; rels: number }[]);

      // ③ Top 表（非系统 schema）+ 死元组 + 从未 analyze
      const sysIn = sqlList(SYSTEM_SCHEMAS);
      const tables = await section(notes, 'Top 表', async () => (await q(
        `SELECT n.nspname AS sch, c.relname AS name, pg_total_relation_size(c.oid)::bigint AS total, pg_relation_size(c.oid)::bigint AS heap, pg_indexes_size(c.oid)::bigint AS idx, c.reltuples::bigint AS reltuples,
                s.n_live_tup, s.n_dead_tup, s.last_vacuum, s.last_autovacuum, s.last_analyze, s.last_autoanalyze
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
          WHERE c.relkind IN ('r', 'm') AND n.nspname NOT IN (${sysIn}) AND n.nspname NOT LIKE 'pg\\_%' ORDER BY 3 DESC LIMIT ${deps.keepTables}`, deps.keepTables)).rows.map((r) => {
        const live = num(r.n_live_tup); const dead = num(r.n_dead_tup);
        return { sch: str(r.sch), name: str(r.name), total: num(r.total), heap: num(r.heap), idx: num(r.idx), reltuples: num(r.reltuples), live, dead, deadRatio: live + dead > 0 ? dead / (live + dead) : 0,
          lastVacuum: iso(r.last_autovacuum) ?? iso(r.last_vacuum), lastAnalyze: iso(r.last_autoanalyze) ?? iso(r.last_analyze) };
      }), [] as any[]);
      const deadTop = await section(notes, '死元组', async () => (await q(`SELECT schemaname AS sch, relname AS name, n_live_tup, n_dead_tup, pg_total_relation_size(relid)::bigint AS total, last_autovacuum, last_vacuum FROM pg_stat_user_tables WHERE n_dead_tup > 0 ORDER BY n_dead_tup DESC LIMIT 15`, 15)).rows.map((r) => {
        const live = num(r.n_live_tup); const dead = num(r.n_dead_tup);
        return { name: `${str(r.sch)}.${str(r.name)}`, live, dead, ratio: live + dead > 0 ? dead / (live + dead) : 0, bytes: num(r.total), lastVacuum: iso(r.last_autovacuum) ?? iso(r.last_vacuum) };
      }), [] as { name: string; live: number; dead: number; ratio: number; bytes: number; lastVacuum?: string }[]);
      const neverRows = await section(notes, '统计信息新鲜度', async () => (await q(
        `SELECT n.nspname AS sch, c.relname AS name, c.reltuples::bigint AS reltuples, pg_total_relation_size(c.oid)::bigint AS total
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
          WHERE c.relkind = 'r' AND n.nspname NOT IN (${sysIn}) AND n.nspname NOT LIKE 'pg\\_%' AND c.reltuples >= ${Math.floor(T.statsNeverRows)}
            AND s.last_analyze IS NULL AND s.last_autoanalyze IS NULL ORDER BY c.reltuples DESC LIMIT 200`, 200)).rows.map((r) => ({ sch: str(r.sch), name: str(r.name), reltuples: num(r.reltuples), total: num(r.total) })), [] as { sch: string; name: string; reltuples: number; total: number }[]);
      // items 存 50 张（面板「列出全部 N 张」直接展开；超过 50 的极端情况在提示里说明去会话里反查）
      const statsNever = { count: neverRows.length, maxRows: neverRows[0]?.reltuples ?? 0, items: neverRows.slice(0, 50), bySchema: Object.fromEntries(neverRows.reduce((m, r) => m.set(r.sch, (m.get(r.sch) ?? 0) + 1), new Map<string, number>())) };

      // ④ GUC
      const gucs = await section(notes, 'GUC', async () => Object.fromEntries((await q(`SELECT name, setting, unit FROM pg_settings WHERE name IN ('checkpoint_segments', 'wal_keep_segments', 'max_wal_size', 'enable_stmt_track', 'track_stmt_stat_level', 'track_stmt_retention_time', 'enable_wdr_snapshot', 'wdr_snapshot_retention_days', 'wdr_snapshot_interval', 'log_min_duration_statement', 'log_rotation_age', 'log_rotation_size', 'autovacuum', 'autovacuum_naptime', 'autovacuum_vacuum_scale_factor', 'data_directory', 'max_replication_slots', 'archive_mode')`, 40)).rows.map((r) => [str(r.name), `${str(r.setting)}${str(r.unit)}`])), {} as Record<string, string>);
      const gucNum = (k: string): number => Number.parseFloat(gucs[k] ?? '') || 0;

      // ⑤ 系统占用：statement_history / WDR / 复制槽 / 文件级（WAL、日志、审计、core）
      const stmt = await section(notes, 'statement_history', async () => { const r = (await q(`SELECT pg_total_relation_size('pg_catalog.statement_history')::bigint AS bytes, (SELECT count(*) FROM pg_catalog.statement_history) AS rows, (SELECT min(start_time) FROM pg_catalog.statement_history) AS oldest`, 1)).rows[0]; return { available: true, bytes: num(r?.bytes), rows: num(r?.rows), oldest: iso(r?.oldest) }; }, { available: false, bytes: 0, rows: 0, oldest: undefined as string | undefined });
      const wdrSchemaBytes = schemas.find((s) => s.name === 'snapshot')?.bytes ?? 0;
      const wdr = await section(notes, 'WDR 快照', async () => { const r = (await q('SELECT count(*) AS n, min(start_ts) AS oldest FROM snapshot.snapshot', 1)).rows[0]; const oldest = iso(r?.oldest); return { enabled: num(r?.n) > 0, bytes: wdrSchemaBytes, count: num(r?.n), oldest, oldestAgeDays: oldest !== undefined ? Math.round((nowMs - Date.parse(oldest)) / 86400_000) : undefined }; }, { enabled: false, bytes: wdrSchemaBytes, count: 0, oldest: undefined as string | undefined, oldestAgeDays: undefined as number | undefined });
      const slots = await section(notes, '复制槽', async () => { const r = (await q('SELECT count(*) AS n, sum(CASE WHEN active THEN 0 ELSE 1 END) AS inactive FROM pg_replication_slots', 1)).rows[0]; return { slots: num(r?.n), slotsInactive: num(r?.inactive) }; }, { slots: 0, slotsInactive: 0 });
      const fileNotes: string[] = [];
      const walDir = await section(fileNotes, 'WAL 目录', async () => { for (const d of ['pg_xlog', 'pg_wal']) { try { const r = (await q(`SELECT count(*) AS n FROM pg_ls_dir('${d}') f WHERE f ~ '^[0-9A-F]{24}$'`, 1)).rows[0]; return { dir: d, segments: num(r?.n), available: true }; } catch { /* try next */ } } throw new Error('pg_ls_dir(pg_xlog|pg_wal) 均失败'); }, { dir: 'pg_xlog', segments: 0, available: false });
      const logDir = await section(fileNotes, '日志目录', async () => { for (const d of ['pg_log', 'log']) { try { const r = (await q(`SELECT count(*) AS n, coalesce(sum((pg_stat_file('${d}/' || f)).size), 0)::bigint AS bytes, min(f) AS oldest, max(f) AS newest FROM pg_ls_dir('${d}') f WHERE f LIKE 'postgresql-%'`, 1)).rows[0]; return { dir: d, files: num(r?.n), bytes: num(r?.bytes), oldest: str(r?.oldest) || undefined, newest: str(r?.newest) || undefined, available: true }; } catch { /* try next */ } } throw new Error('pg_ls_dir(pg_log|log) 均失败'); }, { dir: 'pg_log', files: 0, bytes: 0, oldest: undefined as string | undefined, newest: undefined as string | undefined, available: false });
      const audit = await section(fileNotes, '审计目录', async () => { const r = (await q(`SELECT count(*) AS n, coalesce(sum((pg_stat_file('pg_audit/' || f)).size), 0)::bigint AS bytes FROM pg_ls_dir('pg_audit') f`, 1)).rows[0]; return { files: num(r?.n), bytes: num(r?.bytes), available: true }; }, { files: 0, bytes: 0, available: false });
      const core = await section(fileNotes, 'core 文件', async () => { const rows = (await q(`SELECT f AS name, (pg_stat_file(f)).size::bigint AS bytes FROM pg_ls_dir('.') f WHERE f LIKE 'core%'`, 50)).rows.map((r) => ({ name: str(r.name), bytes: num(r.bytes) })); return { files: rows, bytes: rows.reduce((a, r) => a + r.bytes, 0), available: true }; }, { files: [] as { name: string; bytes: number }[], bytes: 0, available: false });
      const filesAvailable = walDir.available && logDir.available;
      if (fileNotes.length > 0) notes.push(`文件级采集降级（openGauss 的 pg_ls_dir / pg_stat_file 只允许初始账号 omm，SYSADMIN 也不行；WAL / 日志 / 审计 / core 大小不可得，数据目录只按库大小计）：${fileNotes.join('；')}`);
      const walCapSegments = gucNum('checkpoint_segments') > 0 ? T.walSegFactor * gucNum('checkpoint_segments') + 1 : 0;   // openGauss 保留上限 ≈ (2+完成目标)×checkpoint_segments+1，与判定倍数一致
      const wal = { dir: walDir.dir, available: walDir.available, segments: walDir.segments, bytes: walDir.segments * SEG_BYTES, capSegments: walCapSegments, capBytes: walCapSegments * SEG_BYTES, checkpointSegments: gucNum('checkpoint_segments'), walKeepSegments: gucNum('wal_keep_segments'), ...slots };
      const log = { ...logDir, hasRetention: false /* openGauss 没有最长保留参数；轮转 ≠ 保留 */, rotationAge: gucs.log_rotation_age ?? '', rotationSize: gucs.log_rotation_size ?? '', minDuration: gucs.log_min_duration_statement ?? '' };

      // ⑥ 汇总：数据目录估算 / 非表占用（文件级不可读时两者都只含库内部分，并如实标注）
      const dataDirBytes = dbBytesAll + wal.bytes + log.bytes + audit.bytes + core.bytes;
      const nonTableBytes = wal.bytes + stmt.bytes + wdr.bytes + log.bytes + audit.bytes + core.bytes;
      const dataDirSource = filesAvailable ? 'estimate' : 'db-only';

      // ⑦ 平台历史：采样序列（首采回填）/ 上次表样本 / 字典事件
      let history: SamplePoint[] = []; let historySource = 'samples'; let prev: Awaited<ReturnType<typeof prevTableSamples>>; let events: Awaited<ReturnType<typeof dictEvents>> = []; let lastSampleAt: number | undefined;
      let dirSeries: SamplePoint[] = []; let diskSeries: SamplePoint[] = [];
      if (deps.pool !== undefined) {
        const pool = deps.pool;
        history = await section(notes, '历史采样', () => loadHistory(pool, node.name, dbName, days), []);
        // 趋势图的另两条序列：数据目录（文件级可读时才是真目录大小）与磁盘已用（接入主机侧采集后才有）
        dirSeries = await section(notes, '数据目录序列', () => loadSeries(pool, node.name, 'dir', 'data', days), []);
        diskSeries = await section(notes, '磁盘序列', () => loadSeries(pool, node.name, 'disk', 'used', days), []);
        if (history.length === 0) { const filled = await section(notes, '健康存档回填', () => backfillFromHealth(pool, node.name, dbName, days), []); if (filled.length > 0) { history = filled; historySource = 'health-backfill'; notes.push(`首次运行：从健康采集存档回填 ${filled.length} 个库大小样本（按小时去重）`); } }
        lastSampleAt = history.length > 0 ? history[history.length - 1].t : undefined;
        prev = await section(notes, '上次表样本', () => prevTableSamples(pool, node.name), undefined);
        events = await section(notes, '字典批次', () => dictEvents(pool, node.id, days), []);
      } else notes.push('未配置平台 PG：无历史采样、不存档（tool-capacity-collect.connectionString）');
      const points: SamplePoint[] = [...history, { t: nowMs, bytes: dbBytes }];
      const growth = growthStats(points, nowMs, days);
      const gaps = findGaps(points, T.collectGapHours);
      const gapHours = lastSampleAt !== undefined ? Math.round((nowMs - lastSampleAt) / 3600_000 * 10) / 10 : 0;
      const firstRun = prev === undefined;
      const dtf = daysToFull(undefined, growth.bytesPerDay, T.minGrowthBytesPerDay);
      const delta24 = prev !== undefined ? { hours: Math.round((nowMs - prev.at) / 3600_000 * 10) / 10 } : undefined;
      const topTables = tables.map((t) => { const key = `${t.sch}.${t.name}`; const p = prev?.map.get(key); return { ...t, delta: p !== undefined && delta24 !== undefined ? { bytes: t.total - p, hours: delta24.hours } : undefined }; });

      // ⑧ 判定
      const input: CapInput = {
        disk: undefined, dbBytes, dataDirBytes, nonTableBytes, growth, daysToFull: dtf, gapHours, firstRun, filesAvailable,
        sysTables: stmt.available ? [{ name: 'pg_catalog.statement_history', bytes: stmt.bytes, rows: stmt.rows }] : [],
        statsNever: { count: statsNever.count, maxRows: statsNever.maxRows, top: statsNever.items.slice(0, 5).map((r) => `${r.sch}.${r.name}`) },
        deadTop: deadTop.map((d) => ({ name: d.name, ratio: d.ratio, bytes: d.bytes, dead: d.dead })),
        wal: { segments: wal.segments, bytes: wal.bytes, checkpointSegments: wal.checkpointSegments, slots: wal.slots, slotsInactive: wal.slotsInactive },
        wdr: { enabled: wdr.enabled, bytes: wdr.bytes, count: wdr.count, oldestAgeDays: wdr.oldestAgeDays, retentionDays: gucNum('wdr_snapshot_retention_days') },
        log: { bytes: log.bytes, files: log.files, hasRetention: log.hasRetention, oldest: log.oldest },
      };
      const findings = judgeCapacity(input, T);
      const worst = worstOf(findings); const counts = countLevels(findings);

      // ⑨ 构成
      const dirComp = [
        ...tablespaces.filter((t) => t.name !== 'pg_global').map((t) => ({ name: t.name === 'pg_default' ? 'base（pg_default）' : `表空间 ${t.name}`, bytes: t.bytes, kind: 'tablespace', desc: t.loc !== '' ? t.loc : '各库默认表空间' })),
        { name: wal.dir, bytes: wal.bytes, kind: 'xlog', desc: `${wal.segments} 段 × 16 MB · checkpoint_segments = ${wal.checkpointSegments}` },
        { name: log.dir, bytes: log.bytes, kind: 'log', desc: `${log.files} 个文件${log.oldest !== undefined ? ` · 最老 ${log.oldest.replace(/^postgresql-/, '').slice(0, 10)}` : ''}` },
        { name: 'pg_audit', bytes: audit.bytes, kind: 'audit', desc: `${audit.files} 个文件` },
        ...(core.bytes > 0 ? [{ name: 'core 文件', bytes: core.bytes, kind: 'core', desc: core.files.map((f) => f.name).join(', ').slice(0, 80) }] : []),
      ].filter((x) => x.bytes > 0).sort((a, b) => b.bytes - a.bytes);
      const pgCatalogBytes = schemas.find((s) => s.name === 'pg_catalog')?.bytes ?? 0;
      const dbComp = [
        ...schemas.filter((s) => !isSys(s.name)).map((s) => ({ name: s.name, bytes: s.bytes, rels: s.rels, kind: 'schema', desc: `${s.rels} 张表` })),
        ...(stmt.available && stmt.bytes > 0 ? [{ name: 'statement_history', bytes: stmt.bytes, rels: 1, kind: 'sys', desc: `pg_catalog · 全量 SQL 追踪（${gucs.track_stmt_stat_level ?? '?'}）· ${stmt.rows.toLocaleString('en-US')} 行` }] : []),
        ...(wdr.bytes > 0 ? [{ name: 'snapshot', bytes: wdr.bytes, rels: schemas.find((s) => s.name === 'snapshot')?.rels ?? 0, kind: 'sys', desc: `WDR 快照 ${wdr.count} 个 · 保留 ${gucs.wdr_snapshot_retention_days ?? '?'} 天` }] : []),
        ...(pgCatalogBytes - stmt.bytes > 0 ? [{ name: '其它目录表', bytes: pgCatalogBytes - stmt.bytes, rels: 0, kind: 'sys', desc: 'pg_catalog 其余' }] : []),
      ].sort((a, b) => b.bytes - a.bytes);

      const payload = {
        scope: 'capacity', version: 1, node: node.name, nodeId: node.id, db: dbName, collectedAt, growthWindowDays: days, topN,
        det: { worst, counts }, findings,
        summary: { dbBytes, dbBytesAll, dataDirBytes, dataDirSource, filesAvailable, disk: undefined, nonTableBytes, nonTableShare: dataDirBytes > 0 ? nonTableBytes / dataDirBytes : 0, growth, daysToFull: dtf, delta24, gapHours, firstRun, bloatTodo: findings.filter((f) => f.rule === 'CAP_STMT_HISTORY_BLOAT' && f.level !== 'ok').length, statsNeverCount: statsNever.count, lastSampleAt: lastSampleAt !== undefined ? new Date(lastSampleAt).toISOString() : undefined },
        history: {
          points, gaps, events, source: historySource,
          // 三条序列（面板可切）：db 恒有；dir 在文件级不可读时等于"库内合计"；disk 需主机侧采集接入
          series: {
            db: { points, available: true, label: `数据库 ${dbName}（pg_database_size）`, note: '' },
            dir: { points: [...dirSeries, { t: nowMs, bytes: dataDirBytes }], available: true, label: filesAvailable ? '数据目录（库 + WAL + 日志 + 审计 + core）' : '数据目录 · 仅库内合计', note: filesAvailable ? '' : 'openGauss 的 pg_ls_dir / pg_stat_file 只允许初始账号（omm），WAL / 日志 / 审计 / core 未计入' },
            disk: { points: diskSeries, available: diskSeries.length > 0, label: '磁盘已用（数据目录所在卷）', note: '主机侧采集未接入：openGauss 视图不暴露文件系统容量，这条序列要等主机侧（df）接入后才有值' },
          },
        },
        composition: { dir: dirComp, db: dbComp },
        databases, tablespaces, schemas, topTables, deadTop, statsNever,
        sys: { wal, stmt: { ...stmt, enable: gucs.enable_stmt_track ?? '', level: gucs.track_stmt_stat_level ?? '', retention: gucs.track_stmt_retention_time ?? '' }, wdr: { ...wdr, retentionDays: gucNum('wdr_snapshot_retention_days'), interval: gucs.wdr_snapshot_interval ?? '' }, log, audit, core },
        gucs, collectionNotes: notes,
      };

      // ⑩ 采样入库 + 存档
      let archiveLine = '';
      if (deps.pool !== undefined) {
        try {
          const rows: [string, string, number, unknown][] = [
            ...databases.map((d) => ['db', d.name, d.bytes, null] as [string, string, number, unknown]),
            ['dir', 'data', dataDirBytes, { source: dataDirSource }],
            ...(input.disk !== undefined ? [['disk', 'used', input.disk.usedBytes, { total: input.disk.totalBytes, avail: input.disk.availBytes }] as [string, string, number, unknown]] : []),
            ...tablespaces.map((t) => ['tablespace', t.name, t.bytes, null] as [string, string, number, unknown]),
            ...schemas.map((s) => ['schema', s.name, s.bytes, { rels: s.rels }] as [string, string, number, unknown]),
            ...tables.map((t) => ['table', `${t.sch}.${t.name}`, t.total, { heap: t.heap, idx: t.idx, reltuples: t.reltuples, dead: t.dead }] as [string, string, number, unknown]),
            ['sys', 'statement_history', stmt.bytes, { rows: stmt.rows }], ['sys', 'wdr', wdr.bytes, { count: wdr.count }], ['sys', 'xlog', wal.bytes, { segments: wal.segments }],
            ['sys', 'log', log.bytes, { files: log.files }], ['sys', 'audit', audit.bytes, { files: audit.files }], ['sys', 'core', core.bytes, { files: core.files.length }],
          ];
          const values = rows.map((_, i) => `($1, $2, $${i * 4 + 3}, $${i * 4 + 4}, $${i * 4 + 5}, $${i * 4 + 6}::jsonb)`).join(', ');
          const params: unknown[] = [node.name, collectedAt]; for (const r of rows) params.push(r[0], r[1], Math.round(r[2]), r[3] === null ? null : JSON.stringify(r[3]));
          await deps.pool.query(`INSERT INTO opendb_capacity_samples (node, collected_at, kind, name, bytes, extra) VALUES ${values}`, params);
          const sessionId = typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : null;
          const r = await deps.pool.query(`INSERT INTO opendb_task_collects (task_type, session_id, node, worst, collected_at, payload) VALUES ('capacity', $1, $2, $3, now(), $4) RETURNING id`, [sessionId, node.name, worst, JSON.stringify(payload)]);
          if (r.rows[0] !== undefined) archiveLine = `\n-- 采集已存档 opendb_task_collects#${Number(r.rows[0].id)}，采样 ${rows.length} 行入 opendb_capacity_samples（任务面板直读全部数字；报告只写解读）`;
        } catch (cause) { archiveLine = `\n-- 采集存档失败：${errMsg(cause)}`; }
      }

      // ⑪ 给模型的精简视图
      const forModel = {
        node: node.name, db: dbName, det: payload.det,
        findings: findings.map((f) => ({ rule: f.rule, level: f.level, object: f.object, problem: f.problem, advice: f.advice, evidence: f.evidence })),
        summary: { dbGB: +(dbBytes / GIB).toFixed(1), dataDirGB: +(dataDirBytes / GIB).toFixed(1), dataDirSource: filesAvailable ? 'estimate（库 + WAL + 日志 + 审计 + core；无主机 du）' : 'db-only（文件级需初始账号，WAL / 日志 / 审计 / core 未计入）', disk: '主机侧未接入，不做满盘外推', nonTableGB: +(nonTableBytes / GIB).toFixed(1), nonTableShare: `${Math.round(payload.summary.nonTableShare * 100)}%${filesAvailable ? '' : '（不含 WAL / 日志）'}`,
          growth: { windowHours: growth.windowHours, points: growth.points, netGB: +(growth.netBytes / GIB).toFixed(2), gbPerDay: +(growth.bytesPerDay / GIB).toFixed(3), confidence: growth.confidence, segment: growth.segment, resetAt: growth.resetAt !== undefined ? new Date(growth.resetAt).toISOString() : undefined, note: growth.segment === 'pre-reset' ? '观测窗内发生清理悬崖，之后样本不足，增速暂取清理前的段（几乎平直）；清理后的增速自后续采样起可得' : undefined }, firstRun, gapHours, delta24 },
        historyEvents: events.map((e) => `${new Date(e.t).toISOString().slice(0, 16)} ${e.label}`),
        composition: { dir: dirComp.slice(0, 8).map((d) => `${d.name} ${gb(d.bytes)}（${d.desc}）`), db: dbComp.slice(0, 10).map((d) => `${d.name} ${gb(d.bytes)}（${d.desc}）`) },
        topTables: topTables.slice(0, topN).map((t) => ({ table: `${t.sch}.${t.name}`, totalGB: +(t.total / GIB).toFixed(2), heapGB: +(t.heap / GIB).toFixed(2), idxGB: +(t.idx / GIB).toFixed(2), reltuples: t.reltuples, deadPct: Math.round(t.deadRatio * 100), lastVacuum: t.lastVacuum ?? 'never', lastAnalyze: t.lastAnalyze ?? 'never', deltaGB: t.delta !== undefined ? +(t.delta.bytes / GIB).toFixed(2) : undefined })),
        statsNever: { count: statsNever.count, bySchema: statsNever.bySchema, top: statsNever.items.slice(0, 5).map((r) => `${r.sch}.${r.name} ${r.reltuples.toLocaleString('en-US')} 行 ${gb(r.total)}`) },
        deadTop: deadTop.slice(0, 5).map((d) => `${d.name} ${Math.round(d.ratio * 100)}%（${d.dead.toLocaleString('en-US')} 行，${gb(d.bytes)}）`),
        sys: { wal: wal.available ? `${wal.segments} 段 ${gb(wal.bytes)} · checkpoint_segments ${wal.checkpointSegments} · wal_keep_segments ${wal.walKeepSegments} · 复制槽 ${wal.slots}（不活跃 ${wal.slotsInactive}）` : `目录不可读（需初始账号）· 按 checkpoint_segments ${wal.checkpointSegments} 估上限 ≤ ${gb(wal.capBytes)} · wal_keep_segments ${wal.walKeepSegments} · 复制槽 ${wal.slots}（不活跃 ${wal.slotsInactive}）`,
          statementHistory: stmt.available ? `${gb(stmt.bytes)} · ${stmt.rows.toLocaleString('en-US')} 行 · enable_stmt_track=${gucs.enable_stmt_track} · track_stmt_stat_level=${gucs.track_stmt_stat_level} · retention=${gucs.track_stmt_retention_time}` : '不可用',
          wdr: wdr.enabled ? `${wdr.count} 个快照 ${gb(wdr.bytes)} · 保留 ${gucs.wdr_snapshot_retention_days} · 间隔 ${gucs.wdr_snapshot_interval} · 最老 ${wdr.oldestAgeDays} 天` : '未开启',
          log: log.available ? `${log.files} 个文件 ${gb(log.bytes)} · 最老 ${log.oldest ?? '?'} · log_min_duration_statement=${gucs.log_min_duration_statement} · 轮转 ${gucs.log_rotation_age}，无最长保留参数` : '不可读',
          audit: audit.available ? `${audit.files} 个文件 ${gb(audit.bytes)}` : '不可读', core: core.available ? (core.files.length > 0 ? core.files.map((f) => `${f.name} ${gb(f.bytes)}`).join('，') : '无') : '不可读' },
        collectionNotes: notes,
      };
      const header = [
        `-- capacity_collect · ${node.name}/${dbName} · 库 ${gb(dbBytes)} · ${filesAvailable ? `数据目录≈${gb(dataDirBytes)}` : '数据目录不可估（文件级需初始账号）'} · 非表占用 ${gb(nonTableBytes)}（${Math.round(payload.summary.nonTableShare * 100)}%${filesAvailable ? '' : '，不含 WAL/日志'}）· 增速 ${(growth.bytesPerDay / GIB).toFixed(2)} GB/天（观测 ${growth.windowHours} h，${growth.confidence}${growth.segment === 'pre-reset' ? '，取清理前段' : ''}）· worst=${worst}（${LEVEL_CN[worst]}）`,
        `-- 一眼结论（脚本判定）：${findings.filter((f) => f.level !== 'ok').map((f) => `${f.rule} ${f.problem}`).join('；') || '全部正常'}`,
        `-- 以下 JSON 是唯一事实来源：det 逐字进报告；你只写 situation / findings[].note / rootCause / priorities，数字不必复述`,
      ].join('\n');
      return { content: clampText(`${header}${archiveLine}\n${JSON.stringify(forModel, null, 1)}`, deps.maxContentBytes) };
    },
  } as any);
}

export function apply(ctx: Context, config: { maxContentBytes?: number; connectionString?: string; keepTables?: number } = {}): void {
  const anyCtx = ctx as any;
  const conn = config.connectionString ?? '';
  const pool = conn !== '' ? createPool(conn) : undefined;
  if (pool !== undefined) ctx.effect(() => () => pool.end(), 'tool-capacity-collect.pool');
  anyCtx.inject(['tools'], (c: any) => {
    const deps: Deps = { db: anyCtx.opendbDb, registry: anyCtx.opendbRegistry, thresholds: anyCtx.opendbThresholds, maxContentBytes: config.maxContentBytes ?? 40000, keepTables: config.keepTables ?? 50, pool };
    c.effect(() => c.tools.register(defineCapacityCollectTool(deps)), 'tool-capacity-collect.capacity_collect');
  });
}
