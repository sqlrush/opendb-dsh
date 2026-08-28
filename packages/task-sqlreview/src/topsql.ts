/**
 * Top SQL 多维榜单 + 资源占比 + 确定性结论（R5 慢 SQL 报表重构，user 2026-08-27 定稿）：
 * - 榜单维度由任务配置决定（用户在会话里说"按执行次数和耗时"→ dimensions=[calls, elapsed]）；
 * - 每个维度从 dbe_perf.statement 取 Top-N，去重后每条 SQL 带全量指标、占全库比例、榜位、类型判定；
 * - 「一眼结论」按占比阈值由脚本生成（阈值登记在平台阈值配置里），模型只做逐条解读；
 * - 规则违规按"引用的表"归到各条 SQL 名下（面板不再在顶部汇总违规）。
 * 数字全部来自采集器直读（健康报告 2026-08-26 定下的原则），模型报告只贡献叙述。
 */

import { SQLREVIEW_THRESHOLDS, type SqlreviewThresholds, type RuleFinding } from './rules.ts';
import { shortKey } from './sqlscan.ts';

export type DimKey = 'elapsed' | 'calls' | 'avg' | 'cpu' | 'io' | 'blocks' | 'dbtime' | 'spill' | 'rows';
export type DimUnit = 'us' | 'count' | 'bytes';
export interface DimSpec { key: DimKey; label: string; expr: string; unit: DimUnit; shareable: boolean; desc: string }

export const DIMENSIONS: Record<DimKey, DimSpec> = {
  elapsed: { key: 'elapsed', label: '总耗时', expr: 'total_elapse_time', unit: 'us', shareable: true, desc: 'total_elapse_time · 占全库总耗时' },
  calls: { key: 'calls', label: '执行次数', expr: 'n_calls', unit: 'count', shareable: true, desc: 'n_calls · 占全库总调用' },
  avg: { key: 'avg', label: '平均耗时', expr: 'total_elapse_time / n_calls', unit: 'us', shareable: false, desc: 'total_elapse_time / n_calls' },
  cpu: { key: 'cpu', label: 'CPU 时间', expr: 'cpu_time', unit: 'us', shareable: true, desc: 'cpu_time · 占全库 CPU 时间' },
  io: { key: 'io', label: 'IO 时间', expr: 'data_io_time', unit: 'us', shareable: true, desc: 'data_io_time · 占全库 IO 时间' },
  blocks: { key: 'blocks', label: '逻辑读', expr: 'n_blocks_fetched', unit: 'count', shareable: true, desc: 'n_blocks_fetched · 占全库逻辑读' },
  dbtime: { key: 'dbtime', label: 'DB Time', expr: 'db_time', unit: 'us', shareable: true, desc: 'db_time · 占全库 DB Time' },
  spill: { key: 'spill', label: '下盘', expr: 'sort_spill_size + hash_spill_size', unit: 'bytes', shareable: true, desc: '排序/哈希下盘字节 · 占全库下盘' },
  rows: { key: 'rows', label: '返回行数', expr: 'n_returned_rows', unit: 'count', shareable: true, desc: 'n_returned_rows · 占全库返回行' },
};
export const DIM_KEYS = Object.keys(DIMENSIONS) as DimKey[];
export const DEFAULT_DIMENSIONS: DimKey[] = ['elapsed', 'calls', 'avg'];

/** 模型/用户可能用中文或别名表达维度：统一成 DimKey，去重，空则回默认三榜 */
const DIM_ALIASES: Record<string, DimKey> = {
  elapsed: 'elapsed', total: 'elapsed', total_elapse_time: 'elapsed', 总耗时: 'elapsed', 耗时: 'elapsed', 执行时长: 'elapsed', 总时长: 'elapsed', 时长: 'elapsed',
  calls: 'calls', n_calls: 'calls', count: 'calls', 执行次数: 'calls', 调用次数: 'calls', 次数: 'calls', 频次: 'calls', 执行频率: 'calls',
  avg: 'avg', average: 'avg', avg_ms: 'avg', 平均耗时: 'avg', 均耗时: 'avg', 单次耗时: 'avg', 平均时长: 'avg', 平均执行时间: 'avg',
  cpu: 'cpu', cpu_time: 'cpu', cpu时间: 'cpu',
  io: 'io', data_io_time: 'io', io时间: 'io',
  blocks: 'blocks', n_blocks_fetched: 'blocks', 逻辑读: 'blocks', buffer_gets: 'blocks', gets: 'blocks',
  dbtime: 'dbtime', db_time: 'dbtime', 'db time': 'dbtime',
  spill: 'spill', 下盘: 'spill', 外排: 'spill', temp: 'spill',
  rows: 'rows', n_returned_rows: 'rows', 返回行数: 'rows', 返回行: 'rows',
};
export function normalizeDimensions(input: unknown): DimKey[] {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[,，、\s]+/) : [];
  const out: DimKey[] = [];
  for (const v of raw) {
    const k = DIM_ALIASES[String(v).trim().toLowerCase()] ?? DIM_ALIASES[String(v).trim()];
    if (k !== undefined && !out.includes(k)) out.push(k);
  }
  return out.length > 0 ? out : [...DEFAULT_DIMENSIONS];
}

export interface SqlMetrics {
  calls: number; elapsedUs: number; avgUs: number; minUs: number; maxUs: number;
  cpuUs: number; ioUs: number; blocks: number; blocksHit: number; dbTimeUs: number; rowsRet: number; spillBytes: number;
}
export interface Workload {
  nSql: number; calls: number; elapsedUs: number; cpuUs: number; ioUs: number; blocks: number; blocksHit: number; dbTimeUs: number; rowsRet: number; spillBytes: number;
}
export type SqlKind = '事务控制' | '监控类' | 'OLTP 高频' | '分析型' | '疑似锁等待' | '中等耗时' | '常规' | '指定';

export interface TopSqlItem {
  key: string;                 // 文本短 hash（与 sqlscan.shortKey 一致，报告按它对齐）
  label: string;               // S1、S2…（按首次上榜顺序编号，面板配色/图例用）
  uniqueSqlId: string;
  text: string;
  kind: SqlKind;
  metrics: SqlMetrics;
  shares: Partial<Record<DimKey, number>>;   // 占全库百分比（1 位小数）；avg 无占比
  ranks: Partial<Record<DimKey, number>>;    // 各榜榜位（1 起）
  tables: string[];            // 引用的表名（小写、不带 schema），规则归因用
  specified?: boolean;         // 任务配置里也贴了这条（按指纹对上），不再另立一项
  tracked?: boolean;           // 会话里指定跟踪的对象（跟踪模式）；有运行记录时指标/占比/榜位照算
}

/**
 * 报表模式（user 2026-08-27）：要理解对话意思——用户要的是各维度 Top-N，还是跟踪他在对话里讨论的那几条 SQL；
 * 对象明确后只跟踪对象。配置表达：sqls 非空且 dimensions 为空数组 = 跟踪模式；否则榜单模式（sqls 里的会按指纹并入榜单）。
 */
export type ReportMode = 'top' | 'track';
export function resolveMode(config: { dimensions?: unknown; sqls?: unknown }): ReportMode {
  const sqls = Array.isArray(config.sqls) ? config.sqls.filter((s) => typeof s === 'string' && s.trim() !== '') : [];
  const dims = Array.isArray(config.dimensions) ? config.dimensions : undefined;
  return sqls.length > 0 && dims !== undefined && dims.length === 0 ? 'track' : 'top';
}
/** 跟踪模式下占比条/结论用的维度（不出榜，但资源占比仍按这些算） */
export const TRACK_SHARE_DIMS: DimKey[] = ['elapsed', 'dbtime', 'cpu', 'io', 'blocks', 'calls'];
export interface Board { dim: DimKey; label: string; desc: string; unit: DimUnit; keys: string[]; values: number[]; shares: (number | null)[] }
export interface Insight { level: 'warn' | 'notice' | 'ok'; key?: string; text: string }

export type QueryFn = (sql: string, maxRows?: number) => Promise<{ rows: Record<string, unknown>[] }>;
const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const pct = (part: number, total: number): number => (total > 0 ? Math.round((part / total) * 1000) / 10 : 0);

/** 与旧 fetchTopSql 相同的过滤：去掉平台监控/字典自身的查询与 EXPLAIN/SET */
export const STATEMENT_FILTER = `WHERE n_calls > 0
  AND query NOT ILIKE '%dbe_perf.%' AND query NOT ILIKE '%pg_catalog.%'
  AND query NOT ILIKE '%pg_stat_%' AND query NOT ILIKE '%pg_database_size%'
  AND query NOT ILIKE 'EXPLAIN%' AND query NOT ILIKE 'SET %'`;

const METRIC_COLS = `unique_sql_id, query, n_calls, total_elapse_time, min_elapse_time, max_elapse_time, cpu_time, data_io_time,
  n_blocks_fetched, n_blocks_hit, db_time, n_returned_rows, sort_spill_size + hash_spill_size AS spill_bytes`;

export async function fetchWorkload(q: QueryFn): Promise<Workload> {
  const r = (await q(`SELECT count(*) AS n_sql, sum(n_calls) AS calls, sum(total_elapse_time) AS elapsed, sum(cpu_time) AS cpu,
  sum(data_io_time) AS io, sum(n_blocks_fetched) AS blocks, sum(n_blocks_hit) AS hit, sum(db_time) AS dbtime,
  sum(n_returned_rows) AS rows_ret, sum(sort_spill_size + hash_spill_size) AS spill_bytes
FROM dbe_perf.statement ${STATEMENT_FILTER}`, 1)).rows[0] ?? {};
  return {
    nSql: num(r.n_sql), calls: num(r.calls), elapsedUs: num(r.elapsed), cpuUs: num(r.cpu), ioUs: num(r.io),
    blocks: num(r.blocks), blocksHit: num(r.hit), dbTimeUs: num(r.dbtime), rowsRet: num(r.rows_ret), spillBytes: num(r.spill_bytes),
  };
}

function metricsOf(r: Record<string, unknown>): SqlMetrics {
  const calls = num(r.n_calls);
  const elapsedUs = num(r.total_elapse_time);
  return {
    calls, elapsedUs, avgUs: calls > 0 ? Math.round(elapsedUs / calls) : 0, minUs: num(r.min_elapse_time), maxUs: num(r.max_elapse_time),
    cpuUs: num(r.cpu_time), ioUs: num(r.data_io_time), blocks: num(r.n_blocks_fetched), blocksHit: num(r.n_blocks_hit),
    dbTimeUs: num(r.db_time), rowsRet: num(r.n_returned_rows), spillBytes: num(r.spill_bytes),
  };
}

/** 某维度上一条 SQL 的取值（与 DIMENSIONS.expr 同义，但从已取到的指标算，避免二次查询） */
export function dimValue(dim: DimKey, m: SqlMetrics): number {
  switch (dim) {
    case 'elapsed': return m.elapsedUs; case 'calls': return m.calls; case 'avg': return m.avgUs; case 'cpu': return m.cpuUs;
    case 'io': return m.ioUs; case 'blocks': return m.blocks; case 'dbtime': return m.dbTimeUs; case 'spill': return m.spillBytes; case 'rows': return m.rowsRet;
  }
}
function dimTotal(dim: DimKey, w: Workload): number {
  switch (dim) {
    case 'elapsed': return w.elapsedUs; case 'calls': return w.calls; case 'avg': return 0; case 'cpu': return w.cpuUs;
    case 'io': return w.ioUs; case 'blocks': return w.blocks; case 'dbtime': return w.dbTimeUs; case 'spill': return w.spillBytes; case 'rows': return w.rowsRet;
  }
}
export function sharesOf(m: SqlMetrics, w: Workload): Partial<Record<DimKey, number>> {
  const out: Partial<Record<DimKey, number>> = {};
  for (const d of DIM_KEYS) if (DIMENSIONS[d].shareable) out[d] = pct(dimValue(d, m), dimTotal(d, w));
  return out;
}

/** SQL 引用的表名（小写、去 schema/引号）：FROM/JOIN/UPDATE/INSERT INTO/DELETE FROM 后的标识符 */
export function referencedTables(text: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:from|join|update|into|delete\s+from)\s+(?:only\s+)?((?:"?[\w$]+"?\.)?"?([\w$]+)"?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[2].toLowerCase();
    if (!/^(select|values|lateral|only|dual)$/.test(name)) out.add(name);
  }
  return [...out];
}

/** 类型判定（确定性启发式，只用于标签与结论，不参与规则判定） */
export function classify(text: string, m: SqlMetrics): SqlKind {
  const head = text.trim().replace(/^\/\*.*?\*\/\s*/s, '');
  if (/^(begin|commit|rollback|start\s+transaction|end|set\s|reset\s|savepoint|release|show\s)/i.test(head)) return '事务控制';
  if (/^select/i.test(head) && /\b(gs_|pg_|dbe_perf\.|pgxc_|information_schema\.)/i.test(text)) return '监控类';
  if (m.avgUs >= 1_000_000) {
    const blocksPerCall = m.blocks / Math.max(1, m.calls);
    if (/^(update|delete)/i.test(head) && blocksPerCall < 1000) return '疑似锁等待';
    return '分析型';
  }
  if (m.avgUs < 10_000 && m.calls >= 1000) return 'OLTP 高频';
  if (m.avgUs >= 100_000) return '中等耗时';
  return '常规';
}

export interface TopSqlResult { workload: Workload; boards: Board[]; items: TopSqlItem[] }

/**
 * 按配置的维度各取 Top-N，去重合并。编号 S1.. 按"第一个维度榜的顺序、再后续榜首次出现"分配，
 * 面板配色/图例/榜位徽章都用它。每条只查一次 dbe_perf.statement 行（榜与榜之间共享）。
 */
export async function buildTopSql(q: QueryFn, dims: DimKey[], topN: number): Promise<TopSqlResult> {
  const n = Math.max(1, Math.min(topN, 20));
  const workload = await fetchWorkload(q);
  const byId = new Map<string, { row: Record<string, unknown>; ranks: Partial<Record<DimKey, number>> }>();
  const boards: Board[] = [];
  for (const dim of dims) {
    const spec = DIMENSIONS[dim];
    const rows = (await q(`SELECT ${METRIC_COLS} FROM dbe_perf.statement ${STATEMENT_FILTER}
ORDER BY ${spec.expr} DESC LIMIT ${n}`, n)).rows;
    const keys: string[] = []; const values: number[] = []; const shares: (number | null)[] = [];
    rows.forEach((row, i) => {
      const id = str(row.unique_sql_id) !== '' ? str(row.unique_sql_id) : shortKey(str(row.query));
      const cur = byId.get(id) ?? { row, ranks: {} };
      cur.ranks[dim] = i + 1;
      byId.set(id, cur);
      const m = metricsOf(row);
      keys.push(shortKey(str(row.query)));
      values.push(dimValue(dim, m));
      shares.push(spec.shareable ? pct(dimValue(dim, m), dimTotal(dim, workload)) : null);
    });
    boards.push({ dim, label: spec.label, desc: spec.desc, unit: spec.unit, keys, values, shares });
  }
  const items: TopSqlItem[] = [];
  let seq = 0;
  for (const [id, { row, ranks }] of byId) {
    seq += 1;
    const text = str(row.query);
    const metrics = metricsOf(row);
    items.push({
      key: shortKey(text), label: `S${seq}`, uniqueSqlId: id, text: text.slice(0, 1200), kind: classify(text, metrics),
      metrics, shares: sharesOf(metrics, workload), ranks, tables: referencedTables(text),
    });
  }
  return { workload, boards, items };
}

/**
 * SQL 指纹：字符串/数字字面量 → ?，小写、压空白、去尾分号。用于把任务配置里贴的 SQL（带具体参数）
 * 与榜单里的 unique_sql 文本（og 记成 ? 占位符）对上——同一条语句不再出现 S/Q 两份（2026-08-27 user 问"S1-3 和 Q1-3 有什么区别"）。
 */
export function fingerprint(text: string): string {
  return text
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;$/, '')
    .toLowerCase();
}

// ── 单次耗时构成 + 等待事件（dbe_perf.statement_history 最近 N 次执行的均值；只有进了慢 SQL 采样的语句才有）──
export interface WaitEvent { type: string; event: string; us: number; count: number; pct: number }
export interface ExecProfile {
  samples: number;                       // 参与均值的执行次数
  avgDbUs: number;                       // 单次 DB Time 均值
  parts: { name: string; us: number }[];  // CPU / IO / 锁等待 / LWLock 等待 / 网络 / 解析计划 / 其他（= DB Time − 前面各项，近似）
  waits: WaitEvent[];                    // 等待事件 Top（按累计 µs），pct = 占本条全部等待事件时间
  note?: string;
}

/** 解析 statement_detail_decode(details,'plaintext') 里的 Wait Events Area 行：'1' TYPE  event   12345 (us) */
export function parseWaitDetails(text: string): { type: string; event: string; us: number }[] {
  const out: { type: string; event: string; us: number }[] = [];
  const area = text.split(/LOCK\/LWLOCK Area/)[0] ?? '';
  for (const line of area.split('\n')) {
    const m = line.match(/^\s*'?\d+'?\s+(\S+)\s+(.+?)\s+(\d+)\s*\(us\)/);
    if (m !== null) out.push({ type: m[1].trim(), event: m[2].trim(), us: Number(m[3]) });
  }
  return out;
}

const netUs = (v: unknown): number => {
  if (typeof v !== 'string' || v === '') return 0;
  try { return num((JSON.parse(v) as { time?: unknown }).time); } catch { return 0; }
};

/** 由最近 N 次执行行算均值构成与等待事件汇总（纯函数，可测） */
export function profileFromRows(rows: readonly Record<string, unknown>[]): ExecProfile | undefined {
  if (rows.length === 0) return undefined;
  const n = rows.length;
  const avg = (k: string) => rows.reduce((s, r) => s + num(r[k]), 0) / n;
  const cpu = avg('cpu_time'); const io = avg('data_io_time'); const lock = avg('lock_wait_time'); const lw = avg('lwlock_wait_time');
  const net = rows.reduce((s, r) => s + netUs(r.net_send_info) + netUs(r.net_recv_info), 0) / n;
  const parse = avg('parse_time') + avg('plan_time') + avg('rewrite_time');
  const db = avg('db_time');
  const other = Math.max(0, db - cpu - io - lock - lw - net - parse);
  const parts = [
    { name: 'CPU', us: cpu }, { name: 'IO', us: io }, { name: '锁等待', us: lock }, { name: 'LWLock 等待', us: lw },
    { name: '网络', us: net }, { name: '解析/计划', us: parse }, { name: '其他', us: other },
  ].map((p) => ({ name: p.name, us: Math.round(p.us) })).filter((p) => p.us > 0);
  const agg = new Map<string, { type: string; event: string; us: number; count: number }>();
  for (const r of rows) {
    for (const w of parseWaitDetails(str(r.d))) {
      const k = `${w.type}|${w.event}`;
      const cur = agg.get(k) ?? { type: w.type, event: w.event, us: 0, count: 0 };
      agg.set(k, { ...cur, us: cur.us + w.us, count: cur.count + 1 });
    }
  }
  const total = [...agg.values()].reduce((s, w) => s + w.us, 0);
  const waits = [...agg.values()].sort((a, b) => b.us - a.us).slice(0, 6)
    .map((w) => ({ ...w, us: Math.round(w.us / n), pct: total > 0 ? Math.round((w.us / total) * 1000) / 10 : 0 }));
  return { samples: n, avgDbUs: Math.round(db), parts, waits };
}

/** 取一条 SQL 最近 sampleN 次执行（og 实测：按 unique_query_id 取 20 行 + 解码 ≈ 30 ms；不要 GROUP BY 全表） */
export async function fetchExecProfile(q: QueryFn, uniqueSqlId: string, sampleN = 20): Promise<ExecProfile | undefined> {
  if (!/^\d+$/.test(uniqueSqlId)) return undefined;
  const n = Math.max(1, Math.min(sampleN, 50));
  const rows = (await q(`SELECT db_time, cpu_time, execution_time, parse_time, plan_time, rewrite_time, data_io_time, lock_wait_time, lwlock_wait_time,
  net_send_info, net_recv_info, pg_catalog.statement_detail_decode(details, 'plaintext', true) AS d
FROM (SELECT * FROM dbe_perf.statement_history WHERE unique_query_id = ${uniqueSqlId} ORDER BY start_time DESC LIMIT ${n}) s`, n)).rows;
  return profileFromRows(rows);
}

/**
 * 会话里指定的 SQL → 在 dbe_perf.statement 里按指纹找运行记录（og 记的是 ? 占位文本，贴的是带参原文）。
 * 一次扫前 scanLimit 条（按总耗时降序；og5 全库 3,088 条一次覆盖），JS 侧指纹比对；扫描完整时顺带算各维度榜位。
 */
export async function matchStatements(q: QueryFn, texts: readonly string[], workload: Workload, scanLimit = 5000): Promise<Map<string, TopSqlItem | undefined>> {
  const out = new Map<string, TopSqlItem | undefined>();
  if (texts.length === 0) return out;
  const rows = (await q(`SELECT ${METRIC_COLS} FROM dbe_perf.statement ${STATEMENT_FILTER}
ORDER BY total_elapse_time DESC LIMIT ${Math.max(1, Math.min(scanLimit, 20000))}`, scanLimit)).rows;
  const complete = rows.length < scanLimit;
  const byFp = new Map<string, Record<string, unknown>>();
  for (const r of rows) { const fp = fingerprint(str(r.query)); if (!byFp.has(fp)) byFp.set(fp, r); }
  const rankDims: DimKey[] = ['elapsed', 'calls', 'avg', 'cpu', 'io', 'blocks', 'dbtime'];
  const sorted = complete ? new Map(rankDims.map((d) => [d, [...rows].map((r) => metricsOf(r)).map((m) => dimValue(d, m)).sort((a, b) => b - a)])) : undefined;
  for (const text of texts) {
    const r = byFp.get(fingerprint(text));
    if (r === undefined) { out.set(text, undefined); continue; }
    const rowText = str(r.query);
    const metrics = metricsOf(r);
    const ranks: Partial<Record<DimKey, number>> = {};
    if (sorted !== undefined) for (const d of rankDims) { const v = dimValue(d, metrics); const i = sorted.get(d)!.findIndex((x) => x <= v); ranks[d] = (i < 0 ? sorted.get(d)!.length : i) + 1; }
    out.set(text, {
      key: shortKey(rowText), label: '', uniqueSqlId: str(r.unique_sql_id), text: rowText.slice(0, 1200), kind: classify(rowText, metrics),
      metrics, shares: sharesOf(metrics, workload), ranks, tables: referencedTables(rowText), tracked: true,
    });
  }
  return out;
}

/** 规则违规归因：文本类按 key；目录类按"违规所在表 ∈ SQL 引用的表"。返回每条 SQL 的违规下标与未归因下标 */
export function attributeRules(items: readonly TopSqlItem[], findings: readonly RuleFinding[]): { byKey: Record<string, number[]>; unattributed: number[] } {
  const byKey: Record<string, number[]> = {};
  const used = new Set<number>();
  for (const it of items) {
    const refs: number[] = [];
    findings.forEach((f, i) => {
      const hit = f.object === it.key || (typeof f.table === 'string' && f.table !== '' && it.tables.includes(f.table.toLowerCase()));
      if (hit) { refs.push(i); used.add(i); }
    });
    byKey[it.key] = refs;
  }
  return { byKey, unattributed: findings.map((_, i) => i).filter((i) => !used.has(i)) };
}

const fmtUs = (us: number): string => (us >= 3_600e6 ? `${(us / 3_600e6).toFixed(1)} h` : us >= 60e6 ? `${(us / 60e6).toFixed(1)} min` : us >= 1e6 ? `${(us / 1e6).toFixed(1)} s` : `${(us / 1e3).toFixed(us < 10e3 ? 2 : 0)} ms`);
const fmtCount = (n: number): string => (n >= 1e8 ? `${(n / 1e8).toFixed(2)} 亿` : n >= 1e4 ? `${(n / 1e4).toFixed(n >= 1e6 ? 0 : 1)} 万` : String(Math.round(n)));

/**
 * 「一眼结论」：只看配置里的维度（与面板上的占比条一致），外加 COMMIT 提交等待这一条通用判据。
 * 阈值来自平台阈值配置（shareHighlightPct / commitDbTimePct）。最多 5 条。
 */
export function insightsOf(result: TopSqlResult, dims: DimKey[], T: SqlreviewThresholds = SQLREVIEW_THRESHOLDS): Insight[] {
  const out: Insight[] = [];
  const { workload: w, items } = result;
  for (const dim of dims) {
    const spec = DIMENSIONS[dim];
    if (!spec.shareable) continue;
    // 该维度占比最高的一条（榜单模式 = 榜首；跟踪模式没有榜，就在跟踪对象里挑）
    const top = [...items].filter((it) => (it.shares[dim] ?? 0) > 0).sort((a, b) => (b.shares[dim] ?? 0) - (a.shares[dim] ?? 0))[0];
    const share = top?.shares[dim] ?? 0;
    if (top !== undefined && share >= T.shareHighlightPct) {
      const m = top.metrics;
      out.push({ level: 'warn', key: top.key, text: `1 条${top.kind} SQL（${top.label}）占${spec.label} ${share}%：${fmtCount(m.calls)} 次 × 均 ${fmtUs(m.avgUs)}` });
    }
  }
  const commit = items.find((it) => /^commit\b/i.test(it.text.trim()));
  if (commit !== undefined && w.dbTimeUs > 0) {
    const share = pct(commit.metrics.dbTimeUs, w.dbTimeUs);
    if (share >= T.commitDbTimePct) out.push({ level: 'notice', key: commit.key, text: `COMMIT 占 DB Time ${share}%（${fmtCount(commit.metrics.calls)} 次提交）——提交等待 WAL 落盘值得看` });
  }
  const oltp = items.filter((it) => it.kind === 'OLTP 高频');
  if (oltp.length >= 3) {
    const maxAvg = Math.max(...oltp.map((it) => it.metrics.avgUs));
    out.push({ level: 'ok', text: `${oltp.length} 条 OLTP 高频短语句（单次 ≤ ${fmtUs(maxAvg)}），总量大只因调用次数，语句本身无优化空间` });
  }
  // 与面板占比条同口径：所有上榜（去重后）SQL 在该维度的占比之和，而不只是该榜的 Top-N（否则两处"上榜合计"对不上）
  const covered = dims.filter((d) => DIMENSIONS[d].shareable).map((d) => {
    const sum = items.reduce<number>((s, it) => s + (it.shares[d] ?? 0), 0);
    return `${DIMENSIONS[d].label} ${Math.min(100, Math.round(sum * 10) / 10)}%`;
  });
  const tracked = items.length > 0 && items.every((it) => it.tracked === true);
  // 上榜合计占总耗时很小（按平均耗时/返回行数等排出来的 Top 常见）：如实说它不是负载大头，别写"优化面集中"
  const elapsedSum = items.reduce<number>((s, it) => s + (it.shares.elapsed ?? 0), 0);
  const tail = tracked ? '' : elapsedSum < 5 ? `——不是负载大头（按 ${dims.map((d) => DIMENSIONS[d].label).join('/')} 排出的 Top 只代表单次贵），要找吃资源的 SQL 请加开总耗时 / 执行次数榜` : '——优化面集中';
  if (covered.length > 0) out.push({ level: elapsedSum < 5 && !tracked ? 'notice' : 'ok', text: `${tracked ? '跟踪的' : '上榜'} ${items.length} 条合计占：${covered.join(' · ')}${tail}` });
  return out.slice(0, 5);
}
