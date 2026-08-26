/**
 * 每维「关键指标」与「可绘图数据」（user 2026-08-26：十二维要有数、有解释、有阈值；发现要能画图）。
 *
 * 不碰采集器的 SQL / 规则 / 阈值 / 判定：只把各维已经算出来并放在 evidence 里的数字，
 * 整理成带含义、单位、当前生效阈值档位与落档的结构化 measures，以及柱/饼/水位可直接消费的 charts。
 * 一切数字来自采集器本身（确定性），面板直读，不经模型转述。
 */
import { THRESHOLD_META, type DetLevel, type DimResult, type Thresholds } from './collectors.ts';

export type MeasureUnit = 'ratio' | 'count' | 'ms' | 's' | 'bytes' | 'x' | 'text';

/** 一个关键指标：值 + 含义 + 判级依据（阈值档位与比较方向）+ 实际落档 */
export interface Measure {
  key: string;
  label: string;
  value: number | string;
  unit: MeasureUnit;
  /** 这个数是什么（一句话，来自阈值元数据或维度说明） */
  desc: string;
  /** 判级依据：生效阈值各档（可被平台阈值覆盖）与比较方向；无阈值的纯观测指标为 undefined */
  rule?: { cmp: '>=' | '<'; tiers: Partial<Record<Exclude<DetLevel, 'ok'>, number>>; thresholdKey: string };
  /** 按规则落档；纯观测指标恒为 ok */
  level: DetLevel;
  /** 为什么是这一级（含实测与命中的那一档） */
  why: string;
}

/** 可绘图数据：分布用柱/饼，占比用水位 */
export interface DimChart {
  key: string;
  label: string;
  kind: 'bar' | 'pie' | 'gauge';
  unit: MeasureUnit;
  items: { name: string; value: number }[];
  /** gauge：阈值刻度（ratio 0-1 内） */
  tiers?: Partial<Record<Exclude<DetLevel, 'ok'>, number>>;
  cmp?: '>=' | '<';
}

export interface DimEnrichment { measures: Measure[]; charts: DimChart[] }

const LEVELS: Exclude<DetLevel, 'ok'>[] = ['critical', 'warn', 'notice'];
const CN: Record<DetLevel, string> = { ok: '正常', notice: '关注', warn: '告警', critical: '严重' };

const n = (v: unknown): number => (v === null || v === undefined || Number.isNaN(Number(v)) ? 0 : Number(v));
const r2 = (v: number): number => Math.round(v * 100) / 100;
const r4 = (v: number): number => Math.round(v * 10000) / 10000;

function tiersOf(T: Thresholds, key: keyof Thresholds): Partial<Record<Exclude<DetLevel, 'ok'>, number>> {
  const v = T[key] as unknown;
  if (typeof v === 'number') return {};
  const out: Partial<Record<Exclude<DetLevel, 'ok'>, number>> = {};
  for (const l of LEVELS) { const t = (v as Record<string, number | undefined>)[l]; if (typeof t === 'number') out[l] = t; }
  return out;
}

function fmt(v: number, unit: MeasureUnit): string {
  if (unit === 'ratio') return `${(v * 100).toFixed(v * 100 >= 10 ? 0 : 1)}%`;
  if (unit === 'ms') return `${v.toFixed(0)}ms`;
  if (unit === 's') return v >= 3600 ? `${(v / 3600).toFixed(1)}h` : v >= 60 ? `${Math.floor(v / 60)}m${v % 60}s` : `${v}s`;
  if (unit === 'bytes') return v >= 1 << 30 ? `${(v / (1 << 30)).toFixed(1)}GB` : v >= 1 << 20 ? `${(v / (1 << 20)).toFixed(0)}MB` : `${v}B`;
  if (unit === 'x') return `${v.toFixed(2)}x`;
  return String(v);
}

/** 用某个阈值键给一个数判级（与采集器判定同方向、同档位；这里只是复述，不产生新发现） */
function judged(key: keyof Thresholds, value: number, T: Thresholds, label?: string, desc?: string): Measure {
  const meta = THRESHOLD_META[key as keyof typeof THRESHOLD_META];
  const tiers = tiersOf(T, key);
  const cmp = meta.cmp;
  let level: DetLevel = 'ok'; let hit: number | undefined;
  for (const l of LEVELS) {
    const t = tiers[l];
    if (t === undefined) continue;
    if ((cmp === '>=' && value >= t) || (cmp === '<' && value < t)) { level = l; hit = t; break; }
  }
  const unit = meta.unit as MeasureUnit;
  const ladder = LEVELS.filter((l) => tiers[l] !== undefined).reverse().map((l) => `${CN[l]} ${cmp}${fmt(tiers[l] as number, unit)}`).join(' → ');
  const why = level === 'ok'
    ? `实测 ${fmt(value, unit)}，未触及任何一档（${ladder || '无阈值'}）`
    : `实测 ${fmt(value, unit)} ${cmp} ${fmt(hit as number, unit)}，落在「${CN[level]}」档（阶梯：${ladder}）`;
  return { key: String(key), label: label ?? meta.label, value: unit === 'ratio' ? r4(value) : r2(value), unit, desc: desc ?? meta.desc, rule: { cmp, tiers, thresholdKey: String(key) }, level, why };
}

/** 纯观测指标（无阈值，不判级） */
function observed(key: string, label: string, value: number | string, unit: MeasureUnit, desc: string): Measure {
  return { key, label, value: typeof value === 'number' ? (unit === 'ratio' ? r4(value) : r2(value)) : value, unit, desc, level: 'ok', why: '观测值，不参与判级' };
}

const gauge = (key: string, label: string, value: number, T: Thresholds, tkey: keyof Thresholds): DimChart => ({
  key, label, kind: 'gauge', unit: 'ratio', items: [{ name: label, value: r4(value) }], tiers: tiersOf(T, tkey), cmp: THRESHOLD_META[tkey as keyof typeof THRESHOLD_META].cmp,
});

/** 由各维 evidence 派生 measures / charts；未知维度返回空（新维度按需在此登记） */
export function enrichDim(result: DimResult, T: Thresholds): DimEnrichment {
  const ev = (result.evidence ?? {}) as Record<string, any>;
  const M: Measure[] = []; const C: DimChart[] = [];
  const findings = result.findings;
  switch (result.dim) {
    case 'overview': {
      if (typeof ev.cacheHitRatio === 'number') { M.push(judged('cacheHit', ev.cacheHitRatio, T)); C.push(gauge('cache_hit', '缓存命中率', ev.cacheHitRatio, T, 'cacheHit')); }
      const dbs: { db: string; bytes: number }[] = Array.isArray(ev.dbBytes) ? ev.dbBytes : [];
      if (dbs.length > 0) {
        M.push(observed('db_total_bytes', '数据库总大小', dbs.reduce((s, d) => s + n(d.bytes), 0), 'bytes', '所有非模板库 pg_database_size 之和'));
        C.push({ key: 'db_bytes', label: '各库大小', kind: 'pie', unit: 'bytes', items: dbs.slice(0, 6).map((d) => ({ name: String(d.db), value: n(d.bytes) })) });
      }
      if (typeof ev.version === 'string' && ev.version !== '') {
        // "(openGauss-lite 5.0.3 build 3a7b…) compiled at …" → "openGauss-lite 5.0.3"；PG 的 "PostgreSQL 16.4 on …" → "PostgreSQL 16.4"
        const short = String(ev.version).match(/\(?([A-Za-z][\w-]*(?:\s+[\w-]+)?\s+\d+(?:\.\d+)*)/)?.[1] ?? String(ev.version).slice(0, 40);
        M.push(observed('version', '版本', short, 'text', 'SELECT version()'));
      }
      break;
    }
    case 'waits': {
      const top: { event: string; totalWait: number }[] = Array.isArray(ev.top) ? ev.top : [];
      const total = top.reduce((s, t) => s + n(t.totalWait), 0);
      if (top.length > 0 && total > 0) {
        M.push(judged('waitTopShare', n(top[0].totalWait) / total, T, undefined, `Top1 等待事件 ${top[0].event} 占真实等待（已排除 STATUS 类）的比例`));
        M.push(observed('top_wait_event', 'Top1 等待事件', String(top[0].event), 'text', 'dbe_perf.wait_events 累计等待时间最长的事件'));
        C.push({ key: 'wait_top', label: '等待事件分布（Top5）', kind: 'pie', unit: 'count', items: top.slice(0, 5).map((t) => ({ name: String(t.event), value: n(t.totalWait) })) });
      } else {
        M.push(observed('top_wait_event', '真实等待', '无', 'text', '排除 STATUS 类后没有累计等待'));
      }
      break;
    }
    case 'slowsql': {
      const top: { q: string; calls: number; avgMs: number }[] = Array.isArray(ev.top) ? ev.top : [];
      const worst = top.filter((t) => n(t.avgMs) >= T.slowAvgMs.warn).length;
      M.push({ ...judged('slowManyCount', worst, T, '均耗时超告警线的 SQL 条数', `dbe_perf.statement 中平均耗时 ≥ ${T.slowAvgMs.warn}ms 的 SQL 条数`), unit: 'count' });
      M.push(observed('slow_over_notice', `均耗时超 ${T.slowAvgMs.notice}ms 的 SQL 条数`, top.length, 'count', '按平均耗时筛出的慢 SQL 数量'));
      if (top.length > 0) {
        // 采集器按总耗时排序；这里按均耗时重排，"最慢"取均耗时最大值（2026-08-26 截图核对时发现取了第一条 2.79s 而实际有 15s）
        const byAvg = [...top].sort((a, b) => n(b.avgMs) - n(a.avgMs));
        M.push(judged('slowAvgMs', n(byAvg[0].avgMs), T, '最慢 SQL 均耗时', '平均耗时最高的一条 SQL'));
        C.push({ key: 'slow_top', label: '慢 SQL 均耗时 Top5', kind: 'bar', unit: 'ms', items: byAvg.slice(0, 5).map((t) => ({ name: String(t.q).slice(0, 48), value: r2(n(t.avgMs)) })) });
      }
      break;
    }
    case 'xact': {
      const secs = findings.map((f) => n(f.value));
      const longest = secs.length > 0 ? Math.max(...secs) : 0;
      M.push(judged('xactSec', longest, T, '最长事务时长', `当前持续最久的事务（含空闲事务）已运行的秒数；阈值起点 ${T.xactSec.notice}s 以下不列出`));
      M.push(observed('long_xact_count', `超过 ${T.xactSec.notice}s 的事务数`, n(ev.count), 'count', 'pg_stat_activity 中 xact_start 早于阈值起点的事务'));
      if (findings.length > 0) C.push({ key: 'xact_top', label: '长事务时长 Top5（秒）', kind: 'bar', unit: 's', items: findings.slice(0, 5).map((f) => ({ name: f.detail.split('（')[0].slice(0, 40), value: n(f.value) })) });
      break;
    }
    case 'bloat': {
      const top: { t: string; dead: number; live: number }[] = Array.isArray(ev.top) ? ev.top : [];
      const worst = top.length > 0 ? Math.max(...top.map((t) => (n(t.live) > 0 ? n(t.dead) / n(t.live) : 0))) : 0;
      M.push(judged('bloatRatio', worst, T, '最高死元组膨胀率', `只看活元组 > ${T.bloatMinLive} 的表；n_dead_tup / n_live_tup 的最大值`));
      M.push(observed('bloat_tables_over_notice', `膨胀率 ≥ ${(T.bloatRatio.notice * 100).toFixed(0)}% 的表数`, findings.length, 'count', '命中关注线及以上的表'));
      if (top.length > 0) C.push({ key: 'bloat_top', label: '死元组膨胀率 Top5', kind: 'bar', unit: 'ratio', items: top.slice(0, 5).map((t) => ({ name: String(t.t), value: r4(n(t.live) > 0 ? n(t.dead) / n(t.live) : 0) })) });
      break;
    }
    case 'lwlock': {
      if (typeof ev.lwlockShare === 'number') { M.push(judged('lwlockShare', ev.lwlockShare, T)); C.push(gauge('lwlock_share', 'LWLock 争用占比', ev.lwlockShare, T, 'lwlockShare')); }
      break;
    }
    case 'lockchain': {
      M.push(judged('blockedSessions', n(ev.blocked), T));
      const edges: { waiter: number; holder: number; waitSec: number }[] = Array.isArray(ev.edges) ? ev.edges : [];
      if (edges.length > 0) {
        M.push(observed('max_lock_wait', '最长等锁时间', Math.max(...edges.map((e) => n(e.waitSec))), 's', '等待者 query_start 至今'));
        C.push({ key: 'lock_wait', label: '等锁时长（按等待会话）', kind: 'bar', unit: 's', items: edges.slice(0, 5).map((e) => ({ name: `pid ${e.waiter} ← ${e.holder}`, value: n(e.waitSec) })) });
      }
      break;
    }
    case 'connections': {
      M.push(judged('connRatio', n(ev.ratio), T, undefined, `当前连接 ${n(ev.used)} / max_connections ${n(ev.max)}`));
      M.push(observed('conn_used', '当前连接数', n(ev.used), 'count', 'pg_stat_activity 行数'));
      M.push(observed('conn_max', 'max_connections', n(ev.max), 'count', '实例连接上限参数'));
      C.push(gauge('conn_ratio', '连接占用', n(ev.ratio), T, 'connRatio'));
      const states = ev.states as Record<string, number> | undefined;
      if (states !== undefined && Object.keys(states).length > 0) {
        C.push({ key: 'conn_states', label: '连接状态分布', kind: 'pie', unit: 'count', items: Object.entries(states).map(([k, v]) => ({ name: k || '(unknown)', value: n(v) })) });
      }
      break;
    }
    case 'ckpt': {
      const timed = n(ev.timed); const req = n(ev.req);
      const share = timed + req > 0 ? req / (timed + req) : 0;
      M.push(judged('ckptReqShare', share, T, undefined, `checkpoints_req ${req} / (timed ${timed} + req ${req})——被动 checkpoint 多 = WAL 写入压力大或 checkpoint 参数偏小`));
      C.push({ key: 'ckpt_split', label: 'checkpoint 触发方式', kind: 'pie', unit: 'count', items: [{ name: '定时 timed', value: timed }, { name: '被动 req', value: req }] });
      break;
    }
    case 'replication': {
      const standbys: { addr: string; state: string; sync: string }[] = Array.isArray(ev.standbys) ? ev.standbys : [];
      M.push(observed('standby_count', '备机数', standbys.length, 'count', 'pg_stat_replication 行数（0 = 单机或本节点是备机）'));
      M.push({ ...observed('standby_bad', '非 streaming 备机数', standbys.filter((s) => String(s.state).toLowerCase() !== 'streaming').length, 'count', 'state <> streaming 即复制异常'), level: findings.some((f) => f.code === 'REPL_BROKEN') ? 'critical' : 'ok', why: findings.some((f) => f.code === 'REPL_BROKEN') ? '存在 state<>streaming 的备机（规则 REPL_BROKEN，命中即严重）' : '所有备机均为 streaming' });
      break;
    }
    case 'objects': {
      const inv = findings.find((f) => f.code === 'IDX_INVALID');
      M.push({ ...observed('invalid_indexes', '失效索引数', n(ev.invalid), 'count', 'pg_index.indisvalid = false'), level: inv !== undefined ? 'warn' : 'ok', why: inv !== undefined ? `${n(ev.invalid)} > 0，规则 IDX_INVALID 命中即告警` : '0 个失效索引' });
      const unused: string[] = Array.isArray(ev.unusedSample) ? ev.unusedSample : [];
      M.push({ ...observed('unused_indexes', '疑似无用索引数（样本上限 6）', unused.length, 'count', 'pg_stat_user_indexes.idx_scan = 0（自统计重置以来从未被扫描）'), level: unused.length > 0 ? 'notice' : 'ok', why: unused.length > 0 ? '有从未被扫描的索引，规则 IDX_UNUSED 命中即关注' : '所有索引都被扫描过' });
      break;
    }
    case 'concurrency': {
      M.push(judged('activeSessions', n(ev.active), T));
      M.push({ ...observed('prepared_xacts', '悬挂两阶段事务数', n(ev.prepared), 'count', 'pg_prepared_xacts 行数'), level: n(ev.prepared) > 0 ? 'notice' : 'ok', why: n(ev.prepared) > 0 ? '> 0，规则 XACT_PREPARED 命中即关注' : '无悬挂的两阶段事务' });
      break;
    }
    case 'os': {
      if (ev.note !== undefined) break;
      M.push(judged('loadPerCore', n(ev.loadPerCore), T, undefined, `LOAD ${n(ev.load)} / ${n(ev.cpus)} 核；1.0 = 所有核排满队`));
      M.push(judged('iowaitShare', n(ev.iowaitShare), T));
      M.push(observed('cpu_used_cumulative', 'CPU 使用率（自启动累计）', n(ev.cpuUsedRatioCumulative), 'ratio', 'BUSY/(BUSY+IDLE) 累计口径，瞬时曲线看趋势图'));
      if (n(ev.memoryBytes) > 0) M.push(observed('physical_memory', '物理内存', n(ev.memoryBytes), 'bytes', 'dbe_perf.os_runtime PHYSICAL_MEMORY_BYTES'));
      C.push(gauge('iowait_share', 'IOWait 占比', n(ev.iowaitShare), T, 'iowaitShare'));
      break;
    }
    default: break;
  }
  return { measures: M, charts: C };
}
