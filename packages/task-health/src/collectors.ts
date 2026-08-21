/**
 * 12 维确定性健康采集器（opencode_skill health 方法论：确定性归脚本、判断归模型）。
 * 每个采集器：只读 SQL → 阈值比较 → Deterministic Findings（code/severity/metric/value/threshold/evidence）。
 * 采集失败 = Collection Note（该维不产任何结论，绝不臆测）。
 * SQL 以 openGauss（og-lite 5.x）为准，兼容 PostgreSQL 的部分自动降级。
 */

export type DetLevel = 'ok' | 'notice' | 'warn' | 'critical';

export interface DetFinding {
  dim: string;
  code: string;
  level: DetLevel;
  metric: string;
  value: number | string;
  threshold: string;
  evidence: string;
  detail: string;
}

export interface DimResult {
  dim: string;
  title: string;
  ok: boolean;           // 采集是否成功（不代表健康）
  findings: DetFinding[];
  note?: string;         // 采集降级说明（Collection Note）
  evidence?: Record<string, unknown>;   // 附加原始证据（cluster 层横向分析用）
}

export type QueryFn = (sql: string, maxRows?: number) => Promise<{ rows: Record<string, unknown>[] }>;

export const LEVEL_ORDER: Record<DetLevel, number> = { ok: 0, notice: 1, warn: 2, critical: 3 };
export function worstOf(levels: DetLevel[]): DetLevel {
  return levels.reduce<DetLevel>((acc, l) => (LEVEL_ORDER[l] > LEVEL_ORDER[acc] ? l : acc), 'ok');
}

/** 阈值一览（设计稿 §2；客户规范经知识库对照——参考不改判） */
export const THRESHOLDS = {
  connRatio: { warn: 0.8, critical: 0.9 },
  cacheHit: { notice: 0.99, warn: 0.95 },          // 低于
  xactSec: { notice: 300, warn: 1800, critical: 7200 },
  bloatRatio: { notice: 0.15, warn: 0.3 },
  bloatMinLive: 10000,
  slowAvgMs: { notice: 1000, warn: 3000 },
  slowManyCount: 3,
  blockedSessions: { warn: 1, critical: 5 },
  ckptReqShare: { notice: 0.3, warn: 0.5 },
  waitTopShare: { notice: 0.4 },
  lwlockShare: { notice: 0.2, warn: 0.4 },
  activeSessions: { notice: 50 },
} as const;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

function finding(partial: Omit<DetFinding, 'evidence'> & { evidence?: string }): DetFinding {
  return { evidence: '', ...partial };
}

// ── 1 总览（版本 / 库大小 / 缓存命中 / 关键参数证据）─────────────────────────
async function dimOverview(q: QueryFn): Promise<DimResult> {
  const dim = 'overview'; const title = '总览';
  const findings: DetFinding[] = [];
  const ver = await q('SELECT version()', 1);
  const cache = await q('SELECT coalesce(sum(blks_hit),0)::float8 AS hit, coalesce(sum(blks_read),0)::float8 AS read FROM pg_stat_database', 1);
  const sizes = await q('SELECT datname, pg_database_size(datname)::bigint AS bytes FROM pg_database WHERE NOT datistemplate ORDER BY 2 DESC', 8);
  const settings = await q(
    "SELECT name, setting, unit FROM pg_settings WHERE name IN ('max_connections','work_mem','shared_buffers','checkpoint_timeout','wal_keep_segments','autovacuum')", 10);
  const hit = num(cache.rows[0]?.hit); const read = num(cache.rows[0]?.read);
  const ratio = hit + read > 0 ? hit / (hit + read) : 1;
  if (ratio < THRESHOLDS.cacheHit.warn) {
    findings.push(finding({ dim, code: 'CACHE_LOW', level: 'warn', metric: 'cache_hit_ratio', value: Math.round(ratio * 10000) / 10000, threshold: `<${THRESHOLDS.cacheHit.warn}`, detail: `shared_buffers 命中率 ${(ratio * 100).toFixed(2)}%，物理读占比偏高`, evidence: `blks_hit=${hit} blks_read=${read}` }));
  } else if (ratio < THRESHOLDS.cacheHit.notice) {
    findings.push(finding({ dim, code: 'CACHE_LOW', level: 'notice', metric: 'cache_hit_ratio', value: Math.round(ratio * 10000) / 10000, threshold: `<${THRESHOLDS.cacheHit.notice}`, detail: `命中率 ${(ratio * 100).toFixed(2)}%，低于 99% 基线`, evidence: `blks_hit=${hit} blks_read=${read}` }));
  }
  return {
    dim, title, ok: true, findings,
    evidence: {
      version: str(ver.rows[0]?.version).slice(0, 120),
      cacheHitRatio: Math.round(ratio * 10000) / 10000,
      dbBytes: sizes.rows.map((r) => ({ db: str(r.datname), bytes: num(r.bytes) })),
      settings: Object.fromEntries(settings.rows.map((r) => [str(r.name), str(r.setting) + (str(r.unit) !== '' ? str(r.unit) : '')])),
    },
  };
}

// ── 2 等待事件（dbe_perf.wait_events；PG 无此视图则降级）───────────────────
async function dimWaits(q: QueryFn): Promise<DimResult> {
  const dim = 'waits'; const title = '等待事件';
  const rows = (await q('SELECT type, event, wait, total_wait_time FROM dbe_perf.wait_events WHERE total_wait_time > 0 ORDER BY total_wait_time DESC LIMIT 8', 8)).rows;
  const findings: DetFinding[] = [];
  const total = rows.reduce((s, r) => s + num(r.total_wait_time), 0);
  if (rows.length > 0 && total > 0) {
    const top = rows[0];
    const share = num(top.total_wait_time) / total;
    if (share >= THRESHOLDS.waitTopShare.notice) {
      findings.push(finding({ dim, code: 'WAIT_CONC', level: 'notice', metric: 'top_wait_share', value: Math.round(share * 100) / 100, threshold: `>=${THRESHOLDS.waitTopShare.notice}`, detail: `等待集中：${str(top.event)} 占 Top8 总等待 ${(share * 100).toFixed(0)}%`, evidence: rows.slice(0, 3).map((r) => `${str(r.event)}=${num(r.total_wait_time)}`).join(' ') }));
    }
  }
  return { dim, title, ok: true, findings, evidence: { top: rows.slice(0, 5).map((r) => ({ type: str(r.type), event: str(r.event), totalWait: num(r.total_wait_time) })) } };
}

// ── 3 慢 SQL（dbe_perf.statement 按均耗时）──────────────────────────────────
async function dimSlowSql(q: QueryFn): Promise<DimResult> {
  const dim = 'slowsql'; const title = '慢 SQL';
  const rows = (await q('SELECT left(query, 100) AS q, n_calls, total_elapse_time FROM dbe_perf.statement WHERE n_calls > 0 ORDER BY total_elapse_time DESC LIMIT 10', 10)).rows;
  const slow = rows
    .map((r) => ({ q: str(r.q), calls: num(r.n_calls), avgMs: num(r.total_elapse_time) / Math.max(1, num(r.n_calls)) / 1000 }))
    .filter((r) => r.avgMs >= THRESHOLDS.slowAvgMs.notice);
  const findings: DetFinding[] = [];
  const worst3 = slow.filter((r) => r.avgMs >= THRESHOLDS.slowAvgMs.warn);
  if (worst3.length >= THRESHOLDS.slowManyCount) {
    findings.push(finding({ dim, code: 'SLOWSQL_MANY', level: 'warn', metric: 'slow_sql_count', value: worst3.length, threshold: `>=${THRESHOLDS.slowManyCount} 条均耗时>${THRESHOLDS.slowAvgMs.warn}ms`, detail: `${worst3.length} 条 SQL 平均耗时超 ${THRESHOLDS.slowAvgMs.warn}ms`, evidence: worst3.slice(0, 3).map((r) => `${r.avgMs.toFixed(0)}ms×${r.calls}: ${r.q.slice(0, 60)}`).join(' | ') }));
  } else if (slow.length > 0) {
    findings.push(finding({ dim, code: 'SLOWSQL', level: 'notice', metric: 'slow_sql_count', value: slow.length, threshold: `均耗时>${THRESHOLDS.slowAvgMs.notice}ms`, detail: `${slow.length} 条 SQL 平均耗时超 ${THRESHOLDS.slowAvgMs.notice}ms`, evidence: slow.slice(0, 3).map((r) => `${r.avgMs.toFixed(0)}ms×${r.calls}: ${r.q.slice(0, 60)}`).join(' | ') }));
  }
  return { dim, title, ok: true, findings, evidence: { top: slow.slice(0, 5) } };
}

// ── 4 长·空闲事务 ───────────────────────────────────────────────────────────
async function dimXact(q: QueryFn): Promise<DimResult> {
  const dim = 'xact'; const title = '长·空闲事务';
  const rows = (await q(`SELECT pid, coalesce(state,'') AS state, extract(epoch FROM (now() - xact_start))::bigint AS sec, left(coalesce(query,''), 80) AS q FROM pg_stat_activity WHERE xact_start IS NOT NULL AND now() - xact_start > interval '${THRESHOLDS.xactSec.notice} seconds' ORDER BY xact_start LIMIT 10`, 10)).rows;
  const findings: DetFinding[] = [];
  for (const r of rows.slice(0, 5)) {
    const sec = num(r.sec);
    const idle = str(r.state).includes('idle in transaction');
    const level: DetLevel = sec >= THRESHOLDS.xactSec.critical ? 'critical' : sec >= THRESHOLDS.xactSec.warn ? 'warn' : 'notice';
    findings.push(finding({
      dim, code: idle ? 'XACT_IDLE' : 'XACT_LONG', level,
      metric: 'xact_age_sec', value: sec, threshold: `>=${level === 'critical' ? THRESHOLDS.xactSec.critical : level === 'warn' ? THRESHOLDS.xactSec.warn : THRESHOLDS.xactSec.notice}s`,
      detail: `pid ${num(r.pid)} ${idle ? '空闲事务' : '事务运行'} ${Math.floor(sec / 60)}m${sec % 60}s（state=${str(r.state)}）`,
      evidence: `query: ${str(r.q)}`,
    }));
  }
  return { dim, title, ok: true, findings, evidence: { count: rows.length } };
}

// ── 5 膨胀（死元组占比）─────────────────────────────────────────────────────
async function dimBloat(q: QueryFn): Promise<DimResult> {
  const dim = 'bloat'; const title = '膨胀';
  const rows = (await q(`SELECT schemaname || '.' || relname AS t, n_dead_tup::bigint AS dead, n_live_tup::bigint AS live, last_autovacuum FROM pg_stat_user_tables WHERE n_live_tup > ${THRESHOLDS.bloatMinLive} ORDER BY n_dead_tup DESC LIMIT 8`, 8)).rows;
  const findings: DetFinding[] = [];
  for (const r of rows) {
    const dead = num(r.dead); const live = num(r.live);
    const ratio = live > 0 ? dead / live : 0;
    if (ratio >= THRESHOLDS.bloatRatio.warn) {
      findings.push(finding({ dim, code: 'BLOAT_HIGH', level: 'warn', metric: 'dead_tup_ratio', value: Math.round(ratio * 100) / 100, threshold: `>=${THRESHOLDS.bloatRatio.warn}`, detail: `${str(r.t)} 死元组 ${(ratio * 100).toFixed(0)}%（dead ${dead} / live ${live}）`, evidence: `last_autovacuum=${str(r.last_autovacuum) || 'never'}` }));
    } else if (ratio >= THRESHOLDS.bloatRatio.notice) {
      findings.push(finding({ dim, code: 'BLOAT_MID', level: 'notice', metric: 'dead_tup_ratio', value: Math.round(ratio * 100) / 100, threshold: `>=${THRESHOLDS.bloatRatio.notice}`, detail: `${str(r.t)} 死元组 ${(ratio * 100).toFixed(0)}%`, evidence: `dead=${dead} live=${live}` }));
    }
  }
  return { dim, title, ok: true, findings: findings.slice(0, 5), evidence: { top: rows.slice(0, 5).map((r) => ({ t: str(r.t), dead: num(r.dead), live: num(r.live) })) } };
}

// ── 6 LWLock（dbe_perf.wait_events 里 LWLock 类占比）───────────────────────
async function dimLwlock(q: QueryFn): Promise<DimResult> {
  const dim = 'lwlock'; const title = 'LWLock';
  const rows = (await q("SELECT type, sum(total_wait_time)::float8 AS w FROM dbe_perf.wait_events GROUP BY type", 20)).rows;
  const total = rows.reduce((s, r) => s + num(r.w), 0);
  const lw = rows.filter((r) => str(r.type).toUpperCase().includes('LWLOCK')).reduce((s, r) => s + num(r.w), 0);
  const findings: DetFinding[] = [];
  if (total > 0) {
    const share = lw / total;
    if (share >= THRESHOLDS.lwlockShare.warn) {
      findings.push(finding({ dim, code: 'LWLOCK_HOT', level: 'warn', metric: 'lwlock_share', value: Math.round(share * 100) / 100, threshold: `>=${THRESHOLDS.lwlockShare.warn}`, detail: `LWLock 等待占总等待 ${(share * 100).toFixed(0)}%，存在内部争用热点`, evidence: `lwlock=${lw} total=${total}` }));
    } else if (share >= THRESHOLDS.lwlockShare.notice) {
      findings.push(finding({ dim, code: 'LWLOCK_HOT', level: 'notice', metric: 'lwlock_share', value: Math.round(share * 100) / 100, threshold: `>=${THRESHOLDS.lwlockShare.notice}`, detail: `LWLock 等待占比 ${(share * 100).toFixed(0)}%`, evidence: `lwlock=${lw} total=${total}` }));
    }
  }
  return { dim, title, ok: true, findings, evidence: { lwlockShare: total > 0 ? Math.round((lw / total) * 100) / 100 : 0 } };
}

// ── 7 锁链（阻塞会话）───────────────────────────────────────────────────────
async function dimLockChain(q: QueryFn): Promise<DimResult> {
  const dim = 'lockchain'; const title = '锁与阻塞链';
  const rows = (await q(`SELECT w.pid AS waiter, l.pid AS holder, extract(epoch FROM (now() - w.query_start))::bigint AS wait_sec, left(coalesce(w.query,''), 60) AS waiter_query
FROM pg_locks wl JOIN pg_locks l ON wl.locktype = l.locktype AND wl.relation IS NOT DISTINCT FROM l.relation AND l.granted
JOIN pg_stat_activity w ON w.pid = wl.pid JOIN pg_stat_activity h ON h.pid = l.pid
WHERE NOT wl.granted AND w.pid <> l.pid LIMIT 20`, 20)).rows;
  const blocked = new Set(rows.map((r) => num(r.waiter))).size;
  const findings: DetFinding[] = [];
  if (blocked >= THRESHOLDS.blockedSessions.critical) {
    const maxWait = Math.max(...rows.map((r) => num(r.wait_sec)));
    findings.push(finding({ dim, code: 'LOCK_CHAIN', level: 'critical', metric: 'blocked_sessions', value: blocked, threshold: `>=${THRESHOLDS.blockedSessions.critical}`, detail: `${blocked} 个会话被阻塞，最长等待 ${Math.floor(maxWait / 60)}m`, evidence: rows.slice(0, 3).map((r) => `waiter ${num(r.waiter)}<-holder ${num(r.holder)}: ${str(r.waiter_query)}`).join(' | ') }));
  } else if (blocked >= THRESHOLDS.blockedSessions.warn) {
    findings.push(finding({ dim, code: 'LOCK_CHAIN', level: 'warn', metric: 'blocked_sessions', value: blocked, threshold: `>=${THRESHOLDS.blockedSessions.warn}`, detail: `${blocked} 个会话在等锁`, evidence: rows.slice(0, 3).map((r) => `waiter ${num(r.waiter)}<-holder ${num(r.holder)}`).join(' | ') }));
  }
  return { dim, title, ok: true, findings, evidence: { blocked, edges: rows.slice(0, 5).map((r) => ({ waiter: num(r.waiter), holder: num(r.holder), waitSec: num(r.wait_sec) })) } };
}

// ── 8 连接 ──────────────────────────────────────────────────────────────────
async function dimConnections(q: QueryFn): Promise<DimResult> {
  const dim = 'connections'; const title = '连接';
  const used = num((await q('SELECT count(*)::int AS n FROM pg_stat_activity', 1)).rows[0]?.n);
  const max = num((await q("SELECT setting::int AS n FROM pg_settings WHERE name = 'max_connections'", 1)).rows[0]?.n);
  const ratio = max > 0 ? used / max : 0;
  const findings: DetFinding[] = [];
  if (ratio >= THRESHOLDS.connRatio.critical) {
    findings.push(finding({ dim, code: 'CONN_HIGH', level: 'critical', metric: 'conn_used_ratio', value: Math.round(ratio * 100) / 100, threshold: `>=${THRESHOLDS.connRatio.critical}`, detail: `连接占用 ${(ratio * 100).toFixed(0)}%（${used}/${max}），逼近上限`, evidence: `used=${used} max=${max}` }));
  } else if (ratio >= THRESHOLDS.connRatio.warn) {
    findings.push(finding({ dim, code: 'CONN_HIGH', level: 'warn', metric: 'conn_used_ratio', value: Math.round(ratio * 100) / 100, threshold: `>=${THRESHOLDS.connRatio.warn}`, detail: `连接占用 ${(ratio * 100).toFixed(0)}%（${used}/${max}）`, evidence: `used=${used} max=${max}` }));
  }
  return { dim, title, ok: true, findings, evidence: { used, max, ratio: Math.round(ratio * 100) / 100 } };
}

// ── 9 Checkpoint / WAL ──────────────────────────────────────────────────────
async function dimCkpt(q: QueryFn): Promise<DimResult> {
  const dim = 'ckpt'; const title = 'Checkpoint/WAL';
  const r = (await q('SELECT checkpoints_timed::bigint AS timed, checkpoints_req::bigint AS req FROM pg_stat_bgwriter', 1)).rows[0];
  const timed = num(r?.timed); const req = num(r?.req);
  const share = timed + req > 0 ? req / (timed + req) : 0;
  const findings: DetFinding[] = [];
  if (share >= THRESHOLDS.ckptReqShare.warn) {
    findings.push(finding({ dim, code: 'CKPT_REQ', level: 'warn', metric: 'ckpt_req_share', value: Math.round(share * 100) / 100, threshold: `>=${THRESHOLDS.ckptReqShare.warn}`, detail: `被动 checkpoint 占 ${(share * 100).toFixed(0)}%——WAL 压力大或 checkpoint 参数过小`, evidence: `timed=${timed} req=${req}` }));
  } else if (share >= THRESHOLDS.ckptReqShare.notice) {
    findings.push(finding({ dim, code: 'CKPT_REQ', level: 'notice', metric: 'ckpt_req_share', value: Math.round(share * 100) / 100, threshold: `>=${THRESHOLDS.ckptReqShare.notice}`, detail: `被动 checkpoint 占 ${(share * 100).toFixed(0)}%`, evidence: `timed=${timed} req=${req}` }));
  }
  return { dim, title, ok: true, findings, evidence: { timed, req } };
}

// ── 10 复制 ─────────────────────────────────────────────────────────────────
async function dimReplication(q: QueryFn): Promise<DimResult> {
  const dim = 'replication'; const title = '主备复制';
  const rows = (await q('SELECT client_addr::text AS addr, state, sync_state FROM pg_stat_replication', 8)).rows;
  const findings: DetFinding[] = [];
  const bad = rows.filter((r) => str(r.state).toLowerCase() !== 'streaming');
  if (bad.length > 0) {
    findings.push(finding({ dim, code: 'REPL_BROKEN', level: 'critical', metric: 'non_streaming_standbys', value: bad.length, threshold: 'state<>streaming', detail: `${bad.length} 个备机复制状态异常：${bad.map((r) => `${str(r.addr)}=${str(r.state)}`).join(', ')}`, evidence: JSON.stringify(rows.slice(0, 4)) }));
  }
  return { dim, title, ok: true, findings, evidence: { standbys: rows.map((r) => ({ addr: str(r.addr), state: str(r.state), sync: str(r.sync_state) })) } };
}

// ── 11 对象与索引 ────────────────────────────────────────────────────────────
async function dimObjects(q: QueryFn): Promise<DimResult> {
  const dim = 'objects'; const title = '对象与索引';
  const invalid = num((await q('SELECT count(*)::int AS n FROM pg_index WHERE NOT indisvalid', 1)).rows[0]?.n);
  const unused = (await q("SELECT schemaname || '.' || indexrelname AS idx FROM pg_stat_user_indexes WHERE idx_scan = 0 LIMIT 6", 6)).rows;
  const findings: DetFinding[] = [];
  if (invalid > 0) {
    findings.push(finding({ dim, code: 'IDX_INVALID', level: 'warn', metric: 'invalid_indexes', value: invalid, threshold: '>0', detail: `${invalid} 个失效索引（indisvalid=false）`, evidence: '' }));
  }
  if (unused.length > 0) {
    findings.push(finding({ dim, code: 'IDX_UNUSED', level: 'notice', metric: 'unused_indexes', value: unused.length, threshold: '>0 (idx_scan=0)', detail: `${unused.length}+ 个疑似无用索引（从未被扫描）`, evidence: unused.map((r) => str(r.idx)).join(', ') }));
  }
  return { dim, title, ok: true, findings, evidence: { invalid, unusedSample: unused.map((r) => str(r.idx)) } };
}

// ── 12 并发 ─────────────────────────────────────────────────────────────────
async function dimConcurrency(q: QueryFn): Promise<DimResult> {
  const dim = 'concurrency'; const title = '事务并发';
  const active = num((await q("SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'active'", 1)).rows[0]?.n);
  const prepared = num((await q('SELECT count(*)::int AS n FROM pg_prepared_xacts', 1)).rows[0]?.n);
  const findings: DetFinding[] = [];
  if (active >= THRESHOLDS.activeSessions.notice) {
    findings.push(finding({ dim, code: 'SESS_ACTIVE_HIGH', level: 'notice', metric: 'active_sessions', value: active, threshold: `>=${THRESHOLDS.activeSessions.notice}`, detail: `活跃会话 ${active}，并发偏高`, evidence: '' }));
  }
  if (prepared > 0) {
    findings.push(finding({ dim, code: 'XACT_PREPARED', level: 'notice', metric: 'prepared_xacts', value: prepared, threshold: '>0', detail: `存在 ${prepared} 个悬挂的两阶段事务`, evidence: '' }));
  }
  return { dim, title, ok: true, findings, evidence: { active, prepared } };
}

export const COLLECTORS: { key: string; title: string; run: (q: QueryFn) => Promise<DimResult> }[] = [
  { key: 'overview', title: '总览', run: dimOverview },
  { key: 'waits', title: '等待事件', run: dimWaits },
  { key: 'slowsql', title: '慢 SQL', run: dimSlowSql },
  { key: 'xact', title: '长·空闲事务', run: dimXact },
  { key: 'bloat', title: '膨胀', run: dimBloat },
  { key: 'lwlock', title: 'LWLock', run: dimLwlock },
  { key: 'lockchain', title: '锁与阻塞链', run: dimLockChain },
  { key: 'connections', title: '连接', run: dimConnections },
  { key: 'ckpt', title: 'Checkpoint/WAL', run: dimCkpt },
  { key: 'replication', title: '主备复制', run: dimReplication },
  { key: 'objects', title: '对象与索引', run: dimObjects },
  { key: 'concurrency', title: '事务并发', run: dimConcurrency },
];
