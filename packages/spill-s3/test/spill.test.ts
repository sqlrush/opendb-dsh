import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import S3SpillStore from '../src/index.ts';

const E = process.env.S3_ENDPOINT;
const ctx = new Context();
let store: S3SpillStore;
before(async () => {
  if (!E) return;
  await ctx.plugin(S3SpillStore, { endpoint: E, bucket: process.env.S3_BUCKET ?? 'dsh-test', accessKey: process.env.S3_ACCESS_KEY, secretKey: process.env.S3_SECRET_KEY, prefix: `spilltest/${Date.now()}`, maxReadBytes: 4096 });
  store = ctx.get('spillStore') as S3SpillStore;
});
after(async () => { await ctx.root.fiber.dispose(); });

test('saveText returns an s3:// locator + hint; read pages by offset/limit; foreign locators rejected', { skip: !E }, async () => {
  const content = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const ref = await store.saveText({ owner: { sessionId: 's1' }, source: { toolName: 'bash', callId: 'c1', label: 'x' }, suggestedName: 'big output.txt', content });
  assert.match(String(ref.locator), /^s3:\/\/dsh-test\/spilltest\//);
  assert.equal(ref.bytes, Buffer.byteLength(content));
  assert.match(ref.retrievalHint, /read_spill/);
  const page1 = await store.read(String(ref.locator), 0, 3);
  assert.equal(page1.content, 'line 0\nline 1\nline 2'); assert.equal(page1.totalLines, 500); assert.equal(page1.nextOffset, 3);
  const last = await store.read(String(ref.locator), 498, 10);
  assert.equal(last.content, 'line 498\nline 499'); assert.equal(last.nextOffset, undefined);
  const big = await store.read(String(ref.locator), 0, 500);
  assert.equal(big.truncated, true);
  await assert.rejects(() => store.read('s3://other-bucket/spill/x', 0, 1), /not a spill object/);
  await assert.rejects(() => store.read(`s3://dsh-test/../etc`, 0, 1), /not a spill object/);
});
