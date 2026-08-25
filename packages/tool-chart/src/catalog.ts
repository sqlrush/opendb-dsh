/**
 * 语义指标目录：把「客户关心的核心健康指标」映射到指标库里的原始键与计算方式。
 * 模型说 tps / qps / cpu / cache_hit 就行，不用记 db.xact_commit 这种原始名，也不用自己差分。
 * 未在目录里的键按原始 gauge 直接画（如 db.size_bytes.postgres）。
 */
import { rate, ratioDelta, divDelta, divPoint, type Pt } from './series.ts';

export type ChartUnit = 'ratio' | 'per_s' | 'count' | 'ms' | 'bytes' | 'x';

export interface MetricDef {
  key: string;
  label: string;
  unit: ChartUnit;
  /** 计算方式：gauge 直接画；rate 累计→每秒；ratio_delta Δa/(Δa+Δb)；div_delta Δa/Δb；div_point a/b */
  kind: 'gauge' | 'rate' | 'ratio_delta' | 'div_delta' | 'div_point';
  /** 需要拉取的原始指标（按 kind 的参数顺序） */
  raw: string[];
  /** 值的后处理（如 µs → ms） */
  scale?: number;
  /** 对应的平台阈值组（health 插件），画图时叠阈值线 */
  threshold?: { plugin: string; group: string };
  desc: string;
}

export const METRIC_CATALOG: readonly MetricDef[] = [
  { key: 'tps', label: 'TPS（事务/秒）', unit: 'per_s', kind: 'rate', raw: ['db.xact_commit'], desc: '提交事务数的每秒速率（Δxact_commit）' },
  { key: 'qps', label: 'QPS（语句/秒）', unit: 'per_s', kind: 'rate', raw: ['db.stmt_calls'], desc: 'SQL 调用数的每秒速率（Δn_calls）' },
  { key: 'rollback_rate', label: '回滚/秒', unit: 'per_s', kind: 'rate', raw: ['db.xact_rollback'], desc: 'Δxact_rollback' },
  { key: 'avg_latency_ms', label: '平均语句耗时', unit: 'ms', kind: 'div_delta', raw: ['db.stmt_elapse_us', 'db.stmt_calls'], scale: 1 / 1000, desc: 'Δ总耗时 / Δ调用次数' },
  { key: 'cpu', label: 'CPU 使用率', unit: 'ratio', kind: 'ratio_delta', raw: ['db.os.busy_time', 'db.os.idle_time'], desc: 'Δbusy / (Δbusy + Δidle)，主机级' },
  { key: 'io_wait', label: 'IOWait 占比', unit: 'ratio', kind: 'ratio_delta', raw: ['db.os.iowait_time', 'db.os.busy_time'], threshold: { plugin: 'health', group: 'iowaitShare' }, desc: 'Δiowait / (Δiowait + Δbusy)' },
  { key: 'cache_hit', label: '缓存命中率', unit: 'ratio', kind: 'ratio_delta', raw: ['db.blks_hit', 'db.blks_read'], threshold: { plugin: 'health', group: 'cacheHit' }, desc: 'Δblks_hit / (Δhit + Δread)，窗口内实时命中率' },
  { key: 'connections', label: '连接占用率', unit: 'ratio', kind: 'gauge', raw: ['db.connections_used_ratio'], threshold: { plugin: 'health', group: 'connRatio' }, desc: '当前连接数 / max_connections' },
  { key: 'active_sessions', label: '活跃会话', unit: 'count', kind: 'gauge', raw: ['db.sessions.active'], threshold: { plugin: 'health', group: 'activeSessions' }, desc: "state='active' 会话数" },
  { key: 'idle_sessions', label: '空闲会话', unit: 'count', kind: 'gauge', raw: ['db.sessions.idle'], desc: "state='idle' 会话数" },
  { key: 'idle_in_xact', label: '事务中空闲会话', unit: 'count', kind: 'gauge', raw: ['db.sessions.idle_in_transaction'], desc: 'idle in transaction 会话数' },
  { key: 'waiting_locks', label: '锁等待数', unit: 'count', kind: 'gauge', raw: ['db.waiting_locks'], desc: 'pg_locks 未授予锁' },
  { key: 'load', label: '主机负载', unit: 'x', kind: 'gauge', raw: ['db.os.load'], desc: 'OS load（1 分钟）' },
  { key: 'load_per_core', label: '每核负载', unit: 'x', kind: 'div_point', raw: ['db.os.load', 'db.os.num_cpus'], threshold: { plugin: 'health', group: 'loadPerCore' }, desc: 'load / CPU 核数，1.0 = 所有核排满' },
  { key: 'wait_lwlock', label: 'LWLock 等待/秒', unit: 'per_s', kind: 'rate', raw: ['db.wait_by_type.lwlock_event'], scale: 1 / 1_000_000, desc: '每秒新增 LWLock 等待时长（秒/秒）' },
  { key: 'wait_io', label: 'IO 等待/秒', unit: 'per_s', kind: 'rate', raw: ['db.wait_by_type.io_event'], scale: 1 / 1_000_000, desc: '每秒新增 IO 等待时长' },
  { key: 'wait_lock', label: '锁等待/秒', unit: 'per_s', kind: 'rate', raw: ['db.wait_by_type.lock_event'], scale: 1 / 1_000_000, desc: '每秒新增锁等待时长' },
];

const byKey = new Map(METRIC_CATALOG.map((m) => [m.key, m]));
/** 原始键 → 语义定义（仅单原始键的 gauge）：模型传 db.connections_used_ratio 也能拿到阈值映射与人读标签
 *（2026-08-24 e2e 实证：模型直接传了原始键，图上就没了阈值线） */
const byRaw = new Map(METRIC_CATALOG.filter((m) => m.kind === 'gauge' && m.raw.length === 1).map((m) => [m.raw[0], m]));

/** 解析用户/模型给的指标名：目录键、别名、或原始 db.* 键（按 gauge 直接画） */
export function resolveMetric(name: string): MetricDef {
  const k = name.trim().toLowerCase();
  const alias: Record<string, string> = {
    'cpu使用率': 'cpu', cpu_usage: 'cpu', cpu_ratio: 'cpu',
    conn: 'connections', connection: 'connections', 连接: 'connections', 连接占用: 'connections', 连接占用率: 'connections',
    hit: 'cache_hit', hit_ratio: 'cache_hit', 缓存命中率: 'cache_hit',
    active: 'active_sessions', sessions: 'active_sessions', 活跃会话: 'active_sessions',
    locks: 'waiting_locks', 锁等待: 'waiting_locks',
    latency: 'avg_latency_ms', 平均耗时: 'avg_latency_ms',
    iowait: 'io_wait',
  };
  const key = alias[k] ?? alias[name.trim()] ?? k;
  const def = byKey.get(key) ?? byRaw.get(name.trim());
  if (def !== undefined) return def;
  // 原始键：按 gauge 直接画；单位按名字猜一下
  const raw = name.trim();
  const unit: ChartUnit = /ratio|share/.test(raw) ? 'ratio' : /bytes/.test(raw) ? 'bytes' : /_time|elapse|_us$/.test(raw) ? 'ms' : 'count';
  return { key: raw, label: raw, unit, kind: 'gauge', raw: [raw], desc: '原始指标（gauge，未差分）' };
}

/** 按定义计算最终序列；fetched = 原始键 → 升序点列 */
export function compute(def: MetricDef, fetched: Record<string, Pt[]>): Pt[] {
  const a = fetched[def.raw[0]] ?? [];
  const b = fetched[def.raw[1]] ?? [];
  let out: Pt[];
  switch (def.kind) {
    case 'gauge': out = a; break;
    case 'rate': out = rate(a); break;
    case 'ratio_delta': out = ratioDelta(a, b); break;
    case 'div_delta': out = divDelta(a, b); break;
    case 'div_point': out = divPoint(a, b); break;
    default: out = a;
  }
  const s = def.scale;
  return s === undefined ? out : out.map(([t, v]) => [t, v * s]);
}

export function listCatalogMarkdown(): string {
  return METRIC_CATALOG.map((m) => `- \`${m.key}\`：${m.label}（${m.desc}）`).join('\n');
}
