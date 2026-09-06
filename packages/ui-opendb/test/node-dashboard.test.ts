import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateSeries, ratioSeries, divideSeries, levelBy, worstOf, overdueDays, cronPeriodMs, groupBatches, headlineOf, factsFor, healthFacts } from '../src/node-dashboard.ts';

const M = 60_000;

test('rateSeries：累计计数器差分成每秒速率，计数器重置的负增量跳过', () => {
  const r = rateSeries([[0, 100], [M, 160], [2 * M, 40], [3 * M, 100]]);
  assert.deepEqual(r, [[M, 1], [3 * M, 1]]);
});

test('ratioSeries / divideSeries：命中率 = Δhit/(Δhit+Δread)，平均耗时 = Δelapse/Δcalls', () => {
  const hit: [number, number][] = [[0, 0], [M, 90], [2 * M, 180]];
  const read: [number, number][] = [[0, 0], [M, 10], [2 * M, 20]];
  assert.deepEqual(ratioSeries(hit, read), [[M, 0.9], [2 * M, 0.9]]);
  assert.deepEqual(divideSeries([[M, 500], [2 * M, 0]], [[M, 5], [2 * M, 0]]), [[M, 100]]);
});

test('levelBy / worstOf：阈值方向与最差档', () => {
  assert.equal(levelBy(0.962, { notice: 0.99, warn: 0.95 }, '<'), 'notice');
  assert.equal(levelBy(0.94, { notice: 0.99, warn: 0.95 }, '<'), 'warn');
  assert.equal(levelBy(0.85, { notice: 0.6, warn: 0.8 }), 'warn');
  assert.equal(levelBy(null, { notice: 1, warn: 2 }), 'ok');
  assert.equal(worstOf(['ok', null, 'notice', 'warn']), 'warn');
  assert.equal(worstOf([]), 'ok');
});

test('overdueDays：每小时 cron 上次触发 7 天前 → 逾期 ≈7 天；刚触发过 → 不逾期；手动任务无 cron 不判', () => {
  const now = new Date('2026-09-05T12:00:00Z');
  assert.equal(overdueDays('45 * * * *', new Date('2026-08-29T02:48:00Z'), new Date('2026-08-20T00:00:00Z'), now), 7);
  assert.equal(overdueDays('45 * * * *', new Date('2026-09-05T11:45:00Z'), new Date('2026-08-20T00:00:00Z'), now), null);
  assert.equal(overdueDays('not a cron', null, new Date('2026-08-20T00:00:00Z'), now), null);
  const p = cronPeriodMs('0 2 * * *', now);
  assert.ok(p !== undefined && Math.abs(p - 86_400_000) < 3_600_000, `period=${p}`);
});

test('groupBatches：同分钟同 schema 合并，含 schema 级删除判严重、含删除判告警、只改判注意', () => {
  const b = groupBatches([
    { m: '2026-08-31 09:10', sch: 'e2e', change: 'added', kind: 'table', c: 34, names: ['a', 'b'] },
    { m: '2026-08-31 09:10', sch: 'e2e', change: 'added', kind: 'index', c: 50, names: ['a_pkey'] },
    { m: '2026-08-31 02:08', sch: 'bench', change: 'removed', kind: 'table', c: 38, names: ['t'] },
    { m: '2026-08-31 02:07', sch: 'loadtest', change: 'removed', kind: 'schema', c: 1, names: ['loadtest'] },
    { m: '2026-08-30 08:57', sch: 'ddl_lab', change: 'modified', kind: 'table', c: 4, names: ['x'] },
  ]);
  assert.equal(b.length, 4);
  assert.deepEqual(b[0], { at: '2026-08-31 09:10', schema: 'e2e', added: 84, removed: 0, modified: 0, kinds: ['table', 'index'], names: ['a', 'b', 'a_pkey'], level: 'ok' });
  assert.equal(b[1].level, 'warn');
  assert.equal(b[2].level, 'critical');
  assert.equal(b[3].level, 'notice');
});

test('headlineOf：取第一句并限长', () => {
  assert.equal(headlineOf('og5 库 42.0 GB，清理悬崖后净增 -0.38 GB/天；空间集中在三代压测库'), 'og5 库 42.0 GB，清理悬崖后净增 -0.38 GB/天');
  assert.equal(headlineOf('x'.repeat(100), 20).length, 20);
});

test('factsFor / healthFacts：五类存档各取关键数', () => {
  assert.deepEqual(factsFor('capacity', { summary: { dbBytes: 45144498180, growth: { bytesPerDay: -409265111 } }, statsNever: { count: 28 } }),
    [{ label: '库大小', value: '42.0 GB' }, { label: '增速', value: '-0.38 GB/天' }, { label: '从未 ANALYZE', value: '28 表' }]);
  assert.deepEqual(factsFor('wdr', { summary: { aas: 24.66, tps: 1666 }, topSql: new Array(40) }), [{ label: 'AAS', value: '24.66' }, { label: 'TPS', value: '1666' }, { label: 'Top SQL', value: '40' }]);
  assert.deepEqual(factsFor('ddl', { summary: { events: 3, destructive: 3 }, ruleFindings: [1] }), [{ label: '变更事件', value: '3' }, { label: '破坏性', value: '3' }, { label: '规则命中', value: '1' }]);
  const h = healthFacts({ dims: [{ dim: 'overview', worst: 'notice', measures: [{ key: 'cacheHit', label: '缓存命中率', unit: 'ratio', value: 0.962, level: 'notice', why: '实测 96% < 99%' }] }, { dim: 'ckpt', worst: 'ok', measures: [] }] });
  assert.deepEqual(h.facts, [{ label: '缓存命中率', value: '96.2%' }, { label: '正常维度', value: '1/2' }]);
  assert.equal(h.headline, '实测 96% < 99%');
});
