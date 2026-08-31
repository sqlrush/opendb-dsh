/**
 * 容量与增长——纯函数层（可单测，不碰连接）。
 * 采集器（tool-capacity-collect）把节点上读到的原始数字整理成 CapInput，这里负责：
 *   ① 增速：观测窗内样本的线性回归斜率（GB/天）；遇到清理"悬崖"（单步跌 >20%）只用悬崖之后的段外推并标 resetAt，
 *      悬崖后样本不足则退回悬崖前的段（segment='pre-reset'）且把置信度压为 low；
 *   ② 满盘估算：磁盘可用 ÷ 增速；增速低于门槛不外推（避免用 0.03 GB/天算出"9000 天"这种假精度）；
 *   ③ CAP_* 判定：级别由脚本产出，模型只解读、不得下调。
 * 所有大小按字节进出，展示层再换算（pg_size_pretty 口径：1 GB = 1024³ B）。
 */
import { specsFrom, applyOverrides, type ThresholdSpec } from '@opendb-dsh/thresholds-pg';

export type CapLevel = 'ok' | 'notice' | 'warn' | 'critical';
export const LEVEL_ORDER: Record<CapLevel, number> = { ok: 0, notice: 1, warn: 2, critical: 3 };
export const GIB = 1024 ** 3;
const DAY_MS = 86400_000;

/** 判据默认值（代码即真相；平台阈值服务可覆盖，语义不变） */
export const CAP_THRESHOLDS = {
  diskUsed: { notice: 0.8, warn: 0.9 },                       // CAP_DISK_FREE：卷已用占比
  daysToFull: { notice: 90, warn: 30 },                        // CAP_GROWTH：满盘天数（越小越严重）
  minGrowthBytesPerDay: 0.1 * GIB,                             // 增速低于此不外推
  nonTableShare: { notice: 0.3, warn: 0.5 },                   // CAP_NONTABLE_SHARE：非表占用 / 数据目录
  sysTableBloat: { minBytes: 4 * GIB, avgRowBytes: 8 * 1024 }, // CAP_STMT_HISTORY_BLOAT：系统表大且行均异常
  statsNeverRows: 1_000_000,                                   // CAP_STATS_NEVER：从未 analyze 的表 reltuples 门槛
  deadRatio: { notice: 0.2, warn: 0.4, minBytes: 1 * GIB },    // CAP_DEAD_TUPLES：死元组占比（只看够大的表）
  walSegFactor: 3,                                             // CAP_WAL_SIZE：段数 > factor × checkpoint_segments
  wdr: { maxBytes: 10 * GIB, overdueDays: 2 },                 // CAP_WDR_RETENTION
  collectGapHours: 24,                                         // CAP_COLLECT_GAP：相邻采样间隔
  logMaxBytes: 2 * GIB,                                        // CAP_LOG_RETENTION：无保留策略且日志超过此值
} as const;

/** 与常量同构（applyOverrides 只改数值不改形状） */
export type CapThresholds = typeof CAP_THRESHOLDS;

const META = {
  'diskUsed.notice': { label: '磁盘已用 · 关注', rule: 'CAP_DISK_FREE', cmp: '>=' as const, unit: 'ratio' as const, desc: '数据目录所在卷已用占比（有主机侧数据时判定）' },
  'diskUsed.warn': { label: '磁盘已用 · 告警', rule: 'CAP_DISK_FREE', cmp: '>=' as const, unit: 'ratio' as const, desc: '数据目录所在卷已用占比' },
  'daysToFull.notice': { label: '满盘天数 · 关注', rule: 'CAP_GROWTH', cmp: '<' as const, unit: 'count' as const, desc: '磁盘可用 ÷ 增速，小于此天数关注' },
  'daysToFull.warn': { label: '满盘天数 · 告警', rule: 'CAP_GROWTH', cmp: '<' as const, unit: 'count' as const, desc: '磁盘可用 ÷ 增速，小于此天数告警' },
  minGrowthBytesPerDay: { label: '外推增速门槛', rule: 'CAP_GROWTH', cmp: '>=' as const, unit: 'bytes' as const, desc: '日增长低于此值不做满盘外推' },
  'nonTableShare.notice': { label: '非表占用比 · 关注', rule: 'CAP_NONTABLE_SHARE', cmp: '>=' as const, unit: 'ratio' as const, desc: 'WAL+全量 SQL 追踪+WDR+日志/审计/core 占数据目录比例' },
  'nonTableShare.warn': { label: '非表占用比 · 告警', rule: 'CAP_NONTABLE_SHARE', cmp: '>=' as const, unit: 'ratio' as const, desc: '同上' },
  'sysTableBloat.minBytes': { label: '系统表膨胀 · 最小体积', rule: 'CAP_STMT_HISTORY_BLOAT', cmp: '>=' as const, unit: 'bytes' as const, desc: 'statement_history 等系统表体积达到此值才判' },
  'sysTableBloat.avgRowBytes': { label: '系统表膨胀 · 行均字节', rule: 'CAP_STMT_HISTORY_BLOAT', cmp: '>=' as const, unit: 'bytes' as const, desc: '体积 ÷ 行数超过此值视为空间未回收' },
  statsNeverRows: { label: '从未 analyze · 行数门槛', rule: 'CAP_STATS_NEVER', cmp: '>=' as const, unit: 'count' as const, desc: 'reltuples 达到此值且从未 analyze 的表计入' },
  'deadRatio.notice': { label: '死元组占比 · 关注', rule: 'CAP_DEAD_TUPLES', cmp: '>=' as const, unit: 'ratio' as const, desc: 'n_dead / (live+dead)' },
  'deadRatio.warn': { label: '死元组占比 · 告警', rule: 'CAP_DEAD_TUPLES', cmp: '>=' as const, unit: 'ratio' as const, desc: '同上' },
  'deadRatio.minBytes': { label: '死元组 · 最小表体积', rule: 'CAP_DEAD_TUPLES', cmp: '>=' as const, unit: 'bytes' as const, desc: '小表不判' },
  walSegFactor: { label: 'WAL 段数倍数', rule: 'CAP_WAL_SIZE', cmp: '>' as const, unit: 'x' as const, desc: 'pg_xlog 段数 > 倍数 × checkpoint_segments 判告警' },
  'wdr.maxBytes': { label: 'WDR 快照最大体积', rule: 'CAP_WDR_RETENTION', cmp: '>=' as const, unit: 'bytes' as const, desc: 'snapshot schema 体积' },
  'wdr.overdueDays': { label: 'WDR 最老快照超期天数', rule: 'CAP_WDR_RETENTION', cmp: '>' as const, unit: 'count' as const, desc: '最老快照年龄 − 保留天数' },
  collectGapHours: { label: '采集空窗', rule: 'CAP_COLLECT_GAP', cmp: '>' as const, unit: 'hour' as const, desc: '相邻两次采样间隔超过此小时数' },
  logMaxBytes: { label: '运行日志体积', rule: 'CAP_LOG_RETENTION', cmp: '>=' as const, unit: 'bytes' as const, desc: '无保留策略且 pg_log 超过此值' },
};

export const CAP_THRESHOLD_SPECS: ThresholdSpec[] = specsFrom('capacity', CAP_THRESHOLDS, META);
export function withCapThresholds(flat: Record<string, number>): CapThresholds {
  return applyOverrides(CAP_THRESHOLDS, flat);
}

// ───────────────────────────────────────────── 增速
export interface SamplePoint { t: number; bytes: number }
export interface GrowthStats {
  points: number;            // 参与回归的样本数
  windowHours: number;       // 参与回归的时间跨度
  netBytes: number;          // 段内净增
  bytesPerDay: number;       // 回归斜率
  resetAt?: number;          // 检测到清理悬崖的时间
  /** post-reset：用悬崖之后的段；pre-reset：悬崖后样本不足，暂用悬崖前的段（置信度压为 low） */
  segment?: 'post-reset' | 'pre-reset';
  confidence: 'low' | 'medium' | 'high';
}

/** 最小二乘斜率（bytes / ms）；点数 < 2 或时间跨度为 0 → 0 */
export function linearSlope(points: SamplePoint[]): number {
  if (points.length < 2) return 0;
  const n = points.length;
  const mt = points.reduce((a, p) => a + p.t, 0) / n;
  const mb = points.reduce((a, p) => a + p.bytes, 0) / n;
  let num = 0; let den = 0;
  for (const p of points) { num += (p.t - mt) * (p.bytes - mb); den += (p.t - mt) ** 2; }
  return den === 0 ? 0 : num / den;
}

/** 观测窗内的增速；单步下跌 >20% 视为清理悬崖，只用悬崖之后的段 */
export function growthStats(all: SamplePoint[], nowMs: number, windowDays: number): GrowthStats {
  const since = nowMs - windowDays * DAY_MS;
  const pts = all.filter((p) => p.t >= since && p.t <= nowMs && Number.isFinite(p.bytes)).sort((a, b) => a.t - b.t);
  let resetAt: number | undefined;
  for (let i = 1; i < pts.length; i += 1) if (pts[i].bytes < pts[i - 1].bytes * 0.8) resetAt = pts[i].t;
  const spans = (xs: SamplePoint[]) => xs.length >= 2 && xs[xs.length - 1].t - xs[0].t >= 3600_000;
  let use = pts; let segment: GrowthStats['segment'];
  if (resetAt !== undefined) {
    const after = pts.filter((p) => p.t >= resetAt!); const before = pts.filter((p) => p.t < resetAt!);
    if (spans(after)) { use = after; segment = 'post-reset'; }
    else if (before.length >= 2) { use = before; segment = 'pre-reset'; }   // 悬崖刚发生：先用之前的段，报置信度低
    else { use = after; segment = 'post-reset'; }
  }
  const windowMs = use.length >= 2 ? use[use.length - 1].t - use[0].t : 0;
  const windowHours = Math.round(windowMs / 3600_000 * 10) / 10;
  const bytesPerDay = windowMs > 0 ? linearSlope(use) * DAY_MS : 0;
  const netBytes = use.length >= 2 ? use[use.length - 1].bytes - use[0].bytes : 0;
  const natural: GrowthStats['confidence'] = windowHours >= 72 && use.length >= 12 ? 'high' : windowHours >= 24 && use.length >= 4 ? 'medium' : 'low';
  const confidence: GrowthStats['confidence'] = segment === 'pre-reset' ? 'low' : natural;
  return { points: use.length, windowHours, netBytes, bytesPerDay, resetAt, segment, confidence };
}

/** 满盘天数：可用 ÷ 增速；增速低于门槛或无磁盘数据 → undefined（不外推） */
export function daysToFull(availBytes: number | undefined, bytesPerDay: number, minBytesPerDay: number): number | undefined {
  if (availBytes === undefined || !(availBytes > 0)) return undefined;
  if (!(bytesPerDay >= minBytesPerDay)) return undefined;
  return Math.round(availBytes / bytesPerDay);
}

/** 采样序列里的空窗（相邻间隔 > gapHours 的段） */
export function findGaps(points: SamplePoint[], gapHours: number): { from: number; to: number }[] {
  const s = points.slice().sort((a, b) => a.t - b.t);
  const out: { from: number; to: number }[] = [];
  for (let i = 1; i < s.length; i += 1) if (s[i].t - s[i - 1].t > gapHours * 3600_000) out.push({ from: s[i - 1].t, to: s[i].t });
  return out;
}

// ───────────────────────────────────────────── 判定
export interface CapFinding {
  rule: string; level: CapLevel; object: string;
  problem: string; advice: string; evidence: string;
}
export interface CapInput {
  disk?: { totalBytes: number; usedBytes: number; availBytes: number };
  dbBytes: number;
  dataDirBytes: number;
  nonTableBytes: number;
  growth: GrowthStats;
  daysToFull?: number;
  gapHours: number;                  // 最近一次采样与上一次的间隔；首采 0
  firstRun: boolean;
  sysTables: { name: string; bytes: number; rows: number }[];
  statsNever: { count: number; maxRows: number; top: string[] };
  deadTop: { name: string; ratio: number; bytes: number; dead: number }[];
  /** 文件级（pg_ls_dir / pg_stat_file）是否可读；openGauss 只允许初始账号（omm），SYSADMIN 也不行 */
  filesAvailable: boolean;
  wal: { segments: number; bytes: number; checkpointSegments: number; slots: number; slotsInactive: number };
  wdr: { enabled: boolean; bytes: number; count: number; oldestAgeDays?: number; retentionDays: number };
  log: { bytes: number; files: number; hasRetention: boolean; oldest?: string };
}

const gb = (b: number): string => `${(b / GIB).toFixed(b >= 10 * GIB ? 0 : b >= GIB ? 1 : 2)} GB`;
const pct = (r: number): string => `${Math.round(r * 100)}%`;

export function judgeCapacity(i: CapInput, T: CapThresholds = CAP_THRESHOLDS): CapFinding[] {
  const out: CapFinding[] = [];
  // ① 磁盘
  if (i.disk !== undefined && i.disk.totalBytes > 0) {
    const used = i.disk.usedBytes / i.disk.totalBytes;
    const level: CapLevel = used >= T.diskUsed.warn ? 'warn' : used >= T.diskUsed.notice ? 'notice' : 'ok';
    out.push({ rule: 'CAP_DISK_FREE', level, object: 'disk', problem: level === 'ok' ? `磁盘可用 ${gb(i.disk.availBytes)}（已用 ${pct(used)}），本库占卷的 ${pct(i.dataDirBytes / i.disk.totalBytes)}` : `磁盘已用 ${pct(used)}，仅剩 ${gb(i.disk.availBytes)}`, advice: level === 'ok' ? '' : '优先清理非表占用与历史数据，或扩容', evidence: `used ${gb(i.disk.usedBytes)} / total ${gb(i.disk.totalBytes)} · 阈值 关注 ≥${pct(T.diskUsed.notice)} → 告警 ≥${pct(T.diskUsed.warn)}` });
  } else {
    out.push({ rule: 'CAP_DISK_FREE', level: 'ok', object: 'disk', problem: '主机侧磁盘数据未接入（openGauss 视图不暴露文件系统容量），满盘估算只能给增速', advice: '接入主机采集后自动补齐', evidence: '无 df 数据' });
  }
  // ② 增速 / 满盘
  const g = i.growth;
  const perDayGb = g.bytesPerDay / GIB;
  if (i.daysToFull !== undefined) {
    const level: CapLevel = i.daysToFull < T.daysToFull.warn ? 'warn' : i.daysToFull < T.daysToFull.notice ? 'notice' : 'ok';
    out.push({ rule: 'CAP_GROWTH', level, object: 'db', problem: `按观测窗 ${g.windowHours} h 增速 ${perDayGb.toFixed(2)} GB/天外推，约 ${i.daysToFull} 天满盘`, advice: level === 'ok' ? '' : '核对 Top 增长对象，评估归档/清理/扩容', evidence: `净增 ${gb(g.netBytes)} · 样本 ${g.points} · 置信度 ${g.confidence} · 阈值 <${T.daysToFull.notice} 天关注 → <${T.daysToFull.warn} 天告警` });
  } else {
    out.push({ rule: 'CAP_GROWTH', level: 'ok', object: 'db', problem: g.points >= 2 ? `观测窗 ${g.windowHours} h 内数据库净增 ${g.netBytes >= 0 ? '+' : '−'}${gb(Math.abs(g.netBytes))}（≈ ${perDayGb.toFixed(2)} GB/天）${g.bytesPerDay < T.minGrowthBytesPerDay ? '，低于外推门槛不算满盘' : '，无磁盘数据不算满盘'}` : '首次采样，增速自下次起可得', advice: '', evidence: `样本 ${g.points} · 置信度 ${g.confidence}${g.resetAt !== undefined ? ` · 检测到清理悬崖，只用其后的段` : ''}` });
  }
  // ③ 非表占用
  if (i.dataDirBytes > 0) {
    const share = i.nonTableBytes / i.dataDirBytes;
    const level: CapLevel = share >= T.nonTableShare.warn ? 'warn' : share >= T.nonTableShare.notice ? 'notice' : 'ok';
    const scope = i.filesAvailable ? 'WAL / 全量 SQL 追踪 / WDR / 日志 / 审计 / core' : '全量 SQL 追踪 / WDR；WAL / 日志 / 审计 / core 需初始账号才能读，未计入';
    out.push({ rule: 'CAP_NONTABLE_SHARE', level, object: 'datadir', problem: `非表占用 ${gb(i.nonTableBytes)} = ${i.filesAvailable ? '数据目录' : '库'}的 ${pct(share)}（${scope}）`, advice: level === 'ok' ? '' : '逐项看"谁在决定它的大小"：参数与保留策略，不是业务数据', evidence: `${i.filesAvailable ? '数据目录' : '库'} ${gb(i.dataDirBytes)} · 阈值 关注 ≥${pct(T.nonTableShare.notice)} → 告警 ≥${pct(T.nonTableShare.warn)}` });
  }
  // ④ 系统表膨胀（statement_history 等）
  for (const s of i.sysTables) {
    const avg = s.rows > 0 ? s.bytes / s.rows : Number.POSITIVE_INFINITY;
    if (s.bytes >= T.sysTableBloat.minBytes && avg >= T.sysTableBloat.avgRowBytes) {
      out.push({ rule: 'CAP_STMT_HISTORY_BLOAT', level: 'warn', object: s.name, problem: `${s.name} ${gb(s.bytes)} 只承载 ${s.rows.toLocaleString('en-US')} 行（≈ ${Number.isFinite(avg) ? `${Math.round(avg / 1024)} KB/行` : '无行'}）——滚动删除后空间未回收`, advice: '降低 track_stmt_stat_level（如 OFF,L0 / L0,L1）并由 DBA VACUUM FULL 回收；平台只读不代执行', evidence: `阈值 体积 ≥${gb(T.sysTableBloat.minBytes)} 且行均 ≥${Math.round(T.sysTableBloat.avgRowBytes / 1024)} KB` });
    }
  }
  if (!out.some((f) => f.rule === 'CAP_STMT_HISTORY_BLOAT')) {
    const big = i.sysTables.slice().sort((a, b) => b.bytes - a.bytes)[0];
    out.push({ rule: 'CAP_STMT_HISTORY_BLOAT', level: 'ok', object: big?.name ?? 'sys', problem: big !== undefined ? `系统表最大 ${big.name} ${gb(big.bytes)} / ${big.rows.toLocaleString('en-US')} 行，行均正常` : '无可评估的系统表', advice: '', evidence: `阈值 体积 ≥${gb(T.sysTableBloat.minBytes)} 且行均 ≥${Math.round(T.sysTableBloat.avgRowBytes / 1024)} KB` });
  }
  // ⑤ 统计信息从未收集
  if (i.statsNever.count > 0) {
    out.push({ rule: 'CAP_STATS_NEVER', level: 'warn', object: i.statsNever.top[0] ?? 'tables', problem: `${i.statsNever.count} 张大表从未 analyze（最大 reltuples ${i.statsNever.maxRows.toLocaleString('en-US')}；如 ${i.statsNever.top.slice(0, 3).join('、')}），优化器只有装载时的 reltuples`, advice: '由 DBA 对这些表执行 ANALYZE，再核对 Top SQL 的计划是否改变', evidence: `last_analyze / last_autoanalyze 均为 NULL · 阈值 reltuples ≥${T.statsNeverRows.toLocaleString('en-US')}` });
  } else {
    out.push({ rule: 'CAP_STATS_NEVER', level: 'ok', object: 'tables', problem: `没有 reltuples ≥${T.statsNeverRows.toLocaleString('en-US')} 且从未 analyze 的表`, advice: '', evidence: 'pg_stat_user_tables.last_analyze / last_autoanalyze' });
  }
  // ⑥ 死元组
  const deadHit = i.deadTop.filter((d) => d.bytes >= T.deadRatio.minBytes && d.ratio >= T.deadRatio.notice).sort((a, b) => b.ratio - a.ratio)[0];
  if (deadHit !== undefined) {
    const level: CapLevel = deadHit.ratio >= T.deadRatio.warn ? 'warn' : 'notice';
    out.push({ rule: 'CAP_DEAD_TUPLES', level, object: deadHit.name, problem: `${deadHit.name} 死元组 ${pct(deadHit.ratio)}（${deadHit.dead.toLocaleString('en-US')} 行，表 ${gb(deadHit.bytes)}）`, advice: '检查 autovacuum 是否跟得上（naptime / scale_factor / 长事务阻塞）', evidence: `阈值 关注 ≥${pct(T.deadRatio.notice)} → 告警 ≥${pct(T.deadRatio.warn)}，只看 ≥${gb(T.deadRatio.minBytes)} 的表` });
  } else {
    const top = i.deadTop.slice().sort((a, b) => b.ratio - a.ratio)[0];
    out.push({ rule: 'CAP_DEAD_TUPLES', level: 'ok', object: top?.name ?? 'tables', problem: top !== undefined ? `死元组最高 ${pct(top.ratio)}（${top.name}），autovacuum 正常回收` : '无死元组累积', advice: '', evidence: `阈值 关注 ≥${pct(T.deadRatio.notice)} 且表 ≥${gb(T.deadRatio.minBytes)} → 告警 ≥${pct(T.deadRatio.warn)}` });
  }
  // ⑦ WAL（文件级不可读时只能按参数给上限估算 + 看复制槽）
  {
    const w = i.wal; const cap = w.checkpointSegments > 0 ? T.walSegFactor * w.checkpointSegments : 0;
    const over = i.filesAvailable && cap > 0 && w.segments > cap; const slotBad = w.slotsInactive > 0;
    const level: CapLevel = over || slotBad ? 'warn' : 'ok';
    const capLine = w.checkpointSegments > 0 ? `按 checkpoint_segments = ${w.checkpointSegments} 估上限 ≈ ${gb((T.walSegFactor * w.checkpointSegments + 1) * 16 * 1024 * 1024)}` : 'checkpoint_segments 未读到';
    const okText = i.filesAvailable
      ? `pg_xlog ${w.segments} 段 / ${gb(w.bytes)}，在 checkpoint_segments = ${w.checkpointSegments} 的保留范围内${w.slots > 0 ? `，复制槽 ${w.slots} 个均活跃` : '，无复制槽滞留'}`
      : `WAL 目录不可读（需初始账号），${capLine}${w.slots > 0 ? `；复制槽 ${w.slots} 个均活跃` : '；无复制槽滞留'}`;
    out.push({ rule: 'CAP_WAL_SIZE', level, object: 'pg_xlog', problem: level === 'ok' ? okText : slotBad ? `${w.slotsInactive} 个复制槽不活跃，WAL 无法回收${i.filesAvailable ? `（${w.segments} 段 / ${gb(w.bytes)}）` : ''}` : `pg_xlog ${w.segments} 段 / ${gb(w.bytes)}，超过 ${T.walSegFactor} × checkpoint_segments(${w.checkpointSegments})`, advice: level === 'ok' ? '' : slotBad ? '确认下游是否还需要该槽，不需要则由 DBA 删除' : '检查归档/复制是否滞后；WAL 不能手删', evidence: `阈值 段数 > ${T.walSegFactor} × checkpoint_segments 或存在 inactive 槽` });
  }
  // ⑧ WDR
  {
    const w = i.wdr;
    const overdue = w.oldestAgeDays !== undefined && w.retentionDays > 0 && w.oldestAgeDays - w.retentionDays > T.wdr.overdueDays;
    const big = w.bytes >= T.wdr.maxBytes;
    const level: CapLevel = !w.enabled ? 'ok' : big || overdue ? 'notice' : 'ok';
    out.push({ rule: 'CAP_WDR_RETENTION', level, object: 'snapshot', problem: !w.enabled ? 'WDR 快照未开启，无占用' : level === 'ok' ? `WDR ${w.count} 个快照 ${gb(w.bytes)}，${w.retentionDays} 天保留生效` : big ? `WDR 快照 schema ${gb(w.bytes)}（${w.count} 个）偏大` : `最老快照 ${w.oldestAgeDays} 天，超过保留期 ${w.retentionDays} 天——清理线程可能没在跑`, advice: level === 'ok' ? '' : '核对 wdr_snapshot_retention_days 与快照清理是否正常', evidence: `阈值 体积 ≥${gb(T.wdr.maxBytes)} 或超期 >${T.wdr.overdueDays} 天` });
  }
  // ⑨ 运行日志
  {
    const l = i.log;
    const level: CapLevel = i.filesAvailable && !l.hasRetention && l.bytes >= T.logMaxBytes ? 'notice' : 'ok';
    const okText = i.filesAvailable ? `pg_log ${l.files} 个文件 ${gb(l.bytes)}${l.hasRetention ? '，有保留策略' : '，未超门槛'}` : 'pg_log 不可读（需初始账号）；openGauss 只按天轮转、没有最长保留参数，保留天数要靠外部策略';
    out.push({ rule: 'CAP_LOG_RETENTION', level, object: 'pg_log', problem: level === 'ok' ? okText : `pg_log ${l.files} 个文件 ${gb(l.bytes)}，只按天轮转、无最长保留${l.oldest !== undefined ? `（最老 ${l.oldest}）` : ''}`, advice: level === 'ok' ? '' : '定一条保留天数策略并纳入巡检（平台不代删）', evidence: `阈值 无保留策略且 ≥${gb(T.logMaxBytes)}` });
  }
  // ⑩ 采集空窗
  {
    const level: CapLevel = !i.firstRun && i.gapHours > T.collectGapHours ? 'notice' : 'ok';
    out.push({ rule: 'CAP_COLLECT_GAP', level, object: 'samples', problem: i.firstRun ? '首次采样，趋势自下次起累积' : level === 'ok' ? `采样连续（最近间隔 ${i.gapHours} h）` : `采集空窗 ${i.gapHours} h，增速外推置信度低`, advice: level === 'ok' ? '' : '检查任务是否被停用/删除；增速以空窗后的样本为准', evidence: `阈值 间隔 >${T.collectGapHours} h` });
  }
  return out.sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level]);
}

export function worstOf(findings: { level: CapLevel }[]): CapLevel {
  return findings.reduce<CapLevel>((acc, f) => (LEVEL_ORDER[f.level] > LEVEL_ORDER[acc] ? f.level : acc), 'ok');
}
export function countLevels(findings: { level: CapLevel }[]): Record<CapLevel, number> {
  const c: Record<CapLevel, number> = { ok: 0, notice: 0, warn: 0, critical: 0 };
  for (const f of findings) c[f.level] += 1;
  return c;
}
