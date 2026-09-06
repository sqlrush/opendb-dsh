/**
 * 数据库大盘（每个节点的专属页）数据装配——一次 RPC 出全页（2026-09-06 重构，设计稿 docs/prototypes/node-r1.html）。
 *
 * 原则：数字全部来自确定性存档（指标序列 / 五类任务存档 / 体检存档 / 容量采样 / 任务表 / 字典变更），
 * 模型报告只贡献"一句话"；计数器一律差分成速率，不展示累计原值；采集缺项明说"未采集"，不留假 0。
 */
import type pg from 'pg';
import { parseCron, nextFire } from '@opendb-dsh/tasks';

export type Level = 'ok' | 'notice' | 'warn' | 'critical';
export type Unit = 'count' | 'ratio' | 'per_s' | 'ms' | 'bytes' | 'x';
export type Pt = [number, number];
const ORDER: Record<Level, number> = { ok: 0, notice: 1, warn: 2, critical: 3 };

export interface Kpi { key: string; label: string; unit: Unit; value: number | null; series: Pt[]; level: Level; note: string; available: boolean }
export interface Verdict {
  type: string; title: string; level: Level | null; at: string | null; stale: boolean; staleReason: string;
  headline: string; facts: { label: string; value: string }[]; schedule: { mode: 'cron' | 'manual'; cron?: string; overdueDays?: number };
  taskId?: string; sessionId?: string;
}
export interface Batch { at: string; schema: string; added: number; removed: number; modified: number; kinds: string[]; names: string[]; level: Level }
export interface TaskRow { id: string; name: string; type: string; cron: string; enabled: boolean; lastFiredAt: string | null; lastLevel: string | null; lastSummary: string; overdueDays: number | null }
export interface NodeDashboard {
  node: Record<string, unknown>; range: { hours: number; bucketSec: number };
  kpis: Kpi[]; os: Kpi[]; dbTime: { parts: { name: string; share: number }[]; waits: { name: string; share: number }[]; windowMin: number };
  verdicts: Verdict[]; composite: { level: Level; why: string };
  storage: { dbs: { name: string; bytes: number }[]; nonTableBytes: number | null; growth: Pt[]; bytesPerDay: number | null; growthNote: string };
  timeline: Batch[]; tasks: TaskRow[]; knowledge: { memories: number; docs: number; kgEdges: number };
}

/** 阈值口径与 task-health 一致（缓存命中 / 连接占用 / 每核负载 / IOWait 占比）；后续接 opendbThresholds 可配置化。 */
const THRESH = {
  cacheHit: { notice: 0.99, warn: 0.95 },
  connUsed: { notice: 0.6, warn: 0.8 },
  loadPerCore: { notice: 1, warn: 2 },
  iowaitShare: { notice: 0.2, warn: 0.5 },
  waitingLocks: { notice: 1, warn: 5 },
};
const VERDICT_TYPES: { type: string; title: string }[] = [
  { type: 'health', title: '健康体检' }, { type: 'sqlreview', title: 'SQL 审核' }, { type: 'wdr', title: 'WDR 窗口' },
  { type: 'ddl', title: 'DDL 变更' }, { type: 'capacity', title: '容量与增长' },
];
const MANUAL_STALE_MS = 7 * 86_400_000;
const CRON_GRACE_MS = 10 * 60_000;
const TIMELINE_DAYS = 14;
const TIMELINE_BATCHES = 12;

// ───────────────────────────────────────────── 纯函数（可单测）

/** 累计计数器 → 每秒速率；负增量（计数器重置）跳过。 */
export function rateSeries(cum: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i < cum.length; i += 1) {
    const dt = (cum[i][0] - cum[i - 1][0]) / 1000;
    const dv = cum[i][1] - cum[i - 1][1];
    if (dt > 0 && dv >= 0) out.push([cum[i][0], dv / dt]);
  }
  return out;
}

/** 两条累计序列的增量占比 Δa/(Δa+Δb)；两者都没增量的桶跳过。 */
export function ratioSeries(a: Pt[], b: Pt[]): Pt[] {
  const bm = new Map(b.map((p) => [p[0], p[1]]));
  const out: Pt[] = [];
  for (let i = 1; i < a.length; i += 1) {
    const t0 = a[i - 1][0]; const t1 = a[i][0];
    const b0 = bm.get(t0); const b1 = bm.get(t1);
    if (b0 === undefined || b1 === undefined) continue;
    const da = a[i][1] - a[i - 1][1]; const db = b1 - b0;
    if (da < 0 || db < 0 || da + db <= 0) continue;
    out.push([t1, da / (da + db)]);
  }
  return out;
}

/** 两条速率/增量序列相除（如 Δelapse_us / Δcalls），分母为 0 的桶跳过。 */
export function divideSeries(num: Pt[], den: Pt[]): Pt[] {
  const dm = new Map(den.map((p) => [p[0], p[1]]));
  return num.flatMap((p) => { const d = dm.get(p[0]); return d !== undefined && d > 0 ? [[p[0], p[1] / d] as Pt] : []; });
}

export function levelBy(value: number | null, tiers: { notice: number; warn: number }, cmp: '>=' | '<' = '>='): Level {
  if (value === null || !Number.isFinite(value)) return 'ok';
  if (cmp === '>=') return value >= tiers.warn ? 'warn' : value >= tiers.notice ? 'notice' : 'ok';
  return value < tiers.warn ? 'warn' : value < tiers.notice ? 'notice' : 'ok';
}

export function worstOf(levels: (Level | null)[]): Level {
  return levels.reduce<Level>((acc, l) => (l !== null && ORDER[l] > ORDER[acc] ? l : acc), 'ok');
}

/** cron 周期（毫秒）：两次 nextFire 的间距；解析失败返回 undefined。 */
export function cronPeriodMs(cron: string, base = new Date()): number | undefined {
  try {
    const spec = parseCron(cron);
    const n1 = nextFire(spec, base); if (n1 === undefined) return undefined;
    const n2 = nextFire(spec, n1); if (n2 === undefined) return undefined;
    return n2.getTime() - n1.getTime();
  } catch { return undefined; }
}

/** 逾期天数：上次触发后的下一个应触发点已过去超过宽限，则算逾期（null = 不逾期或无 cron）。 */
export function overdueDays(cron: string, lastFiredAt: Date | null, createdAt: Date, now: Date): number | null {
  try {
    const spec = parseCron(cron);
    const expected = nextFire(spec, lastFiredAt ?? createdAt);
    if (expected === undefined) return null;
    const late = now.getTime() - expected.getTime() - CRON_GRACE_MS;
    return late > 0 ? Math.max(1, Math.floor(late / 86_400_000)) : null;
  } catch { return null; }
}

/** 字典变更行（按分钟 × schema × change × kind 聚合后）→ 批次；同分钟同 schema 合并。 */
export function groupBatches(rows: { m: string; sch: string; change: string; kind: string; c: number; names: string[] }[]): Batch[] {
  const map = new Map<string, Batch>();
  for (const r of rows) {
    const key = `${r.m}|${r.sch}`;
    const cur = map.get(key) ?? { at: r.m, schema: r.sch, added: 0, removed: 0, modified: 0, kinds: [], names: [], level: 'ok' as Level };
    const next: Batch = {
      ...cur,
      added: cur.added + (r.change === 'added' ? r.c : 0),
      removed: cur.removed + (r.change === 'removed' ? r.c : 0),
      modified: cur.modified + (r.change !== 'added' && r.change !== 'removed' ? r.c : 0),
      kinds: cur.kinds.includes(r.kind) ? cur.kinds : [...cur.kinds, r.kind],
      names: [...cur.names, ...r.names].slice(0, 6),
    };
    map.set(key, next);
  }
  return [...map.values()]
    .map((b) => ({ ...b, level: batchLevel(b) }))
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, TIMELINE_BATCHES);
}
function batchLevel(b: Batch): Level {
  if (b.removed > 0 && b.kinds.includes('schema')) return 'critical';
  if (b.removed > 0) return 'warn';
  if (b.modified > 0) return 'notice';
  return 'ok';
}

/** 一句话：取报告摘要的第一句（中英文句号 / 分号前），限长。 */
export function headlineOf(summary: string, max = 72): string {
  const s = summary.replace(/\s+/g, ' ').trim();
  const cut = s.split(/[。；;]\s*/)[0] ?? s;
  return cut.length > max ? `${cut.slice(0, max - 1)}…` : cut;
}

const fmtGB = (b: number): string => `${(b / 2 ** 30).toFixed(1)} GB`;
/** 五类存档 → 2–3 个关键数（不同类型各取各的"最能说明问题"的数字）。 */
export function factsFor(type: string, p: any): { label: string; value: string }[] {
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const arrLen = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  switch (type) {
    case 'sqlreview': return [
      { label: 'Top SQL', value: String(arrLen(p?.items)) },
      { label: '规则命中', value: String(arrLen(p?.ruleFindings)) },
      ...(n(p?.workload?.nSql) !== null ? [{ label: '跟踪 SQL', value: String(p.workload.nSql) }] : []),
    ];
    case 'wdr': return [
      ...(n(p?.summary?.aas) !== null ? [{ label: 'AAS', value: Number(p.summary.aas).toFixed(2) }] : []),
      ...(n(p?.summary?.tps) !== null ? [{ label: 'TPS', value: String(Math.round(p.summary.tps)) }] : []),
      { label: 'Top SQL', value: String(arrLen(p?.topSql)) },
    ];
    case 'ddl': return [
      ...(n(p?.summary?.events) !== null ? [{ label: '变更事件', value: String(p.summary.events) }] : []),
      ...(n(p?.summary?.destructive) !== null ? [{ label: '破坏性', value: String(p.summary.destructive) }] : []),
      { label: '规则命中', value: String(arrLen(p?.ruleFindings)) },
    ];
    case 'capacity': return [
      ...(n(p?.summary?.dbBytes) !== null ? [{ label: '库大小', value: fmtGB(p.summary.dbBytes) }] : []),
      ...(n(p?.summary?.growth?.bytesPerDay) !== null ? [{ label: '增速', value: `${(p.summary.growth.bytesPerDay / 2 ** 30).toFixed(2)} GB/天` }] : []),
      ...(n(p?.statsNever?.count) !== null ? [{ label: '从未 ANALYZE', value: `${p.statsNever.count} 表` }] : []),
    ];
    default: return [];
  }
}

/** 体检存档里该节点的维度 → 关键数（非 ok 的 measure 前两条）与一句话。 */
export function healthFacts(nodeEntry: any): { facts: { label: string; value: string }[]; headline: string } {
  const dims: any[] = Array.isArray(nodeEntry?.dims) ? nodeEntry.dims : [];
  const measures = dims.flatMap((d) => (Array.isArray(d.measures) ? d.measures : []));
  const bad = measures.filter((m) => m.level !== undefined && m.level !== 'ok').sort((a, b) => (ORDER[b.level as Level] ?? 0) - (ORDER[a.level as Level] ?? 0));
  const fmt = (m: any): string => (m.unit === 'ratio' ? `${(Number(m.value) * 100).toFixed(1)}%` : String(m.value));
  const facts = bad.slice(0, 2).map((m) => ({ label: String(m.label ?? m.key), value: fmt(m) }));
  const okCount = dims.filter((d) => d.worst === 'ok' || d.ok === true).length;
  return { facts: [...facts, { label: '正常维度', value: `${okCount}/${dims.length}` }], headline: bad[0]?.why !== undefined ? String(bad[0].why) : '各项均正常' };
}

// ───────────────────────────────────────────── 数据装配

interface Deps { pool: pg.Pool; registry: any; metrics: any }
type Row = Record<string, any>;

async function bucketed(pool: pg.Pool, nodeId: string, metrics: string[], hours: number, bucketSec: number): Promise<{ avg: Map<string, Pt[]>; max: Map<string, Pt[]> }> {
  const r = await pool.query(
    `SELECT metric, floor(extract(epoch FROM time) / $3) * $3 AS bucket, avg(value) AS a, max(value) AS m
       FROM opendb_metrics WHERE node_id = $1 AND metric = ANY($2) AND time > now() - ($4 || ' hours')::interval
      GROUP BY metric, bucket ORDER BY bucket`,
    [nodeId, metrics, bucketSec, String(hours)]);
  const avg = new Map<string, Pt[]>(); const max = new Map<string, Pt[]>();
  for (const row of r.rows as Row[]) {
    const t = Number(row.bucket) * 1000;
    avg.set(row.metric, [...(avg.get(row.metric) ?? []), [t, Number(row.a)]]);
    max.set(row.metric, [...(max.get(row.metric) ?? []), [t, Number(row.m)]]);
  }
  return { avg, max };
}

const last = (s: Pt[]): number | null => (s.length > 0 ? s[s.length - 1][1] : null);
const GAUGES = ['db.sessions.active', 'db.sessions.idle', 'db.waiting_locks', 'db.connections_used_ratio', 'db.os.load', 'db.os.num_cpus', 'db.os.physical_memory_bytes', 'db.mem.process_used_memory', 'db.mem.max_process_memory'];
const COUNTERS = ['db.xact_commit', 'db.xact_rollback', 'db.stmt_calls', 'db.stmt_elapse_us', 'db.blks_hit', 'db.blks_read', 'db.os.busy_time', 'db.os.idle_time', 'db.os.iowait_time', 'db.os.user_time', 'db.os.sys_time'];

function buildKpis(avg: Map<string, Pt[]>, max: Map<string, Pt[]>): { kpis: Kpi[]; os: Kpi[] } {
  const g = (m: string): Pt[] => avg.get(m) ?? [];
  const c = (m: string): Pt[] => max.get(m) ?? [];
  const kpi = (key: string, label: string, unit: Unit, series: Pt[], level: Level, note: string, available = true): Kpi =>
    ({ key, label, unit, value: available ? last(series) : null, series, level, note, available });
  const tps = rateSeries(c('db.xact_commit')); const rollback = rateSeries(c('db.xact_rollback'));
  const qps = rateSeries(c('db.stmt_calls'));
  const avgMs = divideSeries(rateSeries(c('db.stmt_elapse_us')), qps).map(([t, v]) => [t, v / 1000] as Pt);
  const hit = ratioSeries(c('db.blks_hit'), c('db.blks_read'));
  const physReads = rateSeries(c('db.blks_read'));
  const conn = g('db.connections_used_ratio'); const locks = g('db.waiting_locks');
  const rbRate = last(rollback); const tpsLast = last(tps);
  const kpis: Kpi[] = [
    kpi('sessions_active', '活跃会话', 'count', g('db.sessions.active'), 'ok', `空闲 ${last(g('db.sessions.idle')) ?? '—'}`),
    kpi('waiting_locks', '等待锁', 'count', locks, levelBy(last(locks), THRESH.waitingLocks), last(locks) === 0 ? '当前无锁等待' : '阈值：≥1 关注 · ≥5 告警'),
    kpi('conn_used', '连接使用率', 'ratio', conn, levelBy(last(conn), THRESH.connUsed), '阈值：≥60% 关注 · ≥80% 告警'),
    kpi('tps', '每秒事务', 'per_s', tps, 'ok', `回滚 ${rbRate === null ? '—' : rbRate.toFixed(2)}/s${tpsLast !== null && tpsLast > 0 && rbRate !== null ? ` · 回滚率 ${((rbRate / (tpsLast + rbRate)) * 100).toFixed(1)}%` : ''}`),
    kpi('qps', '每秒语句', 'per_s', qps, 'ok', '来自 dbe_perf.statement 调用计数差分'),
    kpi('stmt_ms', '平均语句耗时', 'ms', avgMs, 'ok', 'Δelapse_us / Δcalls'),
    kpi('cache_hit', '缓存命中率', 'ratio', hit, levelBy(last(hit), THRESH.cacheHit, '<'), '阈值：<99% 关注 · <95% 告警'),
    kpi('phys_reads', '物理读 / 秒', 'per_s', physReads, 'ok', 'blks_read 差分'),
  ];
  // OS 层
  const busy = rateSeries(c('db.os.busy_time')); const idle = rateSeries(c('db.os.idle_time')); const iow = rateSeries(c('db.os.iowait_time'));
  const cpuBusy = ratioSeries(c('db.os.busy_time'), c('db.os.idle_time'));
  const ioShare = ratioSeries(c('db.os.iowait_time'), c('db.os.busy_time'));
  const ncpu = last(g('db.os.num_cpus')) ?? 0;
  const loadPerCore = ncpu > 0 ? g('db.os.load').map(([t, v]) => [t, v / ncpu] as Pt) : [];
  const memUsed = g('db.mem.process_used_memory'); const memMax = last(g('db.mem.max_process_memory'));
  const memRatio = memMax !== null && memMax > 0 ? memUsed.map(([t, v]) => [t, v / memMax] as Pt) : [];
  const userShare = last(ratioSeries(c('db.os.user_time'), c('db.os.idle_time'))); const sysShare = last(ratioSeries(c('db.os.sys_time'), c('db.os.idle_time')));
  const os: Kpi[] = [
    kpi('cpu_busy', 'CPU 忙', 'ratio', cpuBusy, 'ok', `用户 ${userShare === null ? '—' : (userShare * 100).toFixed(1)}% · 系统 ${sysShare === null ? '—' : (sysShare * 100).toFixed(1)}%（Δbusy / (Δbusy + Δidle)）`, busy.length > 0 && idle.length > 0),
    kpi('load_per_core', '每核负载', 'x', loadPerCore, levelBy(last(loadPerCore), THRESH.loadPerCore), `负载 ${last(g('db.os.load'))?.toFixed(1) ?? '—'} / ${ncpu || '—'} 核 · 阈值：≥1 关注 · ≥2 告警`, loadPerCore.length > 0),
    kpi('mem_process', '内存（数据库进程）', 'ratio', memRatio, 'ok', memMax !== null ? `已用 ${fmtGB(last(memUsed) ?? 0)} / 上限 ${fmtGB(memMax)}` : `待补采集：gs_total_memory_detail · 物理内存 ${last(g('db.os.physical_memory_bytes')) !== null ? fmtGB(last(g('db.os.physical_memory_bytes')) as number) : '—'}`, memRatio.length > 0),
    kpi('io_wait', 'IO 等待占比', 'ratio', ioShare, levelBy(last(ioShare), THRESH.iowaitShare), `Δiowait / (Δiowait + Δbusy) · 物理读 ${last(physReads)?.toFixed(1) ?? '—'} blk/s`, iow.length > 0),
  ];
  return { kpis, os };
}

async function dbTimeParts(pool: pg.Pool, nodeId: string, windowMin: number): Promise<NodeDashboard['dbTime']> {
  const r = await pool.query(
    `SELECT metric, max(value) - min(value) AS d FROM opendb_metrics
      WHERE node_id = $1 AND (metric LIKE 'db.instance_time.%' OR metric LIKE 'db.wait_by_type.%') AND time > now() - ($2 || ' minutes')::interval
      GROUP BY metric`, [nodeId, String(windowMin)]);
  const d = new Map<string, number>((r.rows as Row[]).map((row) => [row.metric, Math.max(0, Number(row.d))]));
  const total = d.get('db.instance_time.db_time') ?? 0;
  const named: [string, string][] = [['execution_time', '执行'], ['plan_time', '计划'], ['parse_time', '解析'], ['rewrite_time', '改写'], ['pl_execution_time', 'PL/SQL 执行'], ['pl_compilation_time', 'PL/SQL 编译'], ['net_send_time', '网络发送'], ['data_io_time', '数据 IO']];
  const parts = total > 0 ? named.map(([k, name]) => ({ name, share: (d.get(`db.instance_time.${k}`) ?? 0) / total })).filter((p) => p.share > 0.0005) : [];
  const cpu = total > 0 ? (d.get('db.instance_time.cpu_time') ?? 0) / total : 0;
  const waitTotal = [...d.entries()].filter(([k]) => k.startsWith('db.wait_by_type.')).reduce((s, [, v]) => s + v, 0);
  const waits = waitTotal > 0 ? [...d.entries()].filter(([k]) => k.startsWith('db.wait_by_type.')).map(([k, v]) => ({ name: k.replace('db.wait_by_type.', ''), share: v / waitTotal })).sort((a, b) => b.share - a.share) : [];
  return { parts: cpu > 0 ? [...parts, { name: '（其中 CPU）', share: cpu }] : parts, waits, windowMin };
}

async function nodeTasks(pool: pg.Pool, nodeName: string, now: Date): Promise<TaskRow[]> {
  const r = await pool.query(
    `SELECT t.id, t.name, t.type, coalesce(t.cron, '') AS cron, t.enabled, t.created_at,
            (SELECT max(fired_at) FROM dsh_task_runs ru WHERE ru.task_id = t.id) AS last_fired,
            (SELECT severity FROM dsh_task_reports rp WHERE rp.task_id = t.id ORDER BY created_at DESC LIMIT 1) AS last_level,
            (SELECT summary FROM dsh_task_reports rp WHERE rp.task_id = t.id ORDER BY created_at DESC LIMIT 1) AS last_summary
       FROM dsh_tasks t
      WHERE t.config->>'node' = $1 OR $1 = ANY(ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(t.config->'nodes') = 'array' THEN t.config->'nodes' ELSE '[]'::jsonb END)))
      ORDER BY t.enabled DESC, last_fired DESC NULLS LAST`, [nodeName]);
  return (r.rows as Row[]).map((row) => ({
    id: String(row.id), name: String(row.name), type: String(row.type), cron: String(row.cron), enabled: Boolean(row.enabled),
    lastFiredAt: row.last_fired ? new Date(row.last_fired).toISOString() : null,
    lastLevel: row.last_level ?? null, lastSummary: headlineOf(String(row.last_summary ?? '')),
    overdueDays: row.enabled && String(row.cron) !== '' ? overdueDays(String(row.cron), row.last_fired ? new Date(row.last_fired) : null, new Date(row.created_at), now) : null,
  }));
}

async function verdictFor(pool: pg.Pool, nodeName: string, type: string, title: string, tasks: TaskRow[], now: Date): Promise<Verdict> {
  const sched = tasks.find((t) => t.type === type && t.enabled && t.cron !== '');
  const schedule: Verdict['schedule'] = sched !== undefined ? { mode: 'cron', cron: sched.cron, ...(sched.overdueDays !== null ? { overdueDays: sched.overdueDays } : {}) } : { mode: 'manual' };
  const base: Verdict = { type, title, level: null, at: null, stale: false, staleReason: '', headline: '还没跑过 · 在会话里说一句就能建', facts: [], schedule };
  let worst: string | null = null; let at: Date | null = null; let sessionId: string | undefined; let facts: Verdict['facts'] = []; let headline = '';
  if (type === 'health') {
    const r = await pool.query(
      `SELECT h.worst, h.collected_at, h.session_id, n AS entry FROM opendb_health_collects h, jsonb_array_elements(h.payload->'nodes') n
        WHERE n->>'node' = $1 ORDER BY h.collected_at DESC LIMIT 1`, [nodeName]);
    const row = (r.rows as Row[])[0]; if (row === undefined) return base;
    worst = String(row.entry?.worst ?? row.worst); at = new Date(row.collected_at); sessionId = row.session_id;
    const hf = healthFacts(row.entry); facts = hf.facts; headline = hf.headline;
  } else {
    const r = await pool.query(`SELECT worst, collected_at, session_id, payload FROM opendb_task_collects WHERE node = $1 AND task_type = $2 ORDER BY collected_at DESC LIMIT 1`, [nodeName, type]);
    const row = (r.rows as Row[])[0]; if (row === undefined) return base;
    worst = String(row.worst); at = new Date(row.collected_at); sessionId = row.session_id; facts = factsFor(type, row.payload);
    const f0 = Array.isArray(row.payload?.findings) ? row.payload.findings[0] : Array.isArray(row.payload?.ruleFindings) ? row.payload.ruleFindings[0] : undefined;
    headline = f0 !== undefined ? headlineOf(String(f0.problem ?? f0.text ?? '')) : '';
  }
  // 模型报告的一句话优先（同一会话的 run → report）
  if (sessionId !== undefined) {
    const rp = await pool.query(`SELECT r.summary FROM dsh_task_reports r JOIN dsh_task_runs ru ON ru.id = r.run_id WHERE ru.session_id = $1 ORDER BY r.created_at DESC LIMIT 1`, [sessionId]);
    const s = (rp.rows as Row[])[0]?.summary; if (typeof s === 'string' && s.trim() !== '') headline = headlineOf(s);
  }
  const level = (['ok', 'notice', 'warn', 'critical'].includes(worst ?? '') ? worst : 'ok') as Level;
  const ageMs = at !== null ? now.getTime() - at.getTime() : 0;
  const period = schedule.mode === 'cron' && schedule.cron !== undefined ? cronPeriodMs(schedule.cron, now) : undefined;
  const staleAfter = period !== undefined ? period * 2 : MANUAL_STALE_MS;
  const stale = ageMs > staleAfter;
  return { ...base, level, at: at?.toISOString() ?? null, stale, staleReason: stale ? `已过期 ${Math.max(1, Math.floor(ageMs / 86_400_000))} 天` : '', headline: headline !== '' ? headline : base.headline, facts, sessionId, taskId: sched?.id };
}

async function storageOf(pool: pg.Pool, nodeId: string, nodeName: string, latestSizes: { metric: string; value: number }[]): Promise<NodeDashboard['storage']> {
  const dbs = latestSizes.filter((m) => m.metric.startsWith('db.size_bytes.')).map((m) => ({ name: m.metric.replace('db.size_bytes.', ''), bytes: Number(m.value) })).sort((a, b) => b.bytes - a.bytes);
  const g = await pool.query(
    `SELECT d, sum(bytes) AS b FROM (
       SELECT DISTINCT ON (name, collected_at::date) name, collected_at::date AS d, bytes FROM opendb_capacity_samples
        WHERE node = $1 AND kind = 'db' AND collected_at > now() - interval '30 days' ORDER BY name, collected_at::date, collected_at DESC) x
      GROUP BY d ORDER BY d`, [nodeName]);
  const growth: Pt[] = (g.rows as Row[]).map((row) => [new Date(row.d).getTime(), Number(row.b)]);
  const cap = await pool.query(`SELECT payload->'summary' AS s FROM opendb_task_collects WHERE node = $1 AND task_type = 'capacity' ORDER BY collected_at DESC LIMIT 1`, [nodeName]);
  const s = (cap.rows as Row[])[0]?.s ?? {};
  const bpd = typeof s?.growth?.bytesPerDay === 'number' ? s.growth.bytesPerDay : null;
  const note = s?.growth?.segment === 'post-reset' && typeof s?.growth?.resetAt === 'number'
    ? `${new Date(s.growth.resetAt).toISOString().slice(5, 10)} 清理悬崖后按 ${s.growth.windowHours ?? '?'} 小时窗口计`
    : typeof s?.growth?.windowHours === 'number' ? `按 ${s.growth.windowHours} 小时窗口计` : '';
  void nodeId;
  return { dbs, nonTableBytes: typeof s?.nonTableBytes === 'number' ? s.nonTableBytes : null, growth, bytesPerDay: bpd, growthNote: note };
}

async function timelineOf(pool: pg.Pool, nodeId: string): Promise<Batch[]> {
  const r = await pool.query(
    `SELECT to_char(date_trunc('minute', time), 'YYYY-MM-DD HH24:MI') AS m, sch, change, kind, count(*)::int AS c,
            (array_agg(name ORDER BY name))[1:6] AS names
       FROM opendb_dict_changes WHERE node_id = $1 AND time > now() - ($2 || ' days')::interval
      GROUP BY 1, 2, 3, 4 ORDER BY 1 DESC LIMIT 300`, [nodeId, String(TIMELINE_DAYS)]);
  return groupBatches((r.rows as Row[]).map((row) => ({ m: String(row.m), sch: String(row.sch ?? ''), change: String(row.change), kind: String(row.kind), c: Number(row.c), names: Array.isArray(row.names) ? row.names.map(String) : [] })));
}

async function knowledgeOf(pool: pg.Pool, nodeName: string): Promise<NodeDashboard['knowledge']> {
  const r = await pool.query(
    `SELECT (SELECT count(*) FROM opendb_memories WHERE content ILIKE '%' || $1 || '%') AS mem,
            (SELECT count(*) FROM opendb_knowledge_docs) AS docs,
            (SELECT count(*) FROM opendb_kg_edges e JOIN opendb_kg_nodes s ON s.id = e.src_id JOIN opendb_kg_nodes d ON d.id = e.dst_id
              WHERE s.name ILIKE '%' || $1 || '%' OR d.name ILIKE '%' || $1 || '%') AS kg`, [nodeName]);
  const row = (r.rows as Row[])[0] ?? {};
  return { memories: Number(row.mem ?? 0), docs: Number(row.docs ?? 0), kgEdges: Number(row.kg ?? 0) };
}

/** 一次装配整页。hours = 24 | 168。 */
export async function buildNodeDashboard(deps: Deps, nodeId: string, hours = 24): Promise<NodeDashboard | undefined> {
  const nodes = await deps.registry.listNodes();
  const node = nodes.find((n: any) => n.id === nodeId);
  if (node === undefined) return undefined;
  const now = new Date();
  const h = hours >= 168 ? 168 : 24;
  const bucketSec = h >= 168 ? 7200 : 900;
  const agents = await deps.registry.listAgents().catch(() => [] as any[]);
  const agentName = agents.find((a: any) => a.id === node.agentId)?.name ?? node.agentId ?? '';
  const [latest, range, span, tasks] = await Promise.all([
    deps.metrics.latest(node.id),
    bucketed(deps.pool, node.id, [...GAUGES, ...COUNTERS], h, bucketSec),
    deps.pool.query(`SELECT min(time) AS first, max(time) AS last FROM opendb_metrics WHERE node_id = $1`, [node.id]),
    nodeTasks(deps.pool, node.name, now),
  ]);
  const { kpis, os } = buildKpis(range.avg, range.max);
  const [dbTime, verdicts, storage, timeline, knowledge] = await Promise.all([
    dbTimeParts(deps.pool, node.id, 60),
    Promise.all(VERDICT_TYPES.map((v) => verdictFor(deps.pool, node.name, v.type, v.title, tasks, now))),
    storageOf(deps.pool, node.id, node.name, latest),
    timelineOf(deps.pool, node.id),
    knowledgeOf(deps.pool, node.name),
  ]);
  const live = verdicts.filter((v) => v.level !== null && !v.stale);
  const compositeLevel = worstOf(live.map((v) => v.level));
  const worstNames = live.filter((v) => v.level === compositeLevel).map((v) => v.title);
  const staleNames = verdicts.filter((v) => v.stale && v.level !== null).map((v) => `${v.title}（${v.level === 'critical' ? '严重' : v.level === 'warn' ? '告警' : v.level === 'notice' ? '注意' : '正常'}，${v.staleReason}）`);
  const why = live.length === 0 ? '五类巡检都还没有有效结论' : `五类巡检最近结论中最差的一档（${worstNames.join(' / ')}）${staleNames.length > 0 ? `；过期不进综合：${staleNames.join('、')}` : ''}`;
  const first = (span.rows as Row[])[0]?.first; const lastAt = (span.rows as Row[])[0]?.last;
  return {
    node: { ...node, agentName, firstSeenAt: first ? new Date(first).toISOString() : null, lastSampleAt: lastAt ? new Date(lastAt).toISOString() : null },
    range: { hours: h, bucketSec }, kpis, os, dbTime, verdicts, composite: { level: compositeLevel, why }, storage, timeline, tasks, knowledge,
  };
}
