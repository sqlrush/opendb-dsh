/**
 * WDR R2（2026-08-29 user 定稿 docs/prototypes/wdr-r2.html）：窗口增量的"全景"计算——AAS 24 窗口趋势、
 * 摘要卡 vs 上一窗口、AWR 式 Load Profile、多维 Top SQL、等待事件按类、IO / WAL / Checkpoint / 主机、
 * 实例效率、脚本生成的「一眼结论」、含通过项的检查清单。全部纯函数（输入 = 快照原始行），
 * tool-wdr-collect 负责取数并存档，面板直读存档；模型只写解读。阈值判定沿用 wdr.ts 的 judgeWindow（借鉴规则不动）。
 */

import { attributeSql, type TopSqlItem, type WdrThresholds, type WdrFinding, type WdrLevel, WDR_THRESHOLDS } from './wdr.ts';

const n = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const r2 = (x: number): number => Math.round(x * 100) / 100;
const r1 = (x: number): number => Math.round(x * 10) / 10;

export interface Snap { id: number; ts: string }

// ── 通用：按 snapshot_id 取一组行 / 求和 / 两快照增量 ───────────────────────────
export function pick<T extends { snapshot_id: unknown }>(rows: readonly T[], snap: number): T[] {
  return rows.filter((r) => n(r.snapshot_id) === snap);
}
export function sumBy<T extends { snapshot_id: unknown }>(rows: readonly T[], snap: number, key: keyof T): number {
  return pick(rows, snap).reduce((acc, r) => acc + n(r[key]), 0);
}
export function delta<T extends { snapshot_id: unknown }>(rows: readonly T[], begin: number, end: number, key: keyof T): number {
  return Math.max(0, sumBy(rows, end, key) - sumBy(rows, begin, key));
}

// ── AAS 趋势：连续快照对的 ΔDB_TIME / 墙钟 ─────────────────────────────────────
export interface InstRow { snapshot_id: unknown; snap_stat_name: unknown; snap_value: unknown }
export interface TrendPoint { beginSnap: number; endSnap: number; beginTs: string; endTs: string; secs: number; aas: number; cpu: number; io: number }

export function aasTrend(inst: readonly InstRow[], snaps: readonly Snap[]): TrendPoint[] {
  const stat = (snap: number, name: string): number => n(inst.find((r) => n(r.snapshot_id) === snap && s(r.snap_stat_name) === name)?.snap_value);
  const out: TrendPoint[] = [];
  for (let i = 1; i < snaps.length; i += 1) {
    const b = snaps[i - 1]; const e = snaps[i];
    const secs = Math.max(1, (new Date(e.ts).getTime() - new Date(b.ts).getTime()) / 1000);
    const d = (name: string) => Math.max(0, stat(e.id, name) - stat(b.id, name));
    out.push({ beginSnap: b.id, endSnap: e.id, beginTs: b.ts, endTs: e.ts, secs: Math.round(secs), aas: r2(d('DB_TIME') / 1e6 / secs), cpu: r2(d('CPU_TIME') / 1e6 / secs), io: r2(d('DATA_IO_TIME') / 1e6 / secs) });
  }
  return out;
}

/** DB Time 构成（含 PL）：CPU / IO / 网络 / 解析计划 / PL / 其他等待，share 相对 DB_TIME */
export interface Breakdown { totalUs: number; cpuUs: number; ioUs: number; execUs: number; classes: { name: string; us: number; share: number }[] }
export function dbTimeBreakdown(inst: readonly InstRow[], begin: number, end: number): Breakdown {
  const d = (name: string) => delta(inst.filter((r) => s(r.snap_stat_name) === name), begin, end, 'snap_value');
  const total = d('DB_TIME');
  const cpu = d('CPU_TIME'); const io = d('DATA_IO_TIME'); const net = d('NET_SEND_TIME');
  const parse = d('PARSE_TIME') + d('PLAN_TIME') + d('REWRITE_TIME'); const pl = d('PL_EXECUTION_TIME') + d('PL_COMPILATION_TIME');
  const other = Math.max(0, total - cpu - io - net - parse - pl);
  const mk = (name: string, us: number) => ({ name, us, share: total > 0 ? Math.round((us / total) * 1000) / 1000 : 0 });
  return { totalUs: total, cpuUs: cpu, ioUs: io, execUs: d('EXECUTION_TIME'), classes: [mk('CPU', cpu), mk('IO', io), mk('网络', net), mk('解析/计划', parse), mk('PL', pl), mk('其他等待', other)] };
}

// ── Top SQL（多维指标，面板按维度排序）──────────────────────────────────────────
export interface StmtRowFull {
  snapshot_id: unknown; snap_unique_sql_id: unknown; snap_query: unknown; snap_n_calls: unknown; snap_total_elapse_time: unknown;
  snap_cpu_time: unknown; snap_data_io_time: unknown; snap_n_returned_rows: unknown; snap_n_blocks_fetched: unknown; snap_n_blocks_hit: unknown;
  snap_sort_spill_size: unknown; snap_hash_spill_size?: unknown;
}
export interface TopSqlFull extends TopSqlItem {
  elapsedUs: number; cpuMs: number; ioMs: number; rowsRet: number; blocks: number; blocksHit: number; hitPct: number; spillBytes: number; probe: boolean;
}
/** 连接/心跳探针类语句：每小时几十万次、单次 0.1ms，排行榜上只会挡视线（面板可隐藏） */
const PROBE_RE = /^select\s+(version\(\)|current_user|current_schema(\(\))?|current_timestamp|now\(\)|pg_backend_pid\(\)|1)\s*;?$/i;
export function isProbe(text: string): boolean {
  return PROBE_RE.test(text.trim());
}
/** sort/hash_spill_size 原始值按字节算（与 Top SQL 报表同口径；og5 实测 Top1 累计 2.65 GB 与 temp_bytes 量级吻合，按 KB 会大三个量级） */
export function topSqlFull(rows: readonly StmtRowFull[], begin: number, end: number, maxItems = 40): { items: TopSqlFull[]; totalUs: number; count: number } {
  // 同一 unique_sql_id 可能因 user_name 出现多行：按 unique_sql_id 合并
  const agg = (snap: number) => {
    const m = new Map<string, { text: string; calls: number; el: number; cpu: number; io: number; rows: number; blocks: number; hit: number; spill: number }>();
    for (const r of pick(rows, snap)) {
      const id = s(r.snap_unique_sql_id);
      const cur = m.get(id) ?? { text: s(r.snap_query), calls: 0, el: 0, cpu: 0, io: 0, rows: 0, blocks: 0, hit: 0, spill: 0 };
      m.set(id, { text: cur.text !== '' ? cur.text : s(r.snap_query), calls: cur.calls + n(r.snap_n_calls), el: cur.el + n(r.snap_total_elapse_time), cpu: cur.cpu + n(r.snap_cpu_time), io: cur.io + n(r.snap_data_io_time), rows: cur.rows + n(r.snap_n_returned_rows), blocks: cur.blocks + n(r.snap_n_blocks_fetched), hit: cur.hit + n(r.snap_n_blocks_hit), spill: cur.spill + n(r.snap_sort_spill_size) + n(r.snap_hash_spill_size) });
    }
    return m;
  };
  const b = agg(begin); const e = agg(end);
  const items: TopSqlFull[] = [];
  for (const [id, er] of e) {
    const br = b.get(id);
    const d = (k: 'calls' | 'el' | 'cpu' | 'io' | 'rows' | 'blocks' | 'hit' | 'spill') => Math.max(0, er[k] - (br?.[k] ?? 0));
    const elapsedUs = d('el'); const calls = d('calls');
    if (elapsedUs <= 0 && calls <= 0) continue;
    const cpuUs = d('cpu'); const ioUs = d('io'); const spillBytes = d('spill'); const spillKb = Math.round(spillBytes / 1024); const blocks = d('blocks'); const hit = d('hit');
    items.push({
      sqlId: id, text: er.text.slice(0, 1200), calls, elapsedUs, elapsedMs: Math.round(elapsedUs / 1000), avgMs: calls > 0 ? Math.round((elapsedUs / calls / 1000) * 100) / 100 : Math.round(elapsedUs / 1000),
      cpuPct: elapsedUs > 0 ? Math.min(100, Math.round((cpuUs / elapsedUs) * 100)) : 0, ioPct: elapsedUs > 0 ? Math.min(100, Math.round((ioUs / elapsedUs) * 100)) : 0,
      spillKb, spillBytes, attr: attributeSql(elapsedUs, cpuUs, ioUs, spillKb), share: 0,
      cpuMs: Math.round(cpuUs / 1000), ioMs: Math.round(ioUs / 1000), rowsRet: d('rows'), blocks, blocksHit: hit, hitPct: blocks > 0 ? Math.round((hit / blocks) * 1000) / 10 : 100, probe: isProbe(er.text),
    });
  }
  const totalUs = items.reduce((acc, i) => acc + i.elapsedUs, 0);
  const sorted = items.sort((x, y) => y.elapsedUs - x.elapsedUs).slice(0, maxItems)
    .map((it) => ({ ...it, share: totalUs > 0 ? Math.round((it.elapsedUs / totalUs) * 1000) / 1000 : 0 }));
  return { items: sorted, totalUs, count: items.length };
}

// ── 等待事件（按类 + Top，含次数/均耗）────────────────────────────────────────
export interface WaitRowFull { snapshot_id: unknown; snap_type: unknown; snap_event: unknown; snap_total_wait_time: unknown; snap_wait: unknown }
export interface WaitItem { type: string; event: string; waitUs: number; count: number; avgUs: number; share: number }
export interface Waits { totalUs: number; classes: { type: string; us: number; share: number }[]; top: WaitItem[] }
export function waitsFull(rows: readonly WaitRowFull[], begin: number, end: number, topN = 10): Waits {
  const key = (r: WaitRowFull) => `${s(r.snap_type)}|${s(r.snap_event)}`;
  const b = new Map(pick(rows, begin).map((r) => [key(r), r]));
  const items: WaitItem[] = [];
  for (const r of pick(rows, end)) {
    if (s(r.snap_type) === 'STATUS') continue;
    const br = b.get(key(r));
    const us = Math.max(0, n(r.snap_total_wait_time) - n(br?.snap_total_wait_time));
    const count = Math.max(0, n(r.snap_wait) - n(br?.snap_wait));
    if (us <= 0) continue;
    items.push({ type: s(r.snap_type), event: s(r.snap_event), waitUs: us, count, avgUs: count > 0 ? Math.round(us / count) : 0, share: 0 });
  }
  const totalUs = items.reduce((acc, i) => acc + i.waitUs, 0);
  const byType = new Map<string, number>();
  for (const i of items) byType.set(i.type, (byType.get(i.type) ?? 0) + i.waitUs);
  const classes = [...byType.entries()].map(([type, us]) => ({ type, us, share: totalUs > 0 ? Math.round((us / totalUs) * 1000) / 1000 : 0 })).sort((x, y) => y.us - x.us);
  const top = items.sort((x, y) => y.waitUs - x.waitUs).slice(0, topN).map((i) => ({ ...i, share: totalUs > 0 ? Math.round((i.waitUs / totalUs) * 1000) / 1000 : 0 }));
  return { totalUs, classes, top };
}

// ── 窗口原始量（采集器按两快照增量拼出，Load Profile / 摘要 / 效率 / 结论都从它算）──
export interface WindowRaw {
  secs: number;
  db: { commits: number; rollbacks: number; blksRead: number; blksHit: number; tupReturned: number; tupFetched: number; ins: number; upd: number; del: number; tempFiles: number; tempBytes: number; deadlocks: number; backends: number };
  inst: { dbTimeUs: number; cpuUs: number; execUs: number };
  sqlExecs: number;
  wal: { writes: number; blocks: number; writeUs: number; maxUs: number };
  fileio: { reads: number; writes: number; readUs: number; writeUs: number };
  bgw: { timed: number; req: number; writeMs: number; syncMs: number; bufCkpt: number; bufClean: number; bufBackend: number };
}

// ── Load Profile（AWR 式）────────────────────────────────────────────────────
export type LpUnit = 'us' | 'count' | 'bytes';
export interface LpRow { key: string; label: string; unit: LpUnit; total: number; perSec: number; perTxn: number; prevPerSec: number | null; ratio: number | null }
export function loadProfile(cur: WindowRaw, prev?: WindowRaw): LpRow[] {
  const txns = Math.max(1, cur.db.commits + cur.db.rollbacks);
  const row = (key: string, label: string, unit: LpUnit, total: number, prevTotal?: number): LpRow => {
    const perSec = total / Math.max(1, cur.secs);
    const prevPerSec = prev !== undefined && prevTotal !== undefined ? prevTotal / Math.max(1, prev.secs) : null;
    const ratio = prevPerSec !== null && prevPerSec > 0 ? r2(perSec / prevPerSec) : null;
    return { key, label, unit, total, perSec: r2(perSec), perTxn: r2(total / txns), prevPerSec: prevPerSec !== null ? r2(prevPerSec) : null, ratio };
  };
  return [
    row('dbtime', 'DB Time', 'us', cur.inst.dbTimeUs, prev?.inst.dbTimeUs),
    row('cpu', 'CPU 时间', 'us', cur.inst.cpuUs, prev?.inst.cpuUs),
    row('exec', '执行时间', 'us', cur.inst.execUs, prev?.inst.execUs),
    row('logical', '逻辑读（块）', 'count', cur.db.blksRead + cur.db.blksHit, prev !== undefined ? prev.db.blksRead + prev.db.blksHit : undefined),
    row('physical', '物理读（块）', 'count', cur.db.blksRead, prev?.db.blksRead),
    row('walBytes', 'WAL 写字节', 'bytes', cur.wal.blocks * 8192, prev !== undefined ? prev.wal.blocks * 8192 : undefined),
    row('walWrites', 'WAL 写次数', 'count', cur.wal.writes, prev?.wal.writes),
    row('xacts', '事务（提交 + 回滚）', 'count', cur.db.commits + cur.db.rollbacks, prev !== undefined ? prev.db.commits + prev.db.rollbacks : undefined),
    row('rollbacks', '回滚', 'count', cur.db.rollbacks, prev?.db.rollbacks),
    row('execs', 'SQL 执行', 'count', cur.sqlExecs, prev?.sqlExecs),
    row('tupReturned', '元组返回', 'count', cur.db.tupReturned, prev?.db.tupReturned),
    row('tupFetched', '元组取出', 'count', cur.db.tupFetched, prev?.db.tupFetched),
    row('ins', '插入', 'count', cur.db.ins, prev?.db.ins),
    row('upd', '更新', 'count', cur.db.upd, prev?.db.upd),
    row('del', '删除', 'count', cur.db.del, prev?.db.del),
    row('tempFiles', '临时文件数', 'count', cur.db.tempFiles, prev?.db.tempFiles),
    row('tempBytes', '临时文件字节', 'bytes', cur.db.tempBytes, prev?.db.tempBytes),
  ];
}

// ── 主机 / 效率 / 摘要卡 ─────────────────────────────────────────────────────
export interface OsRow { snapshot_id: unknown; snap_name: unknown; snap_value: unknown }
export interface HostStat { load: number; cores: number; memBytes: number; busyPct: number; userPct: number; sysPct: number; iowaitPct: number }
export function hostStat(rows: readonly OsRow[], begin: number, end: number): HostStat {
  const cur = (name: string) => n(rows.find((r) => n(r.snapshot_id) === end && s(r.snap_name) === name)?.snap_value);
  const d = (name: string) => delta(rows.filter((r) => s(r.snap_name) === name), begin, end, 'snap_value');
  const busy = d('BUSY_TIME'); const idle = d('IDLE_TIME'); const tot = busy + idle;
  const pct = (x: number) => (tot > 0 ? r1((x / tot) * 100) : 0);
  return { load: r2(cur('LOAD')), cores: cur('NUM_CPUS'), memBytes: cur('PHYSICAL_MEMORY_BYTES'), busyPct: pct(busy), userPct: pct(d('USER_TIME')), sysPct: pct(d('SYS_TIME')), iowaitPct: pct(d('IOWAIT_TIME')) };
}

export interface Efficiency { hitRatio: number; cpuShare: number; execShare: number; rollbackRatio: number; p80Ms: number | null; p95Ms: number | null }
export function efficiency(cur: WindowRaw, pct?: { p80: number; p95: number }): Efficiency {
  const lr = cur.db.blksRead + cur.db.blksHit; const tx = cur.db.commits + cur.db.rollbacks;
  return {
    hitRatio: lr > 0 ? Math.round((cur.db.blksHit / lr) * 10000) / 10000 : 1,
    cpuShare: cur.inst.dbTimeUs > 0 ? Math.round((cur.inst.cpuUs / cur.inst.dbTimeUs) * 1000) / 1000 : 0,
    execShare: cur.inst.dbTimeUs > 0 ? Math.round((cur.inst.execUs / cur.inst.dbTimeUs) * 1000) / 1000 : 0,
    rollbackRatio: tx > 0 ? Math.round((cur.db.rollbacks / tx) * 10000) / 10000 : 0,
    p80Ms: pct !== undefined ? r2(pct.p80 / 1000) : null, p95Ms: pct !== undefined ? r2(pct.p95 / 1000) : null,
  };
}

/** 摘要卡（8 张）：本窗口值 + 上一窗口同口径值，箭头由面板算 */
export interface Summary {
  dbTimeS: number; prevDbTimeS: number | null; aas: number; prevAas: number | null; cores: number;
  tps: number; prevTps: number | null; hitRatio: number; prevHitRatio: number | null;
  physReadsPerSec: number; prevPhysReadsPerSec: number | null;
  tempBytes: number; tempBytesPerSec: number; prevTempBytesPerSec: number | null;
  walBytesPerSec: number; prevWalBytesPerSec: number | null;
  ckptTimed: number; ckptReq: number; ckptBufBytes: number; backends: number;
}
export function summaryOf(cur: WindowRaw, prev: WindowRaw | undefined, cores: number): Summary {
  const secs = Math.max(1, cur.secs); const psecs = prev !== undefined ? Math.max(1, prev.secs) : 1;
  const p = <T>(f: (w: WindowRaw) => T): T | null => (prev !== undefined ? f(prev) : null);
  return {
    dbTimeS: Math.round(cur.inst.dbTimeUs / 1e6), prevDbTimeS: p((w) => Math.round(w.inst.dbTimeUs / 1e6)),
    aas: r2(cur.inst.dbTimeUs / 1e6 / secs), prevAas: p((w) => r2(w.inst.dbTimeUs / 1e6 / psecs)), cores,
    tps: r1((cur.db.commits + cur.db.rollbacks) / secs), prevTps: p((w) => r1((w.db.commits + w.db.rollbacks) / psecs)),
    hitRatio: efficiency(cur).hitRatio, prevHitRatio: p((w) => efficiency(w).hitRatio),
    physReadsPerSec: Math.round(cur.db.blksRead / secs), prevPhysReadsPerSec: p((w) => Math.round(w.db.blksRead / psecs)),
    tempBytes: cur.db.tempBytes, tempBytesPerSec: Math.round(cur.db.tempBytes / secs), prevTempBytesPerSec: p((w) => Math.round(w.db.tempBytes / psecs)),
    walBytesPerSec: Math.round((cur.wal.blocks * 8192) / secs), prevWalBytesPerSec: p((w) => Math.round((w.wal.blocks * 8192) / psecs)),
    ckptTimed: cur.bgw.timed, ckptReq: cur.bgw.req, ckptBufBytes: cur.bgw.bufCkpt * 8192, backends: cur.db.backends,
  };
}

// ── 检查清单：阈值判定 + 通过项（面板「发现」区把过线和没过线的都列出来）────────────
export interface CheckRow { code: string; dim: string; level: WdrLevel; detail: string; value: string; threshold: string; evidence: string }
export function checksOf(findings: readonly WdrFinding[], m: { aas: number; tempBytes: number; hitRatio: number; ckptTimed: number; ckptReq: number; rollbackRatio: number; blkShare: number; deadlocks: number }, T: WdrThresholds = WDR_THRESHOLDS): CheckRow[] {
  const ck = m.ckptTimed + m.ckptReq;
  const passed: Record<string, Omit<CheckRow, 'code' | 'level'>> = {
    WDR_LOAD_HIGH: { dim: 'load', detail: `平均活跃会话 ${m.aas}，窗口负载在阈值内`, value: String(m.aas), threshold: `>=${T.avgActive.notice}`, evidence: '' },
    WDR_TEMP_SPILL: { dim: 'temp', detail: `窗口临时文件 ${fmtBytes(m.tempBytes)}，未达下盘关注线`, value: fmtBytes(m.tempBytes), threshold: `>=${fmtBytes(T.tempBytes.notice)}`, evidence: '' },
    WDR_CACHE_LOW: { dim: 'cache', detail: `窗口命中率 ${(m.hitRatio * 100).toFixed(2)}%，物理读正常`, value: `${(m.hitRatio * 100).toFixed(2)}%`, threshold: `<${(T.cacheHit.notice * 100).toFixed(0)}%`, evidence: '' },
    WDR_DEADLOCK: { dim: 'lock', detail: '窗口内无死锁', value: '0', threshold: '>0', evidence: '' },
    WDR_ROLLBACK_HIGH: { dim: 'xact', detail: `回滚率 ${(m.rollbackRatio * 100).toFixed(2)}%，事务面健康`, value: `${(m.rollbackRatio * 100).toFixed(2)}%`, threshold: `>=${(T.rollbackRatio.notice * 100).toFixed(0)}%`, evidence: '' },
    WDR_CKPT_REQ: { dim: 'ckpt', detail: ck > 0 ? `被动 checkpoint ${m.ckptReq} / ${ck}——WAL 压力正常` : '窗口内没有 checkpoint', value: ck > 0 ? `${Math.round((m.ckptReq / ck) * 100)}%` : '—', threshold: `>=${(T.ckptReqShare.notice * 100).toFixed(0)}%`, evidence: '' },
    WDR_SQL_BLOCKED: { dim: 'topsql', detail: '没有 elapsed 高而 cpu/io 双低的等待型 SQL——无锁链迹象', value: `${Math.round(m.blkShare * 100)}%`, threshold: `>=${(T.blkSqlShare.warn * 100).toFixed(0)}%`, evidence: '' },
  };
  const out: CheckRow[] = [];
  for (const code of Object.keys(passed)) {
    const hits = findings.filter((f) => f.code === code);
    if (hits.length > 0) for (const f of hits) out.push({ code, dim: f.dim, level: f.level, detail: f.detail, value: String(f.value), threshold: f.threshold, evidence: f.evidence });
    else out.push({ code, level: 'ok', ...passed[code] });
  }
  return out;
}

// ── 一眼结论（脚本按增量生成）──────────────────────────────────────────────────
export interface Insight { level: 'warn' | 'notice' | 'ok'; text: string }
export function insightsOf(input: { cur: WindowRaw; prev?: WindowRaw; trend: TrendPoint[]; breakdown: Breakdown; waits: Waits; host: HostStat }, T: WdrThresholds = WDR_THRESHOLDS): Insight[] {
  const { cur, prev, trend, breakdown, waits, host } = input;
  const out: Insight[] = [];
  const aas = r2(cur.inst.dbTimeUs / 1e6 / Math.max(1, cur.secs));
  const prevAas = prev !== undefined ? r2(prev.inst.dbTimeUs / 1e6 / Math.max(1, prev.secs)) : null;
  const others = trend.slice(0, -1).map((t) => t.aas).filter((x) => x > 0).sort((a, b) => a - b);
  const median = others.length > 0 ? others[Math.floor(others.length / 2)] : 0;
  const isMax = trend.length > 1 && trend.slice(0, -1).every((t) => t.aas <= aas);
  const waitShare = breakdown.classes.find((c) => c.name === '其他等待')?.share ?? 0;
  const cpuShare = breakdown.classes.find((c) => c.name === 'CPU')?.share ?? 0;
  if (aas >= T.avgActive.notice) {
    out.push({ level: aas >= T.avgActive.warn ? 'warn' : 'notice', text: `${isMax ? `这 ${Math.round(cur.secs / 60)} 分钟是最近 ${trend.length} 个窗口里最重的：` : ''}AAS ${aas}${median > 0 ? `，是中位 ${median} 的 ${r1(aas / median)} 倍` : ''}${prevAas !== null && prevAas > 0 ? `、上一窗口的 ${r1(aas / prevAas)} 倍` : ''}；等待占 DB Time ${Math.round(waitShare * 100)}%，CPU ${Math.round(cpuShare * 100)}%` });
  } else {
    out.push({ level: 'ok', text: `窗口负载低：AAS ${aas}${prevAas !== null ? `（上一窗口 ${prevAas}）` : ''}，${host.cores > 0 ? `${host.cores} 核` : ''}主机 CPU 忙 ${host.busyPct}%` });
  }
  const bufFile = waits.top.filter((w) => /^BufFile/.test(w.event)).reduce((acc, w) => acc + w.waitUs, 0);
  if (waits.totalUs > 0 && bufFile / waits.totalUs >= 0.3) {
    out.push({ level: cur.db.tempBytes >= T.tempBytes.warn ? 'warn' : 'notice', text: `下盘主导等待：BufFileWrite/Read 合计 ${Math.round(bufFile / 1e6)} s，占非空闲等待 ${Math.round((bufFile / waits.totalUs) * 100)}%，与窗口 ${fmtBytes(cur.db.tempBytes)} 临时文件互证——work_mem 不足或哈希聚合过大` });
  } else if (waits.classes.length > 0) {
    const c = waits.classes[0]; const top = waits.top[0];
    out.push({ level: c.type === 'LOCK_EVENT' && c.share >= 0.3 ? 'warn' : 'ok', text: `非空闲等待 ${Math.round(waits.totalUs / 1e6)} s，${c.type} 占 ${Math.round(c.share * 100)}%${top !== undefined ? `，最大事件 ${top.event}（${Math.round(top.waitUs / 1e6)} s）` : ''}` });
  }
  if (prev !== undefined) {
    const prevReads = prev.db.blksRead / Math.max(1, prev.secs); const curReads = cur.db.blksRead / Math.max(1, cur.secs);
    const hit = efficiency(cur).hitRatio; const prevHit = efficiency(prev).hitRatio;
    if (prevReads > 0 && curReads / prevReads >= 3) out.push({ level: hit < T.cacheHit.warn ? 'warn' : 'notice', text: `物理读 ×${r1(curReads / prevReads)}（${Math.round(curReads)} 块/s，上窗 ${Math.round(prevReads)}），命中率 ${(prevHit * 100).toFixed(2)}% → ${(hit * 100).toFixed(2)}%` });
    const tps = (cur.db.commits + cur.db.rollbacks) / Math.max(1, cur.secs); const ptps = (prev.db.commits + prev.db.rollbacks) / Math.max(1, prev.secs);
    if (ptps > 0) {
      const chg = (tps - ptps) / ptps;
      out.push({ level: 'ok', text: Math.abs(chg) < 0.1
        ? `事务面平稳：TPS ${r1(tps)}/s 与上窗持平，回滚 ${(efficiency(cur).rollbackRatio * 100).toFixed(2)}%，Checkpoint ${cur.bgw.req > 0 ? `被动 ${cur.bgw.req} 次` : '全部定时'}${aas >= T.avgActive.notice ? '——瓶颈在分析型 SQL，不在 OLTP' : ''}`
        : `TPS ${chg > 0 ? '上升' : '下降'} ${Math.round(Math.abs(chg) * 100)}%（${r1(tps)}/s，上窗 ${r1(ptps)}/s），回滚 ${(efficiency(cur).rollbackRatio * 100).toFixed(2)}%` });
    }
  }
  if (cur.bgw.req > 0 && cur.bgw.req / Math.max(1, cur.bgw.req + cur.bgw.timed) >= T.ckptReqShare.notice) out.push({ level: 'notice', text: `被动 checkpoint ${cur.bgw.req} / ${cur.bgw.req + cur.bgw.timed}——WAL 压力偏大` });
  return out.slice(0, 5);
}

export function fmtBytes(b: number): string {
  if (b >= 1 << 30) return `${(b / (1 << 30)).toFixed(1)} GB`;
  if (b >= 1 << 20) return `${(b / (1 << 20)).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${Math.round(b)} B`;
}
