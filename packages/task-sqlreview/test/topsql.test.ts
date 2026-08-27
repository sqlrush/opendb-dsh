import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDimensions, buildTopSql, classify, referencedTables, attributeRules, insightsOf, DEFAULT_DIMENSIONS } from '../src/topsql.ts';
import { shortKey } from '../src/sqlscan.ts';
import { SQLREVIEW_THRESHOLDS } from '../src/rules.ts';

// dbe_perf.statement 的假数据（数字取自 og5 实测量级）：一条监控轮询、两条分析型、OLTP 四件套
const ROWS = [
  { unique_sql_id: '1', query: 'SELECT substring(sessid FROM ?) AS "sessid", SUM(totalsize)/?/? FROM gs_session_memory_detail GROUP BY sessid', n_calls: 256384, total_elapse_time: 26_445_860_000, min_elapse_time: 78221, max_elapse_time: 2_977_892_424, cpu_time: 22_976_730_000, data_io_time: 80_000, n_blocks_fetched: 1_668_647, n_blocks_hit: 1_600_000, db_time: 26_709_130_000, n_returned_rows: 213_424_890, spill_bytes: 0 },
  { unique_sql_id: '2', query: 'SELECT /*+ set(query_dop 1) */ c.region_id, f.store_id, sum(f.amount) FROM (SELECT customer_id FROM gsbench_e2e.fact_sales LIMIT ?) f JOIN gsbench_e2e.customers c ON c.id=f.customer_id GROUP BY 1,2', n_calls: 429, total_elapse_time: 7_555_950_000, min_elapse_time: 710426, max_elapse_time: 41_200_000, cpu_time: 1_652_720_000, data_io_time: 1_977_360_000, n_blocks_fetched: 76_260_144, n_blocks_hit: 69_664_531, db_time: 7_270_270_000, n_returned_rows: 79000, spill_bytes: 93_243_912 },
  { unique_sql_id: '3', query: 'UPDATE gsbench_e2e.accounts SET balance=balance+?,updated_at=current_timestamp WHERE dist_key=? AND id=?', n_calls: 11_340_541, total_elapse_time: 3_039_440_000, min_elapse_time: 50, max_elapse_time: 1_800_000, cpu_time: 2_024_220_000, data_io_time: 22_440_000, n_blocks_fetched: 121_068_594, n_blocks_hit: 120_983_041, db_time: 3_639_410_000, n_returned_rows: 0, spill_bytes: 0 },
  { unique_sql_id: '4', query: 'COMMIT', n_calls: 11_340_495, total_elapse_time: 288_740_000, min_elapse_time: 5, max_elapse_time: 900_000, cpu_time: 888_210_000, data_io_time: 0, n_blocks_fetched: 11_341_337, n_blocks_hit: 11_341_337, db_time: 18_987_610_000, n_returned_rows: 0, spill_bytes: 0 },
  { unique_sql_id: '5', query: 'SELECT balance FROM gsbench_e2e.accounts WHERE dist_key=? AND id=?', n_calls: 11_340_555, total_elapse_time: 2_391_470_000, min_elapse_time: 40, max_elapse_time: 500_000, cpu_time: 1_714_540_000, data_io_time: 30_290_000, n_blocks_fetched: 91_953_137, n_blocks_hit: 91_849_293, db_time: 3_005_460_000, n_returned_rows: 11_340_555, spill_bytes: 0 },
  { unique_sql_id: '6', query: 'UPDATE gsbench_e2e.lock_targets SET value=value+? WHERE id=?', n_calls: 149, total_elapse_time: 1_249_420_000, min_elapse_time: 1000, max_elapse_time: 30_000_000, cpu_time: 40_000, data_io_time: 10_000, n_blocks_fetched: 5795, n_blocks_hit: 5795, db_time: 443_390_000, n_returned_rows: 0, spill_bytes: 0 },
];
const TOTAL = { n_sql: 3088, calls: 47_978_964, elapsed: 57_668_300_000, cpu: 34_718_400_000, io: 2_550_400_000, blocks: 438_027_137, hit: 426_000_000, dbtime: 77_280_500_000, rows_ret: 2_048_528_393, spill_bytes: 100_000_000 };

/** 假查询：按 ORDER BY 里的表达式排序返回 Top-N */
const q = async (sql: string, maxRows = 50) => {
  if (/count\(\*\) AS n_sql/.test(sql)) return { rows: [TOTAL] };
  const m = sql.match(/ORDER BY (.+) DESC LIMIT (\d+)/s);
  assert.ok(m, `unexpected sql: ${sql.slice(0, 80)}`);
  const expr = m[1].trim(); const n = Number(m[2]);
  const val = (r: any) => expr === 'total_elapse_time / n_calls' ? r.total_elapse_time / r.n_calls : expr === 'sort_spill_size + hash_spill_size' ? r.spill_bytes : r[expr];
  return { rows: [...ROWS].sort((a, b) => val(b) - val(a)).slice(0, Math.min(n, maxRows)) };
};

test('normalizeDimensions：键名、中文、别名、去重、空回默认', () => {
  assert.deepEqual(normalizeDimensions(['calls', '总耗时', 'CPU', 'calls', '未知']), ['calls', 'elapsed', 'cpu']);
  assert.deepEqual(normalizeDimensions('执行次数,平均耗时'), ['calls', 'avg']);
  assert.deepEqual(normalizeDimensions([]), DEFAULT_DIMENSIONS);
  assert.deepEqual(normalizeDimensions(undefined), DEFAULT_DIMENSIONS);
});

test('classify：事务控制 / 监控类 / OLTP 高频 / 分析型 / 疑似锁等待', () => {
  const m = (calls: number, avgUs: number, blocks: number) => ({ calls, elapsedUs: calls * avgUs, avgUs, minUs: 0, maxUs: 0, cpuUs: 0, ioUs: 0, blocks, blocksHit: 0, dbTimeUs: 0, rowsRet: 0, spillBytes: 0 });
  assert.equal(classify('COMMIT', m(1e7, 30, 1e7)), '事务控制');
  assert.equal(classify('SELECT x FROM gs_session_memory_detail', m(2e5, 103_000, 1e6)), '监控类');
  assert.equal(classify('SELECT balance FROM accounts WHERE id=?', m(1e7, 200, 9e7)), 'OLTP 高频');
  assert.equal(classify('SELECT /*+ set(query_dop 1) */ sum(a) FROM f JOIN c ON 1=1', m(429, 17_600_000, 7e7)), '分析型');
  assert.equal(classify('UPDATE lock_targets SET v=v+? WHERE id=?', m(149, 8_385_000, 5795)), '疑似锁等待');
});

test('referencedTables：FROM/JOIN/UPDATE/INSERT INTO，去 schema 与引号，忽略子查询括号', () => {
  assert.deepEqual(referencedTables('SELECT * FROM (SELECT id FROM "gsbench_e2e".fact_sales LIMIT ?) f JOIN gsbench_e2e.customers c ON 1=1'), ['fact_sales', 'customers']);
  assert.deepEqual(referencedTables('UPDATE gsbench_e2e.accounts SET x=1'), ['accounts']);
  assert.deepEqual(referencedTables('INSERT INTO orders(a) VALUES(?)'), ['orders']);
  assert.deepEqual(referencedTables('COMMIT'), []);
});

test('buildTopSql：按维度各出榜、跨榜去重、S 编号按首次上榜顺序、占比按全库分母', async () => {
  const r = await buildTopSql(q, ['elapsed', 'calls'], 3);
  assert.equal(r.workload.nSql, 3088);
  assert.deepEqual(r.boards.map((b) => b.dim), ['elapsed', 'calls']);
  assert.equal(r.boards[0].keys.length, 3);
  // 总耗时榜首 = 监控轮询，占 45.9%
  const s1 = r.items.find((it) => it.label === 'S1')!;
  assert.match(s1.text, /gs_session_memory_detail/);
  assert.equal(s1.shares.elapsed, 45.9);
  assert.equal(s1.shares.cpu, 66.2);
  assert.equal(s1.ranks.elapsed, 1);
  assert.equal(s1.kind, '监控类');
  // UPDATE accounts 同时在两榜：一个 item、两个榜位
  const upd = r.items.find((it) => /UPDATE gsbench_e2e\.accounts/.test(it.text))!;
  assert.equal(upd.ranks.elapsed, 3);
  assert.equal(upd.ranks.calls, 2);
  assert.equal(upd.shares.calls, 23.6);
  assert.equal(upd.shares.blocks, 27.6);
  assert.equal(upd.kind, 'OLTP 高频');
  // 去重：3 + 3 榜位，但 UPDATE 重复 → 5 条
  assert.equal(r.items.length, 5);
  assert.deepEqual(r.items.map((it) => it.label), ['S1', 'S2', 'S3', 'S4', 'S5']);
  assert.equal(r.items[0].key, shortKey(ROWS[0].query));
  assert.deepEqual(r.boards[0].shares.map((s) => s !== null), [true, true, true]);
});

test('avg 榜无占比（shares 为 null），但 item 的其他维度占比照算', async () => {
  const r = await buildTopSql(q, ['avg'], 2);
  assert.deepEqual(r.boards[0].shares, [null, null]);
  assert.equal(r.items[0].shares.elapsed, 13.1);   // 分析型 S2 原来的总耗时占比
});

test('attributeRules：文本规则按 key，目录规则按引用的表；未归因的单独列出', async () => {
  const r = await buildTopSql(q, ['elapsed'], 3);
  const s2 = r.items.find((it) => /fact_sales/.test(it.text))!;
  const findings = [
    { rule: 'TBL001', level: 'warn' as const, object: 'gsbench.fact_sales', table: 'fact_sales', problem: '', advice: '', evidence: '' },
    { rule: 'IDX003', level: 'warn' as const, object: 'a / a', table: 'accounts', problem: '', advice: '', evidence: '' },
    { rule: 'TBL001', level: 'warn' as const, object: 'snapshot.snap_x', table: 'snap_x', problem: '', advice: '', evidence: '' },
    { rule: 'DQL001', level: 'notice' as const, object: s2.key, problem: 'SELECT *', advice: '', evidence: '' },
  ];
  const a = attributeRules(r.items, findings);
  assert.deepEqual(a.byKey[s2.key], [0, 3]);
  const upd = r.items.find((it) => /UPDATE gsbench_e2e\.accounts/.test(it.text))!;
  assert.deepEqual(a.byKey[upd.key], [1]);
  assert.deepEqual(a.unattributed, [2]);
});

test('insightsOf：单条占比 ≥ 阈值成结论、COMMIT 占 DB Time、OLTP 汇总、上榜合计；阈值可覆盖', async () => {
  const r = await buildTopSql(q, ['elapsed', 'calls'], 4);
  const ins = insightsOf(r, ['elapsed', 'calls']);
  assert.ok(ins.some((i) => i.level === 'warn' && /S1/.test(i.text) && /45\.9%/.test(i.text)), JSON.stringify(ins));
  assert.ok(ins.some((i) => /COMMIT 占 DB Time 24\.6%/.test(i.text)), JSON.stringify(ins));
  assert.ok(ins.some((i) => /上榜 \d+ 条合计占：总耗时 .*执行次数/.test(i.text)), JSON.stringify(ins));
  assert.ok(ins.length <= 5);
  // 高亮线提到 50% → S1 的 45.9% 不再成结论
  const strict = insightsOf(r, ['elapsed', 'calls'], { ...SQLREVIEW_THRESHOLDS, shareHighlightPct: 50 });
  assert.ok(!strict.some((i) => /S1/.test(i.text) && /45\.9%/.test(i.text)));
});
