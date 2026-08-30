import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHint, closestColumn, cteNames, missingColumn, referencedRelations, timeoutHint } from '../src/schema-hint.ts';

test('timeoutHint：写明是平台的线、值、上限与更省的替代做法', () => {
  const h = timeoutHint(60000, 120000);
  assert.match(h, /平台语句超时（60s）/);
  assert.match(h, /pg_class\.reltuples/);
  assert.match(h, /TABLESAMPLE/);
  assert.match(h, /timeout_ms（本次 60000，上限 120000）/);
});

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
  // 同名表在别的 schema：直接给出应写的全名（2026-08-28 dbe_perf.snapshot → snapshot.snapshot）
  const wrongSchema = buildHint('SELECT * FROM dbe_perf.snapshot ORDER BY snap_id DESC LIMIT 20', { code: '42P01', message: 'relation "dbe_perf.snapshot" does not exist' }, () => undefined, (rel) => (rel === 'dbe_perf.snapshot' ? ['snapshot'] : undefined));
  assert.match(wrongSchema, /关系 dbe_perf\.snapshot 不存在——同名表\/视图在 schema snapshot：应写 snapshot\.snapshot/);
  assert.equal(buildHint(sql, { code: '57014', message: 'canceled' }, () => WAIT_EVENTS), '');
});

test('42704 类型不存在 / 42883 函数不存在：附 openGauss 等价写法', () => {
  const h1 = buildHint(`SELECT 'x'::regnamespace`, { code: '42704', message: 'type "regnamespace" does not exist' }, () => undefined);
  assert.match(h1, /类型 regnamespace：openGauss 没有 regnamespace：改为 JOIN pg_namespace/);
  const h2 = buildHint('SELECT pg_current_wal_lsn()', { code: '42883', message: 'function pg_current_wal_lsn() does not exist' }, () => undefined);
  assert.match(h2, /pg_current_xlog_location/);
});
