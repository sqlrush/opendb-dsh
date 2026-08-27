import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMode, matchStatements, insightsOf, TRACK_SHARE_DIMS } from '../src/topsql.ts';

const ROWS = [
  { unique_sql_id: '11', query: 'SELECT /*+ set(query_dop 1) */ c.region_id, sum(f.amount) FROM (SELECT id FROM s.fact_sales LIMIT ?) f JOIN s.customers c ON c.id=f.customer_id GROUP BY 1 LIMIT ?', n_calls: 429, total_elapse_time: 7_555_950_000, min_elapse_time: 1, max_elapse_time: 2, cpu_time: 1_652_720_000, data_io_time: 1_977_360_000, n_blocks_fetched: 76_260_144, n_blocks_hit: 69_664_531, db_time: 7_270_270_000, n_returned_rows: 79000, spill_bytes: 0 },
  { unique_sql_id: '12', query: 'SELECT balance FROM s.accounts WHERE dist_key=? AND id=?', n_calls: 11_340_555, total_elapse_time: 2_391_470_000, min_elapse_time: 1, max_elapse_time: 2, cpu_time: 1_714_540_000, data_io_time: 30_290_000, n_blocks_fetched: 91_953_137, n_blocks_hit: 91_849_293, db_time: 3_005_460_000, n_returned_rows: 11_340_555, spill_bytes: 0 },
  { unique_sql_id: '13', query: 'COMMIT', n_calls: 11_340_495, total_elapse_time: 288_740_000, min_elapse_time: 1, max_elapse_time: 2, cpu_time: 888_210_000, data_io_time: 0, n_blocks_fetched: 11_341_337, n_blocks_hit: 11_341_337, db_time: 18_987_610_000, n_returned_rows: 0, spill_bytes: 0 },
];
const WORKLOAD = { nSql: 3088, calls: 47_978_964, elapsedUs: 57_668_300_000, cpuUs: 34_718_400_000, ioUs: 2_550_400_000, blocks: 438_027_137, blocksHit: 426_000_000, dbTimeUs: 77_280_500_000, rowsRet: 2_048_528_393, spillBytes: 100_000_000 };
const q = async (sql: string) => {
  assert.match(sql, /ORDER BY total_elapse_time DESC LIMIT \d+/, '一次按总耗时扫描，不要 GROUP BY/IN 全表');
  return { rows: ROWS };
};

test('resolveMode：sqls 非空 + dimensions=[] 是跟踪模式；其余都是榜单模式', () => {
  assert.equal(resolveMode({ dimensions: [], sqls: ['SELECT 1'] }), 'track');
  assert.equal(resolveMode({ dimensions: ['elapsed'], sqls: ['SELECT 1'] }), 'top');
  assert.equal(resolveMode({ dimensions: [], sqls: [] }), 'top');
  assert.equal(resolveMode({ sqls: ['SELECT 1'] }), 'top', 'dimensions 未传 = 默认三榜');
  assert.equal(resolveMode({ dimensions: [], sqls: ['  '] }), 'top');
});

test('matchStatements：贴的带参 SQL 按指纹找到运行记录，带指标/占比/榜位；找不到的为 undefined', async () => {
  const pasted = "SELECT /*+ set(query_dop 1) */ c.region_id, sum(f.amount)\n FROM (SELECT id FROM s.fact_sales LIMIT 1000000) f JOIN s.customers c ON c.id=f.customer_id GROUP BY 1 LIMIT 20";
  const m = await matchStatements(q, [pasted, 'SELECT nothing FROM nowhere'], WORKLOAD);
  const it = m.get(pasted)!;
  assert.ok(it, '应匹配到 unique_sql_id 11');
  assert.equal(it.uniqueSqlId, '11');
  assert.equal(it.tracked, true);
  assert.equal(it.shares.elapsed, 13.1);
  assert.equal(it.shares.io, 77.5);
  assert.equal(it.ranks.elapsed, 1);
  assert.equal(it.ranks.calls, 3);
  assert.equal(it.kind, '分析型');
  assert.equal(m.get('SELECT nothing FROM nowhere'), undefined);
});

test('跟踪模式的一眼结论：没有榜也能按跟踪对象里占比最高的出结论', async () => {
  const m = await matchStatements(q, ['SELECT balance FROM s.accounts WHERE dist_key=1 AND id=2', 'COMMIT'], WORKLOAD);
  const items = [...m.values()].filter((x) => x !== undefined) as any[];
  const ins = insightsOf({ workload: WORKLOAD, boards: [], items }, TRACK_SHARE_DIMS);
  assert.ok(ins.some((i) => /COMMIT 占 DB Time 24\.6%/.test(i.text)), JSON.stringify(ins));
  assert.ok(ins.some((i) => /跟踪的 2 条合计占：总耗时/.test(i.text)), JSON.stringify(ins));
});
