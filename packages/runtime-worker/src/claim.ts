import type pg from 'pg';
import { rollbackAndRelease } from '@opendb-dsh/session-persistence-pg';

/** One admitted queue item plus the session it belongs to. */
export interface Claimed {
  queueId: string;
  sessionId: string;
  payload: { content: unknown[]; source: unknown; agentOptions?: { provider?: string; model?: string; maxTokens?: number } };
}

/**
 * Atomically claim the oldest pending `queued` item whose thread is idle/interrupted and
 * belongs to `runtimeClass`. Uses FOR UPDATE SKIP LOCKED so concurrent workers never
 * take the same item; the thread row moves to `running` in the same transaction.
 */
export async function claimNext(pool: pg.Pool, runtimeClass: string, podName: string): Promise<Claimed | undefined> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const q = await c.query<{ id: string; session_id: string; payload: Claimed['payload'] }>(
      `SELECT q.id, q.session_id, q.payload
         FROM dsh_thread_queue q JOIN dsh_threads t USING (session_id)
        WHERE q.admitted_at IS NULL AND q.kind = 'queued'
          AND t.runtime_class = $1 AND t.status IN ('idle','interrupted')
        ORDER BY q.id LIMIT 1
        FOR UPDATE OF q, t SKIP LOCKED`,
      [runtimeClass],
    );
    if (q.rowCount === 0) { await c.query('COMMIT'); c.release(); return undefined; }
    const row = q.rows[0];
    await c.query(
      `UPDATE dsh_threads SET status = 'running', running_pod = $2, heartbeat_at = now(), updated_at = now() WHERE session_id = $1`,
      [row.session_id, podName],
    );
    await c.query(`UPDATE dsh_thread_queue SET admitted_at = now(), admitted_by = $2 WHERE id = $1`, [row.id, podName]);
    await c.query('COMMIT');
    c.release();
    return { queueId: row.id, sessionId: row.session_id, payload: row.payload };
  } catch (e) {
    await rollbackAndRelease(c);
    throw e;
  }
}

export async function heartbeat(pool: pg.Pool, sessionId: string, podName: string): Promise<void> {
  await pool.query(
    `UPDATE dsh_threads SET heartbeat_at = now() WHERE session_id = $1 AND status = 'running' AND running_pod = $2`,
    [sessionId, podName],
  );
}

export async function release(pool: pg.Pool, sessionId: string, podName: string, status: 'idle' | 'interrupted'): Promise<void> {
  await pool.query(
    `UPDATE dsh_threads SET status = $3, running_pod = NULL, updated_at = now() WHERE session_id = $1 AND running_pod = $2`,
    [sessionId, podName, status],
  );
}

/** Any `running` thread whose heartbeat is older than `olderThanMs` is an orphan → interrupted (re-claimable). */
export async function markStale(pool: pg.Pool, olderThanMs: number): Promise<number> {
  const r = await pool.query(
    `UPDATE dsh_threads SET status = 'interrupted', running_pod = NULL, updated_at = now()
      WHERE status = 'running' AND heartbeat_at < now() - ($1 || ' milliseconds')::interval`,
    [String(olderThanMs)],
  );
  return r.rowCount ?? 0;
}

/** Consume pending interrupt rows for a session; returns how many were consumed. */
export async function pendingInterrupts(pool: pg.Pool, sessionId: string): Promise<number> {
  const r = await pool.query(
    `UPDATE dsh_thread_queue SET admitted_at = now(), admitted_by = 'interrupt'
      WHERE session_id = $1 AND kind = 'interrupt' AND admitted_at IS NULL`,
    [sessionId],
  );
  return r.rowCount ?? 0;
}
