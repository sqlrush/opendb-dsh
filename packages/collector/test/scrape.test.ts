import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowsToPoints, rowsToDictObjects } from '../src/scrape.ts';

test('rowsToPoints filters dirty rows and stamps time/node', () => {
  const t = new Date('2026-08-18T00:00:00Z');
  const points = rowsToPoints('n1', [
    { metric: 'db.sessions.active', value: '5' },
    { metric: 'db.size_bytes.postgres', value: 123.5 },
    { metric: '', value: 1 },
    { metric: 'bad', value: 'NaN?' },
    { metric: 'db.x', value: Infinity },
    {},
  ], t);
  assert.deepEqual(points.map((p) => p.metric), ['db.sessions.active', 'db.size_bytes.postgres']);
  assert.equal(points[0].value, 5);
  assert.equal(points[0].time, t);
  assert.equal(points[0].nodeId, 'n1');
});

test('rowsToDictObjects filters malformed rows, defaults signature', () => {
  const objects = rowsToDictObjects([
    { kind: 'table', sch: 'public', name: 't1', signature: 'abc' },
    { kind: 'sequence', sch: 'public', name: 's1' },
    { kind: 'table', sch: 'public' },
    { sch: 'public', name: 'x' },
  ]);
  assert.equal(objects.length, 2);
  assert.equal(objects[1].signature, '');
});
