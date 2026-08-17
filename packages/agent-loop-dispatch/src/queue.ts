import type pg from 'pg';

export async function ensureThread(pool: pg.Pool, sessionId: string, runtimeClass: string): Promise<void> {
  await pool.query(`INSERT INTO dsh_threads (session_id, runtime_class) VALUES ($1, $2) ON CONFLICT (session_id) DO NOTHING`, [sessionId, runtimeClass]);
}
export async function enqueue(pool: pg.Pool, sessionId: string, payload: unknown): Promise<void> {
  await pool.query(`INSERT INTO dsh_thread_queue (session_id, kind, payload) VALUES ($1, 'queued', $2)`, [sessionId, JSON.stringify(payload)]);
}
export async function interrupt(pool: pg.Pool, sessionId: string): Promise<void> {
  await pool.query(`INSERT INTO dsh_thread_queue (session_id, kind) VALUES ($1, 'interrupt')`, [sessionId]);
}
export async function threadStatus(pool: pg.Pool, sessionId: string): Promise<'idle' | 'running' | 'interrupted' | undefined> {
  const r = await pool.query<{ status: 'idle' | 'running' | 'interrupted' }>('SELECT status FROM dsh_threads WHERE session_id = $1', [sessionId]);
  return r.rows[0]?.status;
}
export async function pendingQueue(pool: pg.Pool, sessionId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM dsh_thread_queue WHERE session_id = $1 AND kind = 'queued' AND admitted_at IS NULL`,
    [sessionId],
  );
  return Number(r.rows[0].n);
}
