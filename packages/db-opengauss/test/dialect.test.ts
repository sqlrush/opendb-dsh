import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPENGAUSS_DIALECT } from '../src/index.ts';
import { validateReadOnlySql } from '@opendb-dsh/db';

test('openGauss dialect: unique keys, every query passes the read-only gate', () => {
  const keys = OPENGAUSS_DIALECT.overview.map((q) => q.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(OPENGAUSS_DIALECT.engine, 'opengauss');
  for (const q of OPENGAUSS_DIALECT.overview) {
    const r = validateReadOnlySql(q.sql);
    assert.equal(r.ok, true, `${q.key}: ${JSON.stringify(r)}`);
  }
});
