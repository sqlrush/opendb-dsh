import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import S3AttachmentStore from '../src/index.ts';

const E = process.env.S3_ENDPOINT;
const ctx = new Context();
let store: S3AttachmentStore;
// 1x1 red PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  if (!E) return;
  await ctx.plugin(S3AttachmentStore, { endpoint: E, bucket: process.env.S3_BUCKET ?? 'dsh-test', accessKey: process.env.S3_ACCESS_KEY, secretKey: process.env.S3_SECRET_KEY, prefix: `test/${Date.now()}` });
  store = ctx.get('attachments') as S3AttachmentStore;
});
after(async () => { await ctx.root.fiber.dispose(); });

test('save → read round-trip keeps sha256 ref and metadata; second save is idempotent', { skip: !E }, async () => {
  const ref = await store.saveImage({ data: new Uint8Array(PNG), mediaType: 'image/png', name: '/tmp/x/red.png' });
  assert.match(String(ref.attachmentId), /^sha256:[a-f0-9]{64}$/);
  assert.equal(ref.width, 1); assert.equal(ref.height, 1); assert.equal(ref.name, 'red.png');
  const ref2 = await store.saveImage({ data: new Uint8Array(PNG), mediaType: 'image/png' });
  assert.equal(ref2.attachmentId, ref.attachmentId);
  const back = await store.readImage(ref);
  assert.equal(Buffer.compare(Buffer.from(back.data), PNG), 0);
});

test('bad ref / missing object / type mismatch raise dsh AttachmentError codes', { skip: !E }, async () => {
  await assert.rejects(() => store.readImage({ attachmentId: 'nope', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }), (e: any) => e.code === 'INVALID_ATTACHMENT_REF');
  await assert.rejects(() => store.readImage({ attachmentId: 'sha256:' + '0'.repeat(64), mediaType: 'image/png', bytes: 1, width: 1, height: 1 }), (e: any) => e.code === 'ATTACHMENT_NOT_FOUND');
  await assert.rejects(() => store.saveImage({ data: new Uint8Array(PNG), mediaType: 'image/jpeg' }), (e: any) => e.code === 'IMAGE_TYPE_MISMATCH');
});
