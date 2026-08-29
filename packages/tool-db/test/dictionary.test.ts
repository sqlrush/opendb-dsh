import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DictionaryGate } from '../src/dictionary.ts';

/** 假目录：按 SQL 里的 relname / attname 关键字回放 og5 的真实结构（2026-08-29 探针） */
const CATALOG: Record<string, { schema: string; kind: string; cols: [string, string][] }> = {
  pg_stat_activity: { schema: 'pg_catalog', kind: 'v', cols: [['pid', 'bigint'], ['state', 'text'], ['waiting', 'boolean'], ['query', 'text'], ['sessionid', 'bigint']] },
  wait_events: { schema: 'dbe_perf', kind: 'v', cols: [['type', 'text'], ['event', 'text'], ['wait', 'bigint'], ['total_wait_time', 'bigint']] },
  pg_thread_wait_status: { schema: 'pg_catalog', kind: 'v', cols: [['sessionid', 'bigint'], ['wait_status', 'text'], ['wait_event', 'text']] },
  thread_wait_status: { schema: 'dbe_perf', kind: 'v', cols: [['sessionid', 'bigint'], ['wait_status', 'text'], ['wait_event', 'text']] },
  snapshot: { schema: 'snapshot', kind: 'r', cols: [['snapshot_id', 'bigint'], ['start_ts', 'timestamp'], ['end_ts', 'timestamp']] },
};
function fakeQuery(calls: string[]) {
  return async (_node: any, sql: string): Promise<{ rows: any[] }> => {
    calls.push(sql);
    const rel = /c\.relname = '([^']+)'/.exec(sql)?.[1];
    const schema = /n\.nspname = '([^']+)'/.exec(sql)?.[1];
    const ilike = /a\.attname ILIKE '%([^%']+)%'/.exec(sql)?.[1];
    const relLike = /c\.relname ILIKE '%([^%']+)%'/.exec(sql)?.[1];
    if (ilike !== undefined) return { rows: Object.entries(CATALOG).flatMap(([name, c]) => c.cols.filter(([col]) => col.includes(ilike)).map(([col, type]) => ({ rel: `${c.schema}.${name}`, col, type }))) };
    if (relLike !== undefined) return { rows: Object.entries(CATALOG).filter(([name]) => name.includes(relLike)).map(([name, c]) => ({ rel: `${c.schema}.${name}` })) };
    if (/SELECT DISTINCT n\.nspname AS schema/.test(sql)) { const c = rel !== undefined ? CATALOG[rel] : undefined; return { rows: c !== undefined ? [{ schema: c.schema }] : [] }; }
    if (rel === undefined) return { rows: [] };
    const c = CATALOG[rel];
    if (c === undefined || (schema !== undefined && schema !== c.schema)) return { rows: [] };
    return { rows: c.cols.map(([col, type]) => ({ schema: c.schema, name: rel, kind: c.kind, col, type })) };
  };
}
const node = { id: 'n1', name: 'og5' };

test('validate：wait_event 写在 pg_stat_activity 上 → 不执行，字典单含真实列、最接近列、含该列的关系', async () => {
  const calls: string[] = [];
  const gate = new DictionaryGate(fakeQuery(calls));
  const v = await gate.validate(node, `SELECT pid, state, wait_event, query FROM pg_stat_activity WHERE state <> 'idle'`);
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.match(v.report, /字典校验未通过，SQL 未执行/);
  assert.match(v.report, /pg_catalog\.pg_stat_activity 没有列 wait_event——最接近的是 waiting/);
  assert.match(v.report, /含 wait_event 列的关系：.*pg_catalog\.pg_thread_wait_status\.wait_event.*dbe_perf\.thread_wait_status\.wait_event/);
  assert.match(v.report, /pg_catalog\.pg_stat_activity（视图）的列：pid bigint, state text, waiting boolean/);
});

test('validate：正确 SQL 放行且第二次命中缓存（不再查目录）', async () => {
  const calls: string[] = [];
  const gate = new DictionaryGate(fakeQuery(calls));
  assert.deepEqual(await gate.validate(node, `SELECT type, event, wait FROM dbe_perf.wait_events ORDER BY total_wait_time DESC LIMIT 5`), { ok: true });
  const n1 = calls.length;
  assert.ok(n1 >= 1);
  assert.deepEqual(await gate.validate(node, `SELECT event FROM dbe_perf.wait_events`), { ok: true });
  assert.equal(calls.length, n1, '同节点同关系 10 分钟内不再查目录');
});

test('validate：关系写错 schema → 报不存在并指出同名关系所在 schema；目录不可读 → 放行', async () => {
  const gate = new DictionaryGate(fakeQuery([]));
  const v = await gate.validate(node, `SELECT snapshot_id FROM dbe_perf.snapshot ORDER BY 1 DESC LIMIT 1`);
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.report, /关系 dbe_perf\.snapshot 不存在——同名关系在 schema snapshot，应写 snapshot\.snapshot/);
  const broken = new DictionaryGate(async () => { throw new Error('connection refused'); });
  assert.deepEqual(await broken.validate(node, `SELECT nope FROM pg_stat_activity`), { ok: true });
});

test('describe / findColumns / columnsFor', async () => {
  const gate = new DictionaryGate(fakeQuery([]));
  const d = await gate.describe(node, 'wait_events');
  assert.equal(d.info?.schema, 'dbe_perf');
  assert.deepEqual(d.info?.columns.map((c) => c.name), ['type', 'event', 'wait', 'total_wait_time']);
  const miss = await gate.describe(node, 'dbe_perf.snapshot');
  assert.equal(miss.info, undefined);
  assert.deepEqual(miss.elsewhere, ['snapshot']);
  const found = await gate.findColumns(node, 'wait_event');
  assert.deepEqual(found.map((f) => f.rel), ['pg_catalog.pg_thread_wait_status', 'dbe_perf.thread_wait_status']);
  assert.deepEqual(await gate.columnsFor(node, 'pg_stat_activity'), ['pid', 'state', 'waiting', 'query', 'sessionid']);
  assert.equal(await gate.columnsFor(node, 'dbe_perf.nothing'), undefined);
});
