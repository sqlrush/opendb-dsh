import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInsert } from '../src/index.ts';

test('buildInsert: placeholders and defaults', () => {
  const t0 = new Date('2026-08-18T00:00:00Z');
  const { text, values } = buildInsert([
    { time: t0, nodeId: 'n1', metric: 'db.sessions.active', value: 5 },
    { nodeId: 'n2', tenantId: 't2', metric: 'db.size_bytes.postgres', value: 123 },
  ]);
  assert.match(text, /VALUES \(\$1,\$2,\$3,\$4,\$5\),\(\$6,\$7,\$8,\$9,\$10\)$/);
  assert.equal(values.length, 10);
  assert.equal(values[0], t0);
  assert.equal(values[1], 'default');
  assert.equal(values[6], 't2');
  assert.equal(values[9], 123);
});
