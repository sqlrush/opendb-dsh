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

test('stale reclaim un-admits the dead pod in-flight queue row (W4 debt)', { skip: !PG_URL }, async () => {
  // isolate from earlier tests: the fixed markStale re-offers their stale rows, which claimNext would pick first
  await pool.query('TRUNCATE dsh_questions, dsh_thread_queue, dsh_threads, dsh_session_events, dsh_sessions');
  await seed('t3');
  const claimed = await claimNext(pool, 'default', 'podDead');
  assert.ok(claimed);
  // pod dies mid-run: heartbeat goes stale while queue row stays admitted
  await pool.query("UPDATE dsh_threads SET heartbeat_at = now() - interval '2 minutes' WHERE session_id = 't3'");
  const n = await markStale(pool, 30_000);
  assert.equal(n, 1);
  const q = await pool.query("SELECT admitted_at, admitted_by FROM dsh_thread_queue WHERE session_id = 't3' AND kind = 'queued'");
  assert.equal(q.rows[0].admitted_at, null, 'in-flight row must be re-offered');
  // another worker can now re-claim the same prompt (at-least-once delivery)
  const re = await claimNext(pool, 'default', 'podHeir');
  assert.ok(re, 'heir pod must be able to claim');
  assert.equal(re.sessionId, 't3');
  assert.equal(re.queueId, claimed.queueId, 'same queue row is re-delivered');
});

test('stale reclaim only touches the dead pod own rows', { skip: !PG_URL }, async () => {
  // t3 is now running under podHeir with a fresh heartbeat; a completed (released) session must not be affected
  await seed('t4');
  const c4 = await claimNext(pool, 'default', 'podOk');
  assert.ok(c4);
  await release(pool, 't4', 'podOk', 'idle');
  const before = await pool.query("SELECT admitted_at FROM dsh_thread_queue WHERE session_id = 't4'");
  assert.notEqual(before.rows[0].admitted_at, null);
  await markStale(pool, 30_000);
  const after4 = await pool.query("SELECT admitted_at FROM dsh_thread_queue WHERE session_id = 't4'");
  assert.notEqual(after4.rows[0].admitted_at, null, 'completed row of idle session must stay admitted');
  assert.equal((await pool.query("SELECT status FROM dsh_threads WHERE session_id='t3'")).rows[0].status, 'running', 'healthy heir keeps running');
});
