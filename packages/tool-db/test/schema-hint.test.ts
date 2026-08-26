import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHint, closestColumn, cteNames, missingColumn, referencedRelations } from '../src/schema-hint.ts';

const WAIT_EVENTS = ['nodename', 'type', 'event', 'wait', 'failed_wait', 'total_wait_time', 'avg_wait_time', 'max_wait_time', 'min_wait_time', 'last_updated'];
const STATEMENT = ['unique_sql_id', 'query', 'n_calls', 'total_elapse_time', 'db_time', 'cpu_time'];

test('referencedRelations: FROM/JOIN 里的 schema.table，跳过 CTE 名', () => {
  const sql = 'WITH t AS (SELECT 1) SELECT * FROM dbe_perf.wait_events w JOIN t ON true LEFT JOIN pg_stat_activity a ON a.pid = w.pid';
  assert.deepEqual(referencedRelations(sql, cteNames(sql)), ['dbe_perf.wait_events', 'pg_stat_activity']);
});

test('missingColumn / closestColumn：event_name → event，avg_wait_time_ms → avg_wait_time', () => {
  assert.equal(missingColumn('column "event_name" does not exist'), 'event_name');
  assert.equal(missingColumn('column w.event_name does not exist'), 'event_name');
  assert.equal(closestColumn('event_name', WAIT_EVENTS), 'event');
  assert.equal(closestColumn('avg_wait_time_ms', WAIT_EVENTS), 'avg_wait_time');
  assert.equal(closestColumn('total_elapsed', STATEMENT), 'total_elapse_time');
  assert.equal(closestColumn('zzz_nothing_like_it', WAIT_EVENTS), undefined);
});

test('buildHint：42703 附真实列 + 建议；表不存在写明；非目标错误码不加提示', () => {
  const sql = 'SELECT event_name, total_waits FROM dbe_perf.wait_events ORDER BY total_wait_time DESC LIMIT 15';
  const hint = buildHint(sql, { code: '42703', message: 'column "event_name" does not exist' }, (rel) => (rel === 'dbe_perf.wait_events' ? WAIT_EVENTS : undefined));
  assert.match(hint, /dbe_perf\.wait_events 的实际列：nodename, type, event/);
  assert.match(hint, /"event_name" 应为 "event"/);
  const missingRel = buildHint('SELECT 1 FROM dbe_perf.no_such', { code: '42P01', message: 'relation does not exist' }, () => undefined);
  assert.match(missingRel, /关系 dbe_perf\.no_such 不存在/);
  assert.equal(buildHint(sql, { code: '57014', message: 'canceled' }, () => WAIT_EVENTS), '');
});
