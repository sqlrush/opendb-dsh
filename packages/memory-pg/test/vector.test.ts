import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toVectorLiteral } from '../src/index.ts';

test('toVectorLiteral formats pgvector input', () => {
  assert.equal(toVectorLiteral([0.1, -2, 3]), '[0.1,-2,3]');
  assert.equal(toVectorLiteral([]), '[]');
});
