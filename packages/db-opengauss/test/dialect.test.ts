import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPENGAUSS_DIALECT } from '../src/index.ts';

test('openGauss dialect: unique keys, every overview query is a single non-empty SELECT', () => {
  const keys = OPENGAUSS_DIALECT.overview.map((q) => q.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(OPENGAUSS_DIALECT.engine, 'opengauss');
  for (const q of OPENGAUSS_DIALECT.overview) {
    const sql = q.sql.trim().replace(/;$/, '');
    assert.notEqual(sql, '', `${q.key}: empty sql`);
    assert.match(sql, /^(select|with)\b/i, `${q.key}: overview queries are diagnostic reads`);
    assert.ok(!sql.includes(';'), `${q.key}: one statement per overview section`);
  }
});
