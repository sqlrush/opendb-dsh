import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCredentials } from '../src/index.ts';
import { POSTGRESQL_DIALECT } from '../src/dialect.ts';

test('parseCredentials: empty, valid, invalid', () => {
  assert.equal(parseCredentials('').size, 0);
  assert.equal(parseCredentials('  ').size, 0);
  const m = parseCredentials('{"og5":{"username":"opendb_ro","password":"x"},"pg1":{"password":"y"}}');
  assert.deepEqual(m.get('og5'), { username: 'opendb_ro', password: 'x' });
  assert.deepEqual(m.get('pg1'), { username: undefined, password: 'y' });
  assert.throws(() => parseCredentials('not json'), /not valid JSON/);
  assert.throws(() => parseCredentials('[1]'), /object keyed by node name/);
  assert.throws(() => parseCredentials('{"og5":"pw"}'), /must be an object/);
});

test('baseline dialect shape', () => {
  assert.equal(POSTGRESQL_DIALECT.engine, 'postgresql');
  const keys = POSTGRESQL_DIALECT.overview.map((q) => q.key);
  assert.deepEqual([...new Set(keys)].length, keys.length, 'keys unique');
  for (const q of POSTGRESQL_DIALECT.overview) assert.match(q.sql, /^(SELECT|SHOW)/i);
});
