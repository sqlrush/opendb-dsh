import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmbeddings } from '../src/index.ts';

test('parseEmbeddings: order by index, validates dims and count', () => {
  const ok = parseEmbeddings({ data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }] }, 2, 2);
  assert.deepEqual(ok, [[1, 2], [3, 4]]);
  assert.throws(() => parseEmbeddings({ data: [{ embedding: [1] }] }, 1, 2), /维/);
  assert.throws(() => parseEmbeddings({ data: [] }, 1, 2), /条数不符/);
  assert.throws(() => parseEmbeddings({}, 1, 2), /条数不符/);
  assert.throws(() => parseEmbeddings({ data: [{ index: 0, embedding: [1, NaN] }] }, 1, 2), /非法/);
  assert.throws(() => parseEmbeddings({ data: [{ index: 1, embedding: [1, 2] }, { index: 1, embedding: [3, 4] }] }, 2, 2), /不连续/);
});
