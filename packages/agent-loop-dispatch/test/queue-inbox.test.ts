import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueueInbox, projectQueue, queueFrameItems } from '../src/queue-inbox.ts';
import type { OpenRow } from '../src/queue.ts';

const msg = (id: string, text = id) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });
const row = (queueId: string, over: Partial<OpenRow> = {}): OpenRow => ({
  queueId, kind: 'queued', messageId: `m${queueId}`, admitted: false, attempts: 0,
  payload: { content: [{ type: 'text', text: queueId }], source: { kind: 'user' }, message: msg(`m${queueId}`) },
  ...over,
});

/** A pool double recording every query; `hits` controls the rowCount each returns. */
function fakePool(hits = 1) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    query: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return { rowCount: hits, rows: [] }; },
  } as any;
}

test('projectQueue: pending rows show; admitted rows show only until their message is durable', () => {
  const rows = [row('1', { admitted: true }), row('2', { admitted: true }), row('3'), row('4', { kind: 'steer' })];
  const entries = projectQueue(rows, new Set(['m1']));
  assert.deepEqual(entries.map((e) => e.queueId), ['2', '3', '4'], 'm1 is durable → dropped; m2 admitted but not yet durable → kept');
  const items = queueFrameItems(entries);
  assert.deepEqual(items.map((i) => i.placement), ['queued', 'queued', 'steering']);
  assert.equal(items[0].id, 'm2');
});

test('projectQueue: pre-015 rows (no message) are shown while pending with a synthetic message, hidden once admitted', () => {
  const legacyPending = row('9', { messageId: null, payload: { content: [{ type: 'text', text: 'old' }], source: { kind: 'user' } } });
  const legacyAdmitted = row('8', { messageId: null, admitted: true, payload: { content: [], source: { kind: 'user' } } });
  const entries = projectQueue([legacyAdmitted, legacyPending], new Set());
  assert.equal(entries.length, 1);
  assert.equal(entries[0].message.id, 'queue-9');
  assert.equal(entries[0].message.role, 'user');
});

test('QueueInbox exposes the native surface apiproxy reads and ignores mirrored splices when building frames', () => {
  const inbox = new QueueInbox(fakePool(), () => {});
  inbox.refresh(projectQueue([row('1'), row('2', { kind: 'steer' })], new Set()));
  assert.deepEqual(inbox.nextTurn.map((m) => m.id), ['m1']);
  assert.deepEqual(inbox.nextStep.map((m) => m.id), ['m2']);
  assert.equal(inbox.hasPending, true);
  // dsh-host-apiproxy applies the Runtime's mirrored splice indices via toSpliced(): must be a no-op here
  const spliced = (inbox.nextTurn as any).toSpliced(0, 1, msg('ghost'));
  assert.deepEqual(spliced.map((m: any) => m.id), ['m1']);
  assert.deepEqual(inbox.claim(), []);
});

test('QueueInbox.remove drops locally at once, deletes the pending row, and blocks stale refreshes until written', async () => {
  const pool = fakePool(1);
  const inbox = new QueueInbox(pool, () => {});
  const rows = [row('1'), row('2')];
  inbox.refresh(projectQueue(rows, new Set()));
  assert.equal(inbox.remove('m1'), true);
  assert.deepEqual(inbox.nextTurn.map((m) => m.id), ['m2']);
  // a tail tick racing the DELETE must not resurrect m1
  assert.equal(inbox.refresh(projectQueue(rows, new Set())), false);
  assert.deepEqual(inbox.nextTurn.map((m) => m.id), ['m2']);
  await new Promise((r) => setTimeout(r, 0));
  assert.match(pool.calls[0].sql, /DELETE FROM dsh_thread_queue WHERE id = \$1 AND admitted_at IS NULL/);
  assert.deepEqual(pool.calls[0].params, ['1']);
  assert.equal(inbox.remove('nope'), false);
});

test('QueueInbox.replace keeps the id, swaps content, and rewrites the pending row payload', async () => {
  const pool = fakePool(1);
  const inbox = new QueueInbox(pool, () => {});
  inbox.refresh(projectQueue([row('1')], new Set()));
  assert.equal(inbox.replace('m1', msg('m1', 'edited')), true);
  assert.equal((inbox.nextTurn[0].content as any)[0].text, 'edited');
  await new Promise((r) => setTimeout(r, 0));
  assert.match(pool.calls[0].sql, /UPDATE dsh_thread_queue SET payload = \$2, message_id = \$3 WHERE id = \$1 AND admitted_at IS NULL/);
  assert.equal(pool.calls[0].params[0], '1');
  assert.equal(JSON.parse(pool.calls[0].params[1] as string).message.content[0].text, 'edited');
});

test('QueueInbox.add is idempotent per message id', () => {
  const inbox = new QueueInbox(fakePool(), () => {});
  inbox.add({ queueId: '1', kind: 'queued', message: msg('m1') });
  inbox.add({ queueId: '1', kind: 'queued', message: msg('m1') });
  assert.equal(inbox.nextTurn.length, 1);
});
