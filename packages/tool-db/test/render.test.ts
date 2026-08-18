import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTable, cell, clampText } from '../src/render.ts';

test('renderTable: alignment, empty, missing fields fallback', () => {
  assert.equal(renderTable(['a'], []), '(0 rows)');
  const t = renderTable(['name', 'n'], [{ name: 'og5', n: 12 }, { name: 'x', n: null }]);
  const lines = t.split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^name | n$/);
  assert.match(lines[3], /∅/);
  const noFields = renderTable([], [{ k: 'v' }]);
  assert.match(noFields, /k/);
});

test('cell: objects, long values, null', () => {
  assert.equal(cell(null), '∅');
  assert.equal(cell({ a: 1 }), '{"a":1}');
  assert.equal(cell('x\n y\tz'), 'x y z');
  assert.equal(cell('a'.repeat(100)).length, 60);
});

test('clampText caps bytes with a notice', () => {
  assert.equal(clampText('short', 100), 'short');
  const clamped = clampText('x'.repeat(200), 50);
  assert.match(clamped, /已截断/);
});
