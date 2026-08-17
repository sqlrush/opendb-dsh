/**
 * Conformance tests for the PostgreSQL PersistenceBackend.
 * Requires PG_URL (see scripts/dev-pg.sh); every test is skipped when it is absent.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import PgSessionPersistence, { createPool, runMigrations } from '../src/index.ts';

const PG_URL = process.env.PG_URL;
const ctx = new Context();
let persistence: PgSessionPersistence;

const header = (id: string) => ({ version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd: '/tmp/opendb-dsh-test' });
const turnStart = (seq: number) => ({ type: 'turn/start', seq, time: seq + 1, data: { turn: 1 } });

before(async () => {
  if (!PG_URL) return;
  const pool = createPool(PG_URL);
  await runMigrations(pool);
  await pool.query('TRUNCATE dsh_questions, dsh_thread_queue, dsh_threads, dsh_session_events, dsh_sessions');
  await pool.end();
  ctx.plugin(SessionStore);
  await ctx.plugin(PgSessionPersistence, { connectionString: PG_URL, writeBatchMaxDelayMs: 1 });
  persistence = ctx.get('sessionPersistence') as PgSessionPersistence;
});
after(async () => { await ctx.root.fiber.dispose(); });

test('append then load round-trips events with contiguous seq and surfaceOp', { skip: !PG_URL }, async () => {
  const id = `s-${Date.now()}-a`;
  await persistence.create(header(id) as any);
  await persistence.append(id as any, [
    turnStart(0) as any,
    { type: 'user/message', seq: 1, time: 2, data: { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }, surfaceOp: 'append' } as any,
  ]);
  const loaded = await persistence.load(id as any);
  assert.equal(loaded.events.length, 2);
  assert.deepEqual(loaded.events.map((e) => e.seq), [0, 1]);
  assert.equal((loaded.events[1] as any).surfaceOp, 'append');
});

test('readFrom returns only the suffix', { skip: !PG_URL }, async () => {
  const id = `s-${Date.now()}-b`;
  await persistence.create(header(id) as any);
  await persistence.append(id as any, [turnStart(0), turnStart(1), turnStart(2)] as any);
  const suffix = await persistence.readFrom(id as any, 2);
  assert.deepEqual(suffix.events.map((e) => e.seq), [2]);
});

test('duplicate (session_id, seq) inserts are ignored (idempotent mirror)', { skip: !PG_URL }, async () => {
  const id = `s-${Date.now()}-c`;
  const events = [turnStart(0)] as any;
  await persistence.appendBatch(header(id) as any, events, false);
  await persistence.appendBatch(header(id) as any, events, true);
  const loaded = await persistence.load(id as any);
  assert.equal(loaded.events.length, 1);
});

test('list returns headers; revision changes on append', { skip: !PG_URL }, async () => {
  const id = `s-${Date.now()}-d`;
  await persistence.appendBatch(header(id) as any, [turnStart(0)] as any, false);
  const r1 = await persistence.readStoredRevision(id as any);
  await persistence.appendBatch(header(id) as any, [{ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: 'completed' } }] as any, true);
  const r2 = await persistence.readStoredRevision(id as any);
  assert.notEqual(r1, r2);
  assert.ok((await persistence.list()).some((h) => h.id === id));
});

test('commitRepair truncates the torn tail and bumps the revision', { skip: !PG_URL }, async () => {
  const id = `s-${Date.now()}-e`;
  await persistence.appendBatch(header(id) as any, [turnStart(0), turnStart(1), turnStart(2)] as any, false);
  const before = await persistence.readStoredRevision(id as any);
  await persistence.commitRepair(header(id) as any, 2, [{ type: 'turn/end', seq: 2, time: 9, data: { turn: 1, reason: 'interrupted' } }] as any);
  const stored = await persistence.loadStored(id as any);
  assert.deepEqual(stored?.events.map((e) => [e.seq, e.type]), [[0, 'turn/start'], [1, 'turn/start'], [2, 'turn/end']]);
  assert.notEqual(before, stored?.revision);
});
