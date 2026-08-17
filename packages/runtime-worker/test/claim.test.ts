import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';
import { claimNext, markStale, release } from '../src/claim.ts';

const PG_URL = process.env.PG_URL;
let pool: any;

before(async () => {
  if (!PG_URL) return;
  pool = createPool(PG_URL);
  await runMigrations(pool);
  await pool.query('TRUNCATE dsh_questions, dsh_thread_queue, dsh_threads, dsh_session_events, dsh_sessions');
});
after(async () => { await pool?.end(); });

async function seed(sid: string) {
  await pool.query('INSERT INTO dsh_sessions (id, header) VALUES ($1, $2)', [sid, { version: 1, id: sid, createdAt: 1 }]);
  await pool.query('INSERT INTO dsh_threads (session_id, runtime_class) VALUES ($1, $2)', [sid, 'default']);
  await pool.query('INSERT INTO dsh_thread_queue (session_id, kind, payload) VALUES ($1, $2, $3)', [
    sid, 'queued', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
  ]);
}

test('two workers cannot claim the same queued item', { skip: !PG_URL }, async () => {
  await seed('t1');
  const [a, b] = await Promise.all([claimNext(pool, 'default', 'podA'), claimNext(pool, 'default', 'podB')]);
  assert.equal([a, b].filter(Boolean).length, 1);
  const t = await pool.query('SELECT status, running_pod FROM dsh_threads WHERE session_id = $1', ['t1']);
  assert.equal(t.rows[0].status, 'running');
});

test('release sets idle; stale running threads become interrupted', { skip: !PG_URL }, async () => {
  const pod = (await pool.query('SELECT running_pod FROM dsh_threads WHERE session_id=$1', ['t1'])).rows[0].running_pod;
  await release(pool, 't1', pod, 'idle');
  assert.equal((await pool.query("SELECT status FROM dsh_threads WHERE session_id='t1'")).rows[0].status, 'idle');
  await seed('t2');
  const c = await claimNext(pool, 'default', 'podC');
  assert.ok(c);
  await pool.query("UPDATE dsh_threads SET heartbeat_at = now() - interval '2 minutes' WHERE session_id = 't2'");
  const n = await markStale(pool, 30_000);
  assert.equal(n, 1);
  assert.equal((await pool.query("SELECT status FROM dsh_threads WHERE session_id='t2'")).rows[0].status, 'interrupted');
});
