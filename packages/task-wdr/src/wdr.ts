/**
 * WDR 窗口 delta 计算 + 归因纪律 + 确定性阈值判定（opencode_skill wdr 方法论）。
 * 输入 = 两个快照的原始行（累计计数器），输出 = 窗口增量七维 + Deterministic Findings。
 * 归因纪律：temp→sort_spill、CPU→cpu_time 占比、IO→data_io_time 占比、锁→elapsed 高而 cpu≈0。
 * 纯函数，不碰连接——采集在 tool-wdr-collect，本文件可单测。
 */

import { specsFrom, applyOverrides, type ThresholdSpec } from '@opendb-dsh/thresholds-pg';

export type WdrLevel = 'ok' | 'notice' | 'warn' | 'critical';
export const LEVEL_ORDER: Record<WdrLevel, number> = { ok: 0, notice: 1, warn: 2, critical: 3 };

export interface WdrFinding {
  dim: string;
  code: string;
  level: WdrLevel;
  metric: string;
  value: number | string;
  threshold: string;
  evidence: string;
  detail: string;
}

export const WDR_THRESHOLDS = {
  avgActive: { notice: 2, warn: 5 },
  tempBytes: { notice: 10 * 1024 * 1024, warn: 100 * 1024 * 1024 },
  cacheHit: { notice: 0.99, warn: 0.95 },     // 低于
  ckptReqShare: { notice: 0.3, warn: 0.5 },
  rollbackRatio: { notice: 0.05, warn: 0.2 },
  blkSqlShare: { warn: 0.3 },                 // 锁等待型 SQL 占窗口 elapsed 比例
} as const;

/** 运行时阈值类型：与 WDR_THRESHOLDS 同形状、数值放宽为 number（阈值可配置化，2026-08-24） */
export type WdrThresholds = {
  [K in keyof typeof WDR_THRESHOLDS]: { [L in keyof (typeof WDR_THRESHOLDS)[K]]: number };
};

const WDR_THRESHOLD_META = {
  avgActive: { label: '平均活跃会话', rule: 'WDR_LOAD_HIGH', cmp: '>=' as const, unit: 'x' as const, desc: 'ΔDB_TIME / 窗口时长' },
  tempBytes: { label: '临时文件字节', rule: 'WDR_TEMP_SPILL', cmp: '>=' as const, unit: 'bytes' as const, desc: '窗口内 Δtemp_bytes（库级）' },
  cacheHit: { label: '窗口命中率', rule: 'WDR_CACHE_LOW', cmp: '<' as const, unit: 'ratio' as const, desc: '窗口内 blks delta 命中率，低于阈值告警' },
  ckptReqShare: { label: '被动 checkpoint 占比', rule: 'WDR_CKPT_REQ', cmp: '>=' as const, unit: 'ratio' as const, desc: '窗口 delta 的 req / (timed + req)' },
  rollbackRatio: { label: '回滚率', rule: 'WDR_ROLLBACK_HIGH', cmp: '>=' as const, unit: 'ratio' as const, desc: '窗口事务数 > 100 时的 rollback 占比' },
  blkSqlShare: { label: '锁等待型 SQL 份额', rule: 'WDR_SQL_BLOCKED', cmp: '>=' as const, unit: 'ratio' as const, desc: 'attr=blk 的 Top SQL 占窗口耗时' },
};

export const WDR_THRESHOLD_SPECS: ThresholdSpec[] = specsFrom('wdr', WDR_THRESHOLDS, WDR_THRESHOLD_META);

export function withWdrThresholds(flat: Record<string, number>): WdrThresholds {
  return applyOverrides(WDR_THRESHOLDS, flat);
}

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

// ── Load Profile / DB Time 构成（snap_global_instance_time 两快照 pivot delta）──
export interface InstTimeRow { snapshot_id: unknown; snap_stat_name: unknown; snap_value: unknown }

export function deltaInstanceTime(rows: InstTimeRow[], beginSnap: number, endSnap: number): { stat: string; deltaUs: number }[] {
  const b = new Map<string, number>(); const e = new Map<string, number>();
  for (const r of rows) {
    const m = n(r.snapshot_id) === beginSnap ? b : n(r.snapshot_id) === endSnap ? e : undefined;
    if (m !== undefined) m.set(String(r.snap_stat_name), n(r.snap_value));
  }
  return [...e.entries()]
    .map(([stat, v]) => ({ stat, deltaUs: Math.max(0, v - (b.get(stat) ?? 0)) }))
    .sort((x, y) => y.deltaUs - x.deltaUs);
}

/** DB Time 构成分解（AWS-PI 式）：CPU / IO / 其他（含等待），share 相对 DB_TIME */
export function dbTimeClasses(inst: { stat: string; deltaUs: number }[]): { total: number; classes: { name: string; us: number; share: number }[] } {
  const get = (k: string) => inst.find((i) => i.stat === k)?.deltaUs ?? 0;
  const total = get('DB_TIME');
  const cpu = get('CPU_TIME');
  const io = get('DATA_IO_TIME');
  const net = get('NET_SEND_TIME');
  const plan = get('PLAN_TIME') + get('PARSE_TIME') + get('REWRITE_TIME');
  const other = Math.max(0, total - cpu - io - net - plan);
  const mk = (name: string, us: number) => ({ name, us, share: total > 0 ? Math.round((us / total) * 1000) / 1000 : 0 });
  return { total, classes: [mk('CPU', cpu), mk('IO', io), mk('网络', net), mk('解析/计划', plan), mk('其他/等待', other)].filter((c) => c.us > 0) };
}

// ── Top SQL delta + 归因 ──────────────────────────────────────────────────────
export interface StmtRow {
  snapshot_id: unknown; snap_unique_sql_id: unknown; snap_query: unknown;
  snap_n_calls: unknown; snap_total_elapse_time: unknown; snap_cpu_time: unknown;
  snap_data_io_time: unknown; snap_sort_spill_size: unknown;
}

export interface TopSqlItem {
  sqlId: string; text: string; calls: number; elapsedMs: number; avgMs: number;
  cpuPct: number; ioPct: number; spillKb: number; attr: 'cpu' | 'io' | 'tmp' | 'blk' | 'other'; share: number;
}

export function attributeSql(elapsedUs: number, cpuUs: number, ioUs: number, spillKb: number): TopSqlItem['attr'] {
  if (spillKb > 0) return 'tmp';
  if (elapsedUs <= 0) return 'other';
  const cpuR = cpuUs / elapsedUs; const ioR = ioUs / elapsedUs;
  if (cpuR < 0.05 && ioR < 0.05 && elapsedUs > 1_000_000) return 'blk';   // 耗时大而 cpu/io 双低 = 等待（典型锁）
  if (cpuR >= 0.5) return 'cpu';
  if (ioR >= 0.3) return 'io';
  return 'other';
}

export function deltaTopSql(rows: StmtRow[], beginSnap: number, endSnap: number, topN: number): TopSqlItem[] {
  const b = new Map<string, StmtRow>(); const e = new Map<string, StmtRow>();
  for (const r of rows) {
    const id = String(r.snap_unique_sql_id);
    if (n(r.snapshot_id) === beginSnap) b.set(id, r);
    else if (n(r.snapshot_id) === endSnap) e.set(id, r);
  }
  const items: (TopSqlItem & { elapsedUs: number })[] = [];
  for (const [id, er] of e) {
    const br = b.get(id);
    const d = (k: keyof StmtRow) => Math.max(0, n(er[k]) - (br !== undefined ? n(br[k]) : 0));
    const elapsedUs = d('snap_total_elapse_time');
    const calls = d('snap_n_calls');
    if (elapsedUs <= 0 && calls <= 0) continue;
    const cpuUs = d('snap_cpu_time'); const ioUs = d('snap_data_io_time'); const spillKb = d('snap_sort_spill_size');
    items.push({
      sqlId: id, text: String(er.snap_query ?? '').slice(0, 200), calls,
      elapsedMs: Math.round(elapsedUs / 1000), avgMs: calls > 0 ? Math.round(elapsedUs / calls / 1000) : Math.round(elapsedUs / 1000),
      cpuPct: elapsedUs > 0 ? Math.round((cpuUs / elapsedUs) * 100) : 0,
      ioPct: elapsedUs > 0 ? Math.round((ioUs / elapsedUs) * 100) : 0,
      spillKb, attr: attributeSql(elapsedUs, cpuUs, ioUs, spillKb), share: 0, elapsedUs,
    });
  }
  const totalUs = items.reduce((s, i) => s + i.elapsedUs, 0);
  return items
    .sort((x, y) => y.elapsedUs - x.elapsedUs)
    .slice(0, topN)
    .map(({ elapsedUs, ...rest }) => ({ ...rest, share: totalUs > 0 ? Math.round((elapsedUs / totalUs) * 100) / 100 : 0 }));
}

// ── 库级 Stat delta ──────────────────────────────────────────────────────────
export interface StatDbRow {
  snapshot_id: unknown; snap_datname: unknown; snap_xact_commit: unknown; snap_xact_rollback: unknown;
  snap_blks_read: unknown; snap_blks_hit: unknown; snap_temp_bytes: unknown; snap_deadlocks: unknown;
}

export interface DbStatDelta { db: string; commits: number; rollbacks: number; blksRead: number; blksHit: number; tempBytes: number; deadlocks: number; hitRatio: number }

export function deltaStatDatabase(rows: StatDbRow[], beginSnap: number, endSnap: number): DbStatDelta[] {
  const b = new Map<string, StatDbRow>(); const e = new Map<string, StatDbRow>();
  for (const r of rows) {
    const db = String(r.snap_datname);
    if (n(r.snapshot_id) === beginSnap) b.set(db, r);
    else if (n(r.snapshot_id) === endSnap) e.set(db, r);
  }
  const out: DbStatDelta[] = [];
  for (const [db, er] of e) {
    const br = b.get(db);
    const d = (k: keyof StatDbRow) => Math.max(0, n(er[k]) - (br !== undefined ? n(br[k]) : 0));
    const read = d('snap_blks_read'); const hit = d('snap_blks_hit');
    out.push({
      db, commits: d('snap_xact_commit'), rollbacks: d('snap_xact_rollback'),
      blksRead: read, blksHit: hit, tempBytes: d('snap_temp_bytes'), deadlocks: d('snap_deadlocks'),
      hitRatio: read + hit > 0 ? Math.round((hit / (read + hit)) * 10000) / 10000 : 1,
    });
  }
  return out.sort((x, y) => (y.commits + y.rollbacks) - (x.commits + x.rollbacks)).slice(0, 8);
}

// ── 等待事件 delta ───────────────────────────────────────────────────────────
export interface WaitRow { snapshot_id: unknown; snap_type: unknown; snap_event: unknown; snap_total_wait_time: unknown }

export function deltaWaits(rows: WaitRow[], beginSnap: number, endSnap: number): { type: string; event: string; waitUs: number; share: number }[] {
  const key = (r: WaitRow) => `${String(r.snap_type)}|${String(r.snap_event)}`;
  const b = new Map<string, number>(); const e = new Map<string, WaitRow>();
  for (const r of rows) {
    if (n(r.snapshot_id) === beginSnap) b.set(key(r), n(r.snap_total_wait_time));
    else if (n(r.snapshot_id) === endSnap) e.set(key(r), r);
  }
  const items = [...e.values()]
    .map((r) => ({ type: String(r.snap_type), event: String(r.snap_event), waitUs: Math.max(0, n(r.snap_total_wait_time) - (b.get(key(r)) ?? 0)) }))
    .filter((r) => r.waitUs > 0 && r.type !== 'STATUS');   // STATUS 类是空闲等待（如 wait cmd），归因噪声，剔除
  const total = items.reduce((s, i) => s + i.waitUs, 0);
  return items.sort((x, y) => y.waitUs - x.waitUs).slice(0, 10)
    .map((i) => ({ ...i, share: total > 0 ? Math.round((i.waitUs / total) * 100) / 100 : 0 }));
}

// ── 确定性阈值判定 ───────────────────────────────────────────────────────────
export function judgeWindow(input: {
  windowMinutes: number;
  dbTimeUs: number;
  dbStats: DbStatDelta[];
  ckpt: { timed: number; req: number };
  topSql: TopSqlItem[];
}, T: WdrThresholds = WDR_THRESHOLDS): WdrFinding[] {
  const out: WdrFinding[] = [];
  const wallUs = input.windowMinutes * 60 * 1_000_000;
  if (wallUs > 0 && input.dbTimeUs > 0) {
    const avgActive = Math.round((input.dbTimeUs / wallUs) * 100) / 100;
    if (avgActive >= T.avgActive.warn) out.push({ dim: 'load', code: 'WDR_LOAD_HIGH', level: 'warn', metric: 'avg_active_sessions', value: avgActive, threshold: `>=${T.avgActive.warn}`, evidence: `ΔDB_TIME=${input.dbTimeUs}µs / 窗口 ${input.windowMinutes}m`, detail: `平均活跃会话 ${avgActive}，窗口内负载高` });
    else if (avgActive >= T.avgActive.notice) out.push({ dim: 'load', code: 'WDR_LOAD_HIGH', level: 'notice', metric: 'avg_active_sessions', value: avgActive, threshold: `>=${T.avgActive.notice}`, evidence: `ΔDB_TIME=${input.dbTimeUs}µs`, detail: `平均活跃会话 ${avgActive}` });
  }
  for (const s of input.dbStats) {
    if (s.tempBytes >= T.tempBytes.warn) out.push({ dim: 'temp', code: 'WDR_TEMP_SPILL', level: 'warn', metric: 'temp_bytes', value: s.tempBytes, threshold: `>=${T.tempBytes.warn}`, evidence: `db=${s.db}`, detail: `${s.db} 窗口内临时文件 ${Math.round(s.tempBytes / 1024 / 1024)}MB——排序/哈希下盘` });
    else if (s.tempBytes >= T.tempBytes.notice) out.push({ dim: 'temp', code: 'WDR_TEMP_SPILL', level: 'notice', metric: 'temp_bytes', value: s.tempBytes, threshold: `>=${T.tempBytes.notice}`, evidence: `db=${s.db}`, detail: `${s.db} 临时文件 ${Math.round(s.tempBytes / 1024 / 1024)}MB` });
    if (s.blksRead + s.blksHit > 10000) {
      if (s.hitRatio < T.cacheHit.warn) out.push({ dim: 'cache', code: 'WDR_CACHE_LOW', level: 'warn', metric: 'hit_ratio', value: s.hitRatio, threshold: `<${T.cacheHit.warn}`, evidence: `db=${s.db} read=${s.blksRead} hit=${s.blksHit}`, detail: `${s.db} 窗口命中率 ${(s.hitRatio * 100).toFixed(2)}%，物理读偏高` });
      else if (s.hitRatio < T.cacheHit.notice) out.push({ dim: 'cache', code: 'WDR_CACHE_LOW', level: 'notice', metric: 'hit_ratio', value: s.hitRatio, threshold: `<${T.cacheHit.notice}`, evidence: `db=${s.db}`, detail: `${s.db} 窗口命中率 ${(s.hitRatio * 100).toFixed(2)}%` });
    }
    if (s.deadlocks > 0) out.push({ dim: 'lock', code: 'WDR_DEADLOCK', level: 'warn', metric: 'deadlocks', value: s.deadlocks, threshold: '>0', evidence: `db=${s.db}`, detail: `${s.db} 窗口内死锁 ${s.deadlocks} 次` });
    const xacts = s.commits + s.rollbacks;
    if (xacts > 100) {
      const rr = s.rollbacks / xacts;
      if (rr >= T.rollbackRatio.warn) out.push({ dim: 'xact', code: 'WDR_ROLLBACK_HIGH', level: 'warn', metric: 'rollback_ratio', value: Math.round(rr * 1000) / 1000, threshold: `>=${T.rollbackRatio.warn}`, evidence: `db=${s.db} commit=${s.commits} rollback=${s.rollbacks}`, detail: `${s.db} 回滚率 ${(rr * 100).toFixed(1)}%` });
      else if (rr >= T.rollbackRatio.notice) out.push({ dim: 'xact', code: 'WDR_ROLLBACK_HIGH', level: 'notice', metric: 'rollback_ratio', value: Math.round(rr * 1000) / 1000, threshold: `>=${T.rollbackRatio.notice}`, evidence: `db=${s.db}`, detail: `${s.db} 回滚率 ${(rr * 100).toFixed(1)}%` });
    }
  }
  const ck = input.ckpt.timed + input.ckpt.req;
  if (ck > 0) {
    const share = input.ckpt.req / ck;
    if (share >= T.ckptReqShare.warn) out.push({ dim: 'ckpt', code: 'WDR_CKPT_REQ', level: 'warn', metric: 'ckpt_req_share', value: Math.round(share * 100) / 100, threshold: `>=${T.ckptReqShare.warn}`, evidence: `timed=${input.ckpt.timed} req=${input.ckpt.req}`, detail: `被动 checkpoint 占 ${(share * 100).toFixed(0)}%，WAL 压力大` });
    else if (share >= T.ckptReqShare.notice) out.push({ dim: 'ckpt', code: 'WDR_CKPT_REQ', level: 'notice', metric: 'ckpt_req_share', value: Math.round(share * 100) / 100, threshold: `>=${T.ckptReqShare.notice}`, evidence: `timed=${input.ckpt.timed} req=${input.ckpt.req}`, detail: `被动 checkpoint 占 ${(share * 100).toFixed(0)}%` });
  }
  const blkShare = input.topSql.filter((s) => s.attr === 'blk').reduce((s, i) => s + i.share, 0);
  if (blkShare >= T.blkSqlShare.warn) {
    const worst = input.topSql.find((s) => s.attr === 'blk');
    out.push({ dim: 'topsql', code: 'WDR_SQL_BLOCKED', level: 'warn', metric: 'blk_sql_share', value: Math.round(blkShare * 100) / 100, threshold: `>=${T.blkSqlShare.warn}`, evidence: worst !== undefined ? `sql ${worst.sqlId} elapsed ${worst.elapsedMs}ms cpu ${worst.cpuPct}%` : '', detail: `锁/等待型 SQL 占窗口耗时 ${(blkShare * 100).toFixed(0)}%（elapsed 高而 cpu≈0 的归因纪律）` });
  }
  return out.sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level]);
}

export function worstOf(findings: WdrFinding[]): WdrLevel {
  return findings.reduce<WdrLevel>((acc, f) => (LEVEL_ORDER[f.level] > LEVEL_ORDER[acc] ? f.level : acc), 'ok');
}
