import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractReferences, validateReferences, stripExplain } from '../src/sql-refs.ts';
import type { RelInfo, Lookup } from '../src/sql-refs.ts';

const rel = (schema: string, name: string, cols: string[]): RelInfo => ({ schema, name, kind: 'v', columns: cols.map((c) => ({ name: c, type: 'text' })) });
// og5 真实列（2026-08-29 探针）
const DICT: RelInfo[] = [
  rel('pg_catalog', 'pg_stat_activity', ['datid', 'datname', 'pid', 'sessionid', 'usesysid', 'usename', 'application_name', 'client_addr', 'backend_start', 'xact_start', 'query_start', 'state_change', 'waiting', 'enqueue', 'state', 'resource_pool', 'query_id', 'query', 'connection_info', 'unique_sql_id', 'trace_id']),
  rel('dbe_perf', 'session_stat_activity', ['datid', 'datname', 'pid', 'usename', 'waiting', 'state', 'query', 'unique_sql_id']),
  rel('dbe_perf', 'wait_events', ['nodename', 'type', 'event', 'wait', 'failed_wait', 'total_wait_time', 'avg_wait_time', 'max_wait_time', 'min_wait_time', 'last_updated']),
  rel('pg_catalog', 'pg_thread_wait_status', ['node_name', 'db_name', 'thread_name', 'query_id', 'tid', 'sessionid', 'wait_status', 'wait_event', 'locktag', 'lockmode', 'block_sessionid']),
  rel('snapshot', 'snap_summary_statement', ['snapshot_id', 'snap_unique_sql_id', 'snap_query', 'snap_n_calls', 'snap_total_elapse_time', 'snap_cpu_time']),
  rel('snapshot', 'snapshot', ['snapshot_id', 'start_ts', 'end_ts']),
  rel('gsbench', 'fact_sales', ['id', 'sale_date', 'customer_id', 'product_id', 'store_id', 'amount', 'quantity']),
];
const lookup: Lookup = (schema, name) => {
  const hit = DICT.find((d) => d.name === name && (schema === undefined || d.schema === schema));
  return hit;   // undefined = 确定不存在
};
const problems = (sql: string) => validateReferences(extractReferences(sql), lookup);

test('stripExplain：剥掉 EXPLAIN / EXPLAIN (ANALYZE, FORMAT JSON) / EXPLAIN VERBOSE 前缀', () => {
  assert.equal(stripExplain('EXPLAIN SELECT 1').sql, 'SELECT 1');
  assert.equal(stripExplain('explain (analyze, buffers) select 1').sql, 'select 1');
  assert.equal(stripExplain('EXPLAIN VERBOSE COSTS SELECT 1').sql, 'SELECT 1');
  assert.equal(stripExplain('SELECT 1').explain, false);
});

test('这次事故的三条 SQL：status / wait_event 都被拦下，并指出正确去向', () => {
  const p1 = problems(`SELECT type, event, wait, total_wait_time FROM dbe_perf.wait_events WHERE status='wait' OR 1=1 ORDER BY total_wait_time DESC LIMIT 20`);
  assert.deepEqual(p1.map((p) => p.kind === 'column' ? p.name : ''), ['status']);
  const p2 = problems(`SELECT pid, state, wait_event, wait_event_type, query FROM pg_stat_activity WHERE state <> 'idle'`);
  assert.deepEqual(p2.map((p) => (p.kind === 'column' ? p.name : '')).sort(), ['wait_event', 'wait_event_type']);
  assert.equal(p2[0].kind === 'column' ? p2[0].candidates[0].name : '', 'pg_stat_activity');
  const p3 = problems(`SELECT s.pid, s.state, s.wait_event, left(s.query, 80) FROM dbe_perf.session_stat_activity s WHERE s.state = 'active'`);
  assert.equal(p3.length, 1);
  assert.equal(p3[0].kind === 'column' ? `${p3[0].qualifier}.${p3[0].name}` : '', 's.wait_event');
});

test('正确的 SQL 零问题：限定名 / 别名 / schema.table.col / 聚合 / ORDER BY 别名 / GROUP BY 序号', () => {
  assert.deepEqual(problems(`SELECT s.pid, state, count(*) AS n FROM pg_stat_activity s JOIN dbe_perf.wait_events w ON w.event = s.state WHERE pg_stat_activity.waiting GROUP BY 1, 2 ORDER BY n DESC LIMIT 5`), []);
  assert.deepEqual(problems(`SELECT dbe_perf.wait_events.event, max(wait) FROM dbe_perf.wait_events GROUP BY 1`), []);
  assert.deepEqual(problems(`SELECT wait_event, count(*) FROM pg_thread_wait_status WHERE wait_status <> 'none' GROUP BY wait_event`), []);
});

test('CTE / 子查询 / 函数表：派生列放行，基表列照常校验，相关子查询的外层限定名能找到', () => {
  // CTE 的列（reads）不可知 → 放行；内层 snapshot.snapshot 的列照常查
  assert.deepEqual(problems(`WITH w AS (SELECT snapshot_id, sum(snap_n_calls) AS reads FROM snapshot.snap_summary_statement GROUP BY 1) SELECT e.reads, e.nonexist FROM w e WHERE e.snapshot_id IN (SELECT max(snapshot_id) FROM snapshot.snapshot)`), []);
  // 子查询里写错的列要拦
  const p = problems(`SELECT f.amount FROM (SELECT id, amount, nosuch FROM gsbench.fact_sales LIMIT 10) f WHERE f.amount > 1`);
  assert.deepEqual(p.map((x) => (x.kind === 'column' ? x.name : '')), ['nosuch']);
  // 函数表 + 无限定列：作用域里有派生表 → 无限定名放行
  assert.deepEqual(problems(`SELECT g, now() FROM generate_series(1, 3) g`), []);
  // 相关子查询：内层用外层别名，外层关系的列存在 → 通过；不存在 → 拦
  assert.deepEqual(problems(`SELECT s.pid FROM pg_stat_activity s WHERE EXISTS (SELECT 1 FROM pg_thread_wait_status t WHERE t.sessionid = s.sessionid)`), []);
  const q = problems(`SELECT s.pid FROM pg_stat_activity s WHERE EXISTS (SELECT 1 FROM pg_thread_wait_status t WHERE t.sessionid = s.wait_event)`);
  assert.equal(q.length === 1 && q[0].kind === 'column' && q[0].name === 'wait_event', true);
});

test('关系不存在 / 解析不了 / 非查询语句：不存在报 relation，其余 fail-open', () => {
  const p = problems(`SELECT snapshot_id FROM dbe_perf.snapshot LIMIT 1`);
  assert.deepEqual(p, [{ kind: 'relation', schema: 'dbe_perf', name: 'snapshot' }]);
  // 关系不可知（lookup 返回 null）→ 其列一律放行
  const unknown = validateReferences(extractReferences('SELECT whatever FROM some.thing'), () => null);
  assert.deepEqual(unknown, []);
  assert.equal(extractReferences('SELECT * FROM t TABLESAMPLE SYSTEM (1)').parsed, false);   // 方言：解析失败 → 放行
  assert.deepEqual(problems('SHOW work_mem'), []);
  assert.deepEqual(problems('SET statement_timeout = 1000'), []);
  assert.deepEqual(problems('EXPLAIN SELECT s.wait_event FROM pg_stat_activity s').map((x) => (x.kind === 'column' ? x.name : '')), ['wait_event'], 'EXPLAIN 前缀剥掉后照常校验');
});

test('UNION / UPDATE：各分支与目标表都校验', () => {
  const u = problems(`SELECT pid FROM pg_stat_activity UNION ALL SELECT nope FROM dbe_perf.wait_events`);
  assert.deepEqual(u.map((x) => (x.kind === 'column' ? x.name : '')), ['nope']);
  const up = problems(`UPDATE gsbench.fact_sales SET amount = 1, bogus = 2 WHERE id = 3`);
  assert.deepEqual(up.map((x) => (x.kind === 'column' ? x.name : '')), ['bogus']);
});

test('系统列（oid/ctid/xmin…）对任何基表视为存在：目录连接不再被误拦（2026-08-30 pg_namespace.oid 事故）', () => {
  const dictCat: RelInfo[] = [rel('pg_catalog', 'pg_class', ['relname', 'relnamespace', 'relkind']), rel('pg_catalog', 'pg_namespace', ['nspname', 'nspowner'])];
  const look: Lookup = (schema, name) => dictCat.find((d) => d.name === name && (schema === undefined || d.schema === schema));
  assert.deepEqual(validateReferences(extractReferences(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ddl_lab' AND c.xmin IS NOT NULL`), look), []);
  assert.deepEqual(validateReferences(extractReferences(`SELECT c.relname, c.nosuch FROM pg_class c`), look).map((p) => (p.kind === 'column' ? p.name : '')), ['nosuch']);
});

test('类型与函数：抽出 ::type / CAST 与函数调用，标准类型和语法级函数不核对，目录确认不存在才报', () => {
  const ex = extractReferences(`SELECT 'ddl_lab'::regnamespace, CAST(x AS integer), y::int[], z::character varying(10), w::regclass, coalesce(a, b), pg_current_wal_lsn(), count(*), left(t, 2) FROM pg_stat_activity`);
  assert.deepEqual(ex.types, ['regnamespace'], '标准类型与 regclass 不核对');
  assert.deepEqual(ex.functions.sort(), ['count', 'left', 'pg_current_wal_lsn'], 'coalesce 是语法级构造');
  const hasType = (n: string) => (n === 'regnamespace' ? false : null);
  const hasFunction = (n: string) => (n === 'pg_current_wal_lsn' ? false : n === 'count' || n === 'left' ? true : null);
  const problems = validateReferences(ex, () => null, { hasType, hasFunction });
  assert.deepEqual(problems.map((p) => `${p.kind}:${p.name}`), ['type:regnamespace', 'function:pg_current_wal_lsn']);
  // 目录不可知（null）一律放行
  assert.deepEqual(validateReferences(ex, () => null, { hasType: () => null, hasFunction: () => null }), []);
});
