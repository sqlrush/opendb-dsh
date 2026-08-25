import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';
import { claimNext, markStale, pendingSteers, release, requeueFailed } from '../src/claim.ts';

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

test('requeueFailed re-offers the row below the attempt cap and dead-letters it at the cap', { skip: !PG_URL }, async () => {
  await pool.query('TRUNCATE dsh_questions, dsh_thread_queue, dsh_threads, dsh_session_events, dsh_sessions');
  await seed('t5');
  const first = await claimNext(pool, 'default', 'podPoisoned');
  assert.ok(first);
  assert.equal(first.attempts, 0);
  // attempt 1 fails → re-offered
  let out = await requeueFailed(pool, first.queueId, 'deadlock detected', 3);
  assert.deepEqual(out, { attempts: 1, failed: false });
  await release(pool, 't5', 'podPoisoned', 'interrupted');
  let q = await pool.query("SELECT admitted_at, admitted_by, attempts, last_error FROM dsh_thread_queue WHERE id = $1", [first.queueId]);
  assert.equal(q.rows[0].admitted_at, null, 'must be re-claimable by any pod');
  assert.equal(q.rows[0].last_error, 'deadlock detected');
  // another pod picks the SAME row up with the attempt count visible
  const second = await claimNext(pool, 'default', 'podHeir');
  assert.ok(second);
  assert.equal(second.queueId, first.queueId);
  assert.equal(second.attempts, 1);
  out = await requeueFailed(pool, second.queueId, 'boom', 3);
  assert.deepEqual(out, { attempts: 2, failed: false });
  await release(pool, 't5', 'podHeir', 'interrupted');
  const third = await claimNext(pool, 'default', 'podThird');
  assert.ok(third);
  // attempt 3 fails → dead letter: stays admitted, failed_at set, never claimed again
  out = await requeueFailed(pool, third.queueId, 'boom again', 3);
  assert.deepEqual(out, { attempts: 3, failed: true });
  await release(pool, 't5', 'podThird', 'interrupted');
  q = await pool.query("SELECT admitted_at, failed_at, attempts FROM dsh_thread_queue WHERE id = $1", [first.queueId]);
  assert.notEqual(q.rows[0].failed_at, null);
  assert.notEqual(q.rows[0].admitted_at, null, 'dead letter is not re-offered');
  assert.equal(await claimNext(pool, 'default', 'podFourth'), undefined, 'nothing left to claim');
});

test('a turn cut by runtime shutdown is re-offered under a fresh message id (Host dedup must not swallow it)', { skip: !PG_URL }, async () => {
  await pool.query('TRUNCATE dsh_questions, dsh_thread_queue, dsh_threads, dsh_session_events, dsh_sessions');
  await pool.query('INSERT INTO dsh_sessions (id, header) VALUES ($1, $2)', ['t7', { version: 1, id: 't7', createdAt: 1 }]);
  await pool.query('INSERT INTO dsh_threads (session_id, runtime_class) VALUES ($1, $2)', ['t7', 'default']);
  const msg = { id: 'orig-id', role: 'user', content: [{ type: 'text', text: '2' }], source: { kind: 'user' } };
  await pool.query('INSERT INTO dsh_thread_queue (session_id, kind, payload, message_id) VALUES ($1, $2, $3, $4)', ['t7', 'queued', { content: msg.content, source: msg.source, message: msg }, 'orig-id']);
  const c = await claimNext(pool, 'default', 'podDying');
  assert.ok(c);
  const out = await requeueFailed(pool, c.queueId, 'turn interrupted by runtime shutdown', 3, { rotateMessageId: true });
  assert.deepEqual(out, { attempts: 1, failed: false });
  const row = (await pool.query('SELECT message_id, payload, admitted_at FROM dsh_thread_queue WHERE id = $1', [c.queueId])).rows[0];
  assert.equal(row.admitted_at, null, 're-offered');
  assert.notEqual(row.message_id, 'orig-id', 'id rotated');
  assert.equal(row.payload.message.id, row.message_id, 'column and payload agree');
  assert.equal(row.payload.message.content[0].text, '2', 'content untouched');
  // without rotation the id stays (plain failure path)
  await release(pool, 't7', 'podDying', 'interrupted');
  const c2 = await claimNext(pool, 'default', 'podNext');
  assert.ok(c2);
  const before = (await pool.query('SELECT message_id FROM dsh_thread_queue WHERE id = $1', [c2.queueId])).rows[0].message_id;
  await requeueFailed(pool, c2.queueId, 'boom', 3);
  const after = (await pool.query('SELECT message_id FROM dsh_thread_queue WHERE id = $1', [c2.queueId])).rows[0].message_id;
  assert.equal(after, before);
});

test('pendingSteers hands steer rows to the running pod in queue order; idle threads claim them as prompts', { skip: !PG_URL }, async () => {
  await pool.query('TRUNCATE dsh_questions, dsh_thread_queue, dsh_threads, dsh_session_events, dsh_sessions');
  await seed('t6');
  const c = await claimNext(pool, 'default', 'podRun');
  assert.ok(c);
  for (const text of ['s1', 's2']) {
    await pool.query('INSERT INTO dsh_thread_queue (session_id, kind, payload, message_id) VALUES ($1, $2, $3, $4)', [
      't6', 'steer', { content: [{ type: 'text', text }], source: { kind: 'user' }, message: { id: `id-${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } }, `id-${text}`,
    ]);
  }
  const steers = await pendingSteers(pool, 't6', 'podRun');
  assert.deepEqual(steers.map((s) => s.payload.message?.id), ['id-s1', 'id-s2']);
  assert.deepEqual(await pendingSteers(pool, 't6', 'podRun'), [], 'consumed exactly once');
  const admitted = await pool.query("SELECT admitted_by FROM dsh_thread_queue WHERE session_id = 't6' AND kind = 'steer'");
  assert.deepEqual(admitted.rows.map((r) => r.admitted_by), ['podRun', 'podRun']);
  // a steer that lands after the turn ended (race) is claimed like a normal prompt
  await release(pool, 't6', 'podRun', 'idle');
  await pool.query('INSERT INTO dsh_thread_queue (session_id, kind, payload) VALUES ($1, $2, $3)', ['t6', 'steer', { content: [{ type: 'text', text: 'late' }], source: { kind: 'user' } }]);
  const late = await claimNext(pool, 'default', 'podNext');
  assert.ok(late);
  assert.equal(late.kind, 'steer');
});
