import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReadOnlySql, stripComments } from '../src/guard.ts';

const ALLOWED = [
  'select 1',
  '  SELECT version()',
  'select * from pg_stat_activity;',
  "WITH s AS (SELECT state FROM pg_stat_activity) SELECT state, count(*) FROM s GROUP BY 1",
  'show server_version',
  'EXPLAIN SELECT 1',
  'values (1), (2)',
  'TABLE pg_database',
  'select created_at from dsh_agents',          // "create" inside a word must not trip \b
  'select * from pg_stat_activity offset 10',   // "set" inside a word must not trip \b
];

const REJECTED: [string, RegExp][] = [
  ['', /为空/],
  ['   ;  ', /为空/],
  ['select 1; select 2', /分号/],
  ['insert into t values (1)', /只允许/],
  ['update t set x = 1', /只允许/],
  ['drop table t', /只允许/],
  ['with w as (insert into t values (1) returning *) select * from w', /insert/i],
  ['with w as (delete from t returning *) select * from w', /delete/i],
  ['explain analyze select 1', /analyze/i],
  ['select set_config($$x$$, $$1$$, false)', /set/i],
  ['select 1 -- ; drop table t', /^/],           // comment stripped → plain select 1 → this one is ALLOWED, asserted below
];

test('allows plain read-only statements', () => {
  for (const sql of ALLOWED) {
    const r = validateReadOnlySql(sql);
    assert.equal(r.ok, true, `${sql} should be allowed: ${JSON.stringify(r)}`);
  }
});

test('rejects writes, multi-statements and session control', () => {
  for (const [sql, want] of REJECTED.slice(0, REJECTED.length - 1)) {
    const r = validateReadOnlySql(sql);
    assert.equal(r.ok, false, `${sql} should be rejected`);
    if (r.ok === false) assert.match(r.reason, want, sql);
  }
});

test('comments are stripped before validation', () => {
  const r = validateReadOnlySql('select 1 -- ; drop table t');
  assert.equal(r.ok, true);
  const r2 = validateReadOnlySql('/* hidden insert */ select 1');
  assert.equal(r2.ok, true);
  const r3 = validateReadOnlySql('select 1 /* tail */ ; drop table t');
  assert.equal(r3.ok, false);
  assert.equal(stripComments("select '--not a comment'"), "select '--not a comment'");
});
