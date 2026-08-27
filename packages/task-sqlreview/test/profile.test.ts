import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, parseWaitDetails, profileFromRows } from '../src/topsql.ts';

test('fingerprint：贴的带参数 SQL 与榜单的 ? 占位文本指纹一致；不同语句不一致', () => {
  const board = 'SELECT /*+ set(query_dop 1) */ c.region_id, f.store_id, sum(f.amount), count(*) FROM (SELECT id FROM gsbench_e2e_20260801_100g.fact_sales LIMIT ?) f JOIN gsbench_e2e_20260801_100g.customers c ON c.id=f.customer_id GROUP BY c.region_id,f.store_id ORDER BY count(*) DESC LIMIT ?';
  const pasted = "SELECT /*+ set(query_dop 1) */ c.region_id, f.store_id, sum(f.amount), count(*)\n  FROM (SELECT id FROM gsbench_e2e_20260801_100g.fact_sales LIMIT 1000000) f\n  JOIN gsbench_e2e_20260801_100g.customers c ON c.id=f.customer_id GROUP BY c.region_id,f.store_id ORDER BY count(*) DESC LIMIT 20;";
  assert.equal(fingerprint(board), fingerprint(pasted));
  assert.notEqual(fingerprint(board), fingerprint("SELECT balance FROM accounts WHERE id = 'x'"));
  assert.equal(fingerprint("SELECT * FROM t WHERE name = 'O''Brien' AND n = 3.5"), 'select * from t where name = ? and n = ?');
});

const DETAILS = `\t---------------Wait Events Area---------------
'1'\tIO_EVENT     \tBufFileWrite                                 \t   2924598 (us)
'2'\tIO_EVENT     \tBufFileRead                                  \t   1500763 (us)
'3'\tLWLOCK_EVENT \tBufMappingLock                               \t     42213 (us)
'4'\tSTATUS       \tSort                                         \t     10258 (us)
\t---------------LOCK/LWLOCK Area---------------
'1'\t'LOCK_START'\t'2026-08-26 07:28:06+08'\t'0:4ec:0:0:0:0'\t'AccessShareLock'
`;

test('parseWaitDetails：只读 Wait Events Area，类型/事件/微秒', () => {
  const w = parseWaitDetails(DETAILS);
  assert.deepEqual(w.map((x) => [x.type, x.event, x.us]), [
    ['IO_EVENT', 'BufFileWrite', 2924598], ['IO_EVENT', 'BufFileRead', 1500763], ['LWLOCK_EVENT', 'BufMappingLock', 42213], ['STATUS', 'Sort', 10258],
  ]);
});

test('profileFromRows：均值构成（其他 = DB Time − 各项，不为负）+ 等待事件汇总排序与占比', () => {
  const row = (db: number, cpu: number, io: number, lock: number, d = DETAILS) => ({
    db_time: db, cpu_time: cpu, data_io_time: io, lock_wait_time: lock, lwlock_wait_time: 0, parse_time: 50, plan_time: 150, rewrite_time: 0,
    net_send_info: '{"time":400, "n_calls":2, "size":100}', net_recv_info: '{"time":5, "n_calls":1, "size":10}', d,
  });
  const p = profileFromRows([row(18_000_000, 4_000_000, 4_400_000, 0), row(16_000_000, 4_000_000, 4_200_000, 0)])!;
  assert.equal(p.samples, 2);
  assert.equal(p.avgDbUs, 17_000_000);
  const part = (n: string) => p.parts.find((x) => x.name === n)?.us;
  assert.equal(part('CPU'), 4_000_000);
  assert.equal(part('IO'), 4_300_000);
  assert.equal(part('网络'), 405);
  assert.equal(part('解析/计划'), 200);
  assert.equal(part('其他'), 17_000_000 - 4_000_000 - 4_300_000 - 405 - 200);
  assert.equal(part('锁等待'), undefined, '0 的项不出现');
  assert.equal(p.waits[0].event, 'BufFileWrite');
  assert.equal(p.waits[0].us, 2924598, '按次均值');
  assert.equal(p.waits[0].count, 2);
  assert.equal(p.waits[0].pct, 65.3);
  // 其他不为负
  const q = profileFromRows([row(1000, 900, 900, 0)])!;
  assert.equal(q.parts.find((x) => x.name === '其他'), undefined);
  assert.equal(profileFromRows([]), undefined);
});
