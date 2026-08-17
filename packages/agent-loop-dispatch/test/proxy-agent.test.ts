import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { UserQuestionService } from '@deepseek-ai/dsh-user-questions';
import PgSessionPersistence, { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';
import DispatchAgentLoop from '../src/index.ts';

const PG_URL = process.env.PG_URL;
const ctx = new Context();
let pool: any;

before(async () => {
  if (!PG_URL) return;
  pool = createPool(PG_URL);
  await runMigrations(pool);
  await pool.query('TRUNCATE dsh_questions, dsh_thread_queue, dsh_threads, dsh_session_events, dsh_sessions');
  await ctx.plugin(SessionStore);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(UserQuestionService);
  await ctx.plugin(PgSessionPersistence, { connectionString: PG_URL, writeBatchMaxDelayMs: 1 });
  await ctx.plugin(DispatchAgentLoop, { connectionString: PG_URL, tailMs: 50 });
});
after(async () => { await ctx.root.fiber.dispose(); await pool?.end(); });

test('followup enqueues; events written by another writer are mirrored into the live session', { skip: !PG_URL }, async () => {
  const seen: string[] = [];
  (ctx as any).on('session/event', (_s: any, e: any) => { seen.push(e.type); });
  const handle = await (ctx as any).agents.create({ sessionId: 'p0-1', meta: { cwd: '/tmp/opendb-dsh-test' } });
  handle.agent.followup({ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] });
  await new Promise((r) => setTimeout(r, 300));
  const q = await pool.query("SELECT kind, payload FROM dsh_thread_queue WHERE session_id = 'p0-1'");
  assert.equal(q.rows[0].kind, 'queued');
  assert.equal(q.rows[0].payload.content[0].text, 'hello');
  // simulate a Runtime: append after the Host-persisted prefix (seq 0 = session/end-seed), then mark the thread idle
  const base = handle.agent.session.seq;
  await pool.query(`INSERT INTO dsh_session_events (session_id, seq, type, time, data) VALUES
    ('p0-1', ${base}, 'turn/start', 1, '{"turn":1}'), ('p0-1', ${base + 1}, 'turn/end', 2, '{"turn":1,"reason":{"kind":"completed"}}')`);
  await pool.query("UPDATE dsh_thread_queue SET admitted_at = now(), admitted_by = 'sim' WHERE session_id = 'p0-1'");
  await pool.query("UPDATE dsh_threads SET status = 'idle' WHERE session_id = 'p0-1'");
  await handle.agent.whenIdle();
  assert.deepEqual(seen.filter((t) => t.startsWith('turn/')), ['turn/start', 'turn/end']);
  assert.equal(handle.agent.session.seq, base + 2);
  await handle.dispose();
});
