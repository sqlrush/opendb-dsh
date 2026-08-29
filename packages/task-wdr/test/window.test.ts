import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aasTrend, dbTimeBreakdown, topSqlFull, isProbe, waitsFull, loadProfile, hostStat, efficiency, summaryOf, checksOf, insightsOf, judgeWindow,
} from '../src/index.ts';
import type { WindowRaw } from '../src/index.ts';

const inst = (snap: number, DB_TIME: number, CPU_TIME: number, DATA_IO_TIME: number, extra: Record<string, number> = {}) =>
  Object.entries({ DB_TIME, CPU_TIME, DATA_IO_TIME, ...extra }).map(([snap_stat_name, snap_value]) => ({ snapshot_id: snap, snap_stat_name, snap_value }));

test('aasTrend：连续快照对的 AAS / CPU / IO（µs → 每秒活跃会话）', () => {
  const snaps = [{ id: 1, ts: '2026-08-29T01:00:00Z' }, { id: 2, ts: '2026-08-29T02:00:00Z' }, { id: 3, ts: '2026-08-29T02:10:00Z' }];
  const rows = [...inst(1, 0, 0, 0), ...inst(2, 3600e6, 1800e6, 360e6), ...inst(3, 3600e6 + 6000e6, 1800e6 + 1200e6, 360e6 + 600e6)];
  const t = aasTrend(rows, snaps);
  assert.equal(t.length, 2);
  assert.deepEqual([t[0].aas, t[0].cpu, t[0].io, t[0].secs], [1, 0.5, 0.1, 3600]);
  assert.deepEqual([t[1].aas, t[1].cpu, t[1].io, t[1].secs], [10, 2, 1, 600]);
});

test('dbTimeBreakdown：六类构成含 PL，其他等待 = 余量', () => {
  const rows = [...inst(1, 0, 0, 0, { NET_SEND_TIME: 0, PARSE_TIME: 0, PL_EXECUTION_TIME: 0, EXECUTION_TIME: 0 }),
    ...inst(2, 1000, 200, 100, { NET_SEND_TIME: 50, PARSE_TIME: 30, PL_EXECUTION_TIME: 20, EXECUTION_TIME: 800 })];
  const b = dbTimeBreakdown(rows, 1, 2);
  assert.equal(b.totalUs, 1000);
  assert.equal(b.execUs, 800);
  assert.equal(b.classes.find((c) => c.name === 'PL')?.us, 20);
  assert.equal(b.classes.find((c) => c.name === '其他等待')?.us, 600);
  assert.equal(b.classes.find((c) => c.name === 'CPU')?.share, 0.2);
});

test('topSqlFull：多维增量 + 探针识别 + 下盘按字节 + 同 id 多行合并', () => {
  const row = (snapshot_id: number, id: string, q: string, calls: number, el: number, cpu: number, io: number, rows: number, blk: number, hit: number, sort: number, hash: number) =>
    ({ snapshot_id, snap_unique_sql_id: id, snap_query: q, snap_n_calls: calls, snap_total_elapse_time: el, snap_cpu_time: cpu, snap_data_io_time: io, snap_n_returned_rows: rows, snap_n_blocks_fetched: blk, snap_n_blocks_hit: hit, snap_sort_spill_size: sort, snap_hash_spill_size: hash });
  const rows = [
    row(1, 'a', 'SELECT sum(x) FROM t GROUP BY y', 10, 100e6, 20e6, 25e6, 1000, 10000, 9000, 0, 0),
    row(2, 'a', 'SELECT sum(x) FROM t GROUP BY y', 82, 1424e6, 282e6, 358e6, 14000, 22500, 21000, 0, 16 * 1024 * 1024),
    row(2, 'p', 'select version();', 378984, 41.8e6, 41.8e6, 0, 378984, 758000, 758000, 0, 0),
    // 同一 id 因用户名拆成两行：合并
    row(2, 'u', 'select 2', 5, 1e6, 1e6, 0, 5, 0, 0, 0, 0), row(2, 'u', 'select 2', 7, 2e6, 2e6, 0, 7, 0, 0, 0, 0),
  ];
  const r = topSqlFull(rows, 1, 2, 10);
  assert.equal(r.count, 3);
  const a = r.items[0];
  assert.equal(a.sqlId, 'a');
  assert.equal(a.calls, 72);
  assert.equal(a.elapsedMs, 1324000);
  assert.equal(a.avgMs, 18388.89);
  assert.equal(a.spillBytes, 16 * 1024 * 1024);
  assert.equal(a.spillKb, 16384);
  assert.equal(a.attr, 'tmp');
  assert.equal(a.blocks, 12500);
  assert.equal(a.hitPct, 96);
  assert.equal(a.probe, false);
  assert.equal(r.items.find((i) => i.sqlId === 'p')?.probe, true);
  assert.equal(r.items.find((i) => i.sqlId === 'u')?.calls, 12);
  assert.equal(r.totalUs, 1324e6 + 41.8e6 + 3e6);
  assert.ok(Math.abs(r.items.reduce((s, i) => s + i.share, 0) - 1) < 0.01);
});

test('isProbe：探针语句集合', () => {
  for (const t of ['select version();', 'SELECT current_user', ' select 1 ', 'select now()']) assert.equal(isProbe(t), true, t);
  for (const t of ['select 1 from t', 'select version(), now()', 'SELECT count(*) FROM x']) assert.equal(isProbe(t), false, t);
});

test('waitsFull：剔除 STATUS，按类汇总，Top 含次数与均耗', () => {
  const w = (snapshot_id: number, type: string, ev: string, us: number, cnt: number) => ({ snapshot_id, snap_type: type, snap_event: ev, snap_total_wait_time: us, snap_wait: cnt });
  const rows = [
    w(1, 'IO_EVENT', 'BufFileWrite', 100e6, 1000), w(2, 'IO_EVENT', 'BufFileWrite', 332e6, 2251000),
    w(2, 'IO_EVENT', 'DataFileRead', 63.7e6, 1950000),
    w(2, 'LWLOCK_EVENT', 'BufferIOLock', 16.2e6, 7715),
    w(2, 'STATUS', 'wait cmd', 99999e6, 1),
  ];
  const r = waitsFull(rows, 1, 2, 10);
  assert.equal(r.top.length, 3);
  assert.equal(r.top[0].event, 'BufFileWrite');
  assert.equal(r.top[0].waitUs, 232e6);
  assert.equal(r.top[0].count, 2250000);
  assert.equal(r.top[0].avgUs, 103);
  assert.equal(r.classes[0].type, 'IO_EVENT');
  assert.ok(r.classes[0].share > 0.9);
  assert.equal(r.totalUs, 232e6 + 63.7e6 + 16.2e6);
});

const raw = (secs: number, dbTimeUs: number, o: Partial<WindowRaw['db']> = {}, extra: Partial<WindowRaw> = {}): WindowRaw => ({
  secs,
  db: { commits: 14575, rollbacks: 21, blksRead: 2024998, blksHit: 29436854, tupReturned: 1.29e9, tupFetched: 484000, ins: 33272, upd: 89, del: 31338, tempFiles: 4357, tempBytes: 19.3 * 1024 ** 3, deadlocks: 0, backends: 18, ...o },
  inst: { dbTimeUs, cpuUs: 1131e6, execUs: 4544e6 },
  sqlExecs: 760000,
  wal: { writes: 2453, blocks: 3891, writeUs: 1.58e6, maxUs: 495000 },
  fileio: { reads: 1950000, writes: 24600, readUs: 64e6, writeUs: 1.2e6 },
  bgw: { timed: 8, req: 0, writeMs: 0, syncMs: 0, bufCkpt: 1723, bufClean: 0, bufBackend: 0 },
  ...extra,
});

test('loadProfile：每秒 / 每事务 / 合计 / 上窗每秒 / 变化倍数', () => {
  const cur = raw(537, 5803e6);
  const prev = raw(3060, 2972e6, { blksRead: 1242000, commits: 84600, rollbacks: 100 });
  const lp = loadProfile(cur, prev);
  const db = lp.find((r) => r.key === 'dbtime')!;
  assert.equal(db.perSec, 10806331.47);   // µs / s
  assert.equal(db.prevPerSec, 971241.83);
  assert.equal(db.ratio, 11.13);
  assert.equal(db.perTxn, Math.round((5803e6 / 14596) * 100) / 100);
  const wal = lp.find((r) => r.key === 'walBytes')!;
  assert.equal(wal.total, 3891 * 8192);
  assert.equal(loadProfile(cur).find((r) => r.key === 'physical')?.prevPerSec, null);
});

test('hostStat / efficiency / summaryOf', () => {
  const os = (snapshot_id: number, name: string, v: number) => ({ snapshot_id, snap_name: name, snap_value: v });
  const rows = [os(1, 'BUSY_TIME', 1000), os(2, 'BUSY_TIME', 1181), os(1, 'IDLE_TIME', 5000), os(2, 'IDLE_TIME', 5819), os(1, 'USER_TIME', 0), os(2, 'USER_TIME', 160), os(1, 'SYS_TIME', 0), os(2, 'SYS_TIME', 21), os(1, 'IOWAIT_TIME', 0), os(2, 'IOWAIT_TIME', 1), os(2, 'LOAD', 6.31), os(2, 'NUM_CPUS', 18), os(2, 'PHYSICAL_MEMORY_BYTES', 67e9)];
  const h = hostStat(rows, 1, 2);
  assert.deepEqual([h.busyPct, h.userPct, h.sysPct, h.iowaitPct, h.cores, h.load], [18.1, 16, 2.1, 0.1, 18, 6.31]);
  const cur = raw(537, 5803e6);
  const e = efficiency(cur, { p80: 4500, p95: 5900 });
  assert.equal(e.hitRatio, 0.9356);
  assert.equal(e.cpuShare, 0.195);
  assert.equal(e.execShare, 0.783);
  assert.equal(e.rollbackRatio, 0.0014);
  assert.deepEqual([e.p80Ms, e.p95Ms], [4.5, 5.9]);
  const sm = summaryOf(cur, raw(3060, 2972e6, { blksRead: 1242000 }), 18);
  assert.equal(sm.aas, 10.81);
  assert.equal(sm.prevAas, 0.97);
  assert.equal(sm.physReadsPerSec, 3771);
  assert.equal(sm.prevPhysReadsPerSec, 406);
  assert.equal(sm.ckptBufBytes, 1723 * 8192);
  assert.equal(summaryOf(cur, undefined, 0).prevTps, null);
});

test('checksOf：判定命中的按 finding 列出，其余以 ok 通过项补齐（7 条）', () => {
  const findings = judgeWindow({ windowMinutes: 9, dbTimeUs: 5803e6, dbStats: [{ db: 'postgres', commits: 14575, rollbacks: 21, blksRead: 2024998, blksHit: 29436854, tempBytes: 19.3 * 1024 ** 3, deadlocks: 0, hitRatio: 0.9356 }], ckpt: { timed: 8, req: 0 }, topSql: [] });
  const rows = checksOf(findings, { aas: 10.82, tempBytes: 19.3 * 1024 ** 3, hitRatio: 0.9356, ckptTimed: 8, ckptReq: 0, rollbackRatio: 0.0014, blkShare: 0, deadlocks: 0 });
  assert.equal(rows.length, 7);
  assert.equal(rows.find((r) => r.code === 'WDR_LOAD_HIGH')?.level, 'warn');
  assert.equal(rows.find((r) => r.code === 'WDR_TEMP_SPILL')?.level, 'warn');
  assert.equal(rows.find((r) => r.code === 'WDR_CACHE_LOW')?.level, 'warn');
  assert.equal(rows.find((r) => r.code === 'WDR_CKPT_REQ')?.level, 'ok');
  assert.match(rows.find((r) => r.code === 'WDR_CKPT_REQ')!.detail, /0 \/ 8/);
  assert.equal(rows.find((r) => r.code === 'WDR_SQL_BLOCKED')?.level, 'ok');
});

test('insightsOf：最重窗口 + 下盘主导 + 物理读倍增 + 事务面平稳', () => {
  const cur = raw(537, 5803e6);
  const prev = raw(3060, 2972e6, { blksRead: 1242000, commits: 84600, rollbacks: 100 });
  const trend = [{ beginSnap: 1, endSnap: 2, beginTs: '', endTs: '', secs: 3600, aas: 0.2, cpu: 0.2, io: 0 }, { beginSnap: 2, endSnap: 3, beginTs: '', endTs: '', secs: 3600, aas: 0.97, cpu: 0.34, io: 0.07 }, { beginSnap: 3, endSnap: 4, beginTs: '', endTs: '', secs: 537, aas: 10.81, cpu: 2.11, io: 0.81 }];
  const breakdown = dbTimeBreakdown([...inst(3, 0, 0, 0), ...inst(4, 5803e6, 1131e6, 437e6)], 3, 4);
  const waits = waitsFull([
    { snapshot_id: 4, snap_type: 'IO_EVENT', snap_event: 'BufFileWrite', snap_total_wait_time: 232e6, snap_wait: 2250000 },
    { snapshot_id: 4, snap_type: 'IO_EVENT', snap_event: 'BufFileRead', snap_total_wait_time: 95e6, snap_wait: 2240000 },
    { snapshot_id: 4, snap_type: 'IO_EVENT', snap_event: 'DataFileRead', snap_total_wait_time: 64e6, snap_wait: 1950000 },
  ], 3, 4);
  const host = { load: 6.31, cores: 18, memBytes: 0, busyPct: 18.1, userPct: 16, sysPct: 2.1, iowaitPct: 0.1 };
  const ins = insightsOf({ cur, prev, trend, breakdown, waits, host });
  assert.equal(ins[0].level, 'warn');
  assert.match(ins[0].text, /最近 3 个窗口里最重/);
  assert.match(ins[0].text, /上一窗口的 11\.1 倍/);
  assert.match(ins[1].text, /下盘主导等待/);
  assert.match(ins[2].text, /物理读 ×9\.3/);
  assert.match(ins[3].text, /事务面平稳/);
  // 低负载窗口：ok 口吻
  const quiet = insightsOf({ cur: raw(3600, 720e6), trend: trend.slice(0, 2), breakdown: dbTimeBreakdown([...inst(1, 0, 0, 0), ...inst(2, 720e6, 700e6, 0)], 1, 2), waits: waitsFull([], 1, 2), host });
  assert.equal(quiet[0].level, 'ok');
  assert.match(quiet[0].text, /窗口负载低/);
});
