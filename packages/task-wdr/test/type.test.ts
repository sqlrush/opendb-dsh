import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WDR_TASK_TYPE, deltaInstanceTime, dbTimeClasses, deltaTopSql, deltaStatDatabase, deltaWaits, judgeWindow, attributeSql, worstOf } from '../src/index.ts';

test('configSchema 默认值', () => {
  const cfg = WDR_TASK_TYPE.configSchema({});
  assert.equal(cfg.beginSnap, 0);
  assert.equal(cfg.topN, 10);
});

test('reportSchema 拒绝缺 window/det/topSql', () => {
  assert.throws(() => WDR_TASK_TYPE.reportSchema({ scope: 'wdr-window', node: 'og5' }));
});

test('buildPrompt 锚定纪律 + 只读铁律', async () => {
  const ctx = { nodesOf: async () => [{ id: '1', name: 'og5', engine: 'opengauss', host: 'h', port: 1, dbname: 'postgres', status: 'online' }] } as any;
  const task = { id: 't', tenantId: 'default', agentId: 'a', type: 'wdr', name: 'WDR', config: WDR_TASK_TYPE.configSchema({}), enabled: true, requiresApproval: false, timeoutMs: 0 } as any;
  const prompt = await WDR_TASK_TYPE.buildPrompt(task, {} as any, ctx);
  assert.match(prompt, /wdr_collect/);
  assert.match(prompt, /create_wdr_snapshot/);
  assert.match(prompt, /逐字/);
  assert.match(prompt, /锚定纪律/);
  assert.match(prompt, /topSql\[\]\.note/);
});

test('归因纪律：tmp > blk > cpu > io 判定', () => {
  assert.equal(attributeSql(1000, 900, 0, 5), 'tmp', '有下盘优先 tmp');
  assert.equal(attributeSql(10_000_000, 5000, 3000, 0), 'blk', 'elapsed 大而 cpu/io 双低 = 等待型');
  assert.equal(attributeSql(1_000_000, 700_000, 100_000, 0), 'cpu');
  assert.equal(attributeSql(1_000_000, 100_000, 500_000, 0), 'io');
});

test('deltaInstanceTime + dbTimeClasses', () => {
  const rows = [
    { snapshot_id: 1, snap_stat_name: 'DB_TIME', snap_value: 100 },
    { snapshot_id: 2, snap_stat_name: 'DB_TIME', snap_value: 1100 },
    { snapshot_id: 1, snap_stat_name: 'CPU_TIME', snap_value: 50 },
    { snapshot_id: 2, snap_stat_name: 'CPU_TIME', snap_value: 650 },
  ];
  const d = deltaInstanceTime(rows as any, 1, 2);
  assert.equal(d.find((x) => x.stat === 'DB_TIME')?.deltaUs, 1000);
  const c = dbTimeClasses(d);
  assert.equal(c.total, 1000);
  assert.equal(c.classes.find((x) => x.name === 'CPU')?.share, 0.6);
});

test('deltaTopSql：新出现 SQL 视 begin=0，按 elapsed 排序取 topN 并算 share', () => {
  const rows = [
    { snapshot_id: 1, snap_unique_sql_id: 'a', snap_query: 'Q1', snap_n_calls: 10, snap_total_elapse_time: 1000, snap_cpu_time: 800, snap_data_io_time: 0, snap_sort_spill_size: 0 },
    { snapshot_id: 2, snap_unique_sql_id: 'a', snap_query: 'Q1', snap_n_calls: 20, snap_total_elapse_time: 4000, snap_cpu_time: 3000, snap_data_io_time: 0, snap_sort_spill_size: 0 },
    { snapshot_id: 2, snap_unique_sql_id: 'b', snap_query: 'Q2', snap_n_calls: 1, snap_total_elapse_time: 1000, snap_cpu_time: 10, snap_data_io_time: 5, snap_sort_spill_size: 0 },
  ];
  const t = deltaTopSql(rows as any, 1, 2, 5);
  assert.equal(t.length, 2);
  assert.equal(t[0].sqlId, 'a');
  assert.equal(t[0].elapsedMs, 3);
  assert.equal(t[0].share + t[1].share, 1);
});

test('judgeWindow：temp/rollback/ckpt/blk-share 阈值', () => {
  const f = judgeWindow({
    windowMinutes: 60,
    dbTimeUs: 60 * 60 * 1_000_000 * 3,   // avgActive=3 → notice
    dbStats: [{ db: 'postgres', commits: 900, rollbacks: 300, blksRead: 50000, blksHit: 500000, tempBytes: 200 * 1024 * 1024, deadlocks: 1, hitRatio: 500000 / 550000 }],
    ckpt: { timed: 4, req: 6 },
    topSql: [{ sqlId: 'x', text: '', calls: 1, elapsedMs: 9000, avgMs: 9000, cpuPct: 0, ioPct: 0, spillKb: 0, attr: 'blk', share: 0.6 }],
  });
  const codes = f.map((x) => x.code);
  assert.ok(codes.includes('WDR_TEMP_SPILL'));
  assert.ok(codes.includes('WDR_DEADLOCK'));
  assert.ok(codes.includes('WDR_ROLLBACK_HIGH'));
  assert.ok(codes.includes('WDR_CKPT_REQ'));
  assert.ok(codes.includes('WDR_SQL_BLOCKED'));
  assert.ok(codes.includes('WDR_LOAD_HIGH'));
  assert.ok(codes.includes('WDR_CACHE_LOW'), '命中率 90.9% 应触发 warn');
  assert.equal(worstOf(f), 'warn');
});

test('deltaStatDatabase / deltaWaits 剔除 STATUS', () => {
  const s = deltaStatDatabase([
    { snapshot_id: 1, snap_datname: 'postgres', snap_xact_commit: 100, snap_xact_rollback: 0, snap_blks_read: 0, snap_blks_hit: 100, snap_temp_bytes: 0, snap_deadlocks: 0 },
    { snapshot_id: 2, snap_datname: 'postgres', snap_xact_commit: 300, snap_xact_rollback: 10, snap_blks_read: 100, snap_blks_hit: 900, snap_temp_bytes: 0, snap_deadlocks: 0 },
  ] as any, 1, 2);
  assert.equal(s[0].commits, 200);
  assert.equal(s[0].hitRatio, 0.8889);
  const w = deltaWaits([
    { snapshot_id: 1, snap_type: 'LOCK_EVENT', snap_event: 'transactionid', snap_total_wait_time: 100 },
    { snapshot_id: 2, snap_type: 'LOCK_EVENT', snap_event: 'transactionid', snap_total_wait_time: 1100 },
    { snapshot_id: 2, snap_type: 'STATUS', snap_event: 'wait cmd', snap_total_wait_time: 999999 },
  ] as any, 1, 2);
  assert.equal(w.length, 1, 'STATUS 空闲类应被剔除');
  assert.equal(w[0].waitUs, 1000);
  assert.equal(w[0].share, 1);
});
