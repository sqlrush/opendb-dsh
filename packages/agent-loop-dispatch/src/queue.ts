import type pg from 'pg';
import { rollbackAndRelease } from '@opendb-dsh/session-persistence-pg';

/** `queued` = 下一轮的用户消息；`steer` = 插进 Runtime 正在跑的这一轮（原生 next-step 语义）。 */
export type QueueKind = 'queued' | 'steer';

/** Payload persisted in `dsh_thread_queue.payload`; `message` is the Host-minted frozen user message (id included). */
export interface QueuePayload {
  content: unknown[];
  source: unknown;
  message?: { id: string; role: string; content: unknown[]; source: unknown };
  agentOptions?: unknown;
}

/** One non-failed queue row of a session as the Host's tail sees it. */
export interface OpenRow {
  queueId: string;
  kind: QueueKind;
  messageId: string | null;
  admitted: boolean;
  attempts: number;
  payload: QueuePayload;
}

/** A dead-lettered row the Host has not yet surfaced to the user. */
export interface FailedRow { queueId: string; messageId: string | null; attempts: number; lastError: string | null }

export async function ensureThread(pool: pg.Pool, sessionId: string, runtimeClass: string): Promise<void> {
  await pool.query(`INSERT INTO dsh_threads (session_id, runtime_class) VALUES ($1, $2) ON CONFLICT (session_id) DO NOTHING`, [sessionId, runtimeClass]);
}

/** Insert one prompt row (message id denormalized for the durability check) and wake the Runtime. Returns the queue id. */
export async function enqueue(pool: pg.Pool, sessionId: string, payload: QueuePayload, kind: QueueKind = 'queued'): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO dsh_thread_queue (session_id, kind, payload, message_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [sessionId, kind, JSON.stringify(payload), payload.message?.id ?? null],
  );
  // P3 LISTEN/NOTIFY：入队即拍醒 runtime-worker（毫秒级领取；2s poll 保底——信号 at-most-once）
  await pool.query(`SELECT pg_notify('opendb_thread_wake', $1)`, [sessionId]).catch(() => { /* 提示信号，丢了有 poll */ });
  return r.rows[0].id;
}
export async function interrupt(pool: pg.Pool, sessionId: string): Promise<void> {
  await pool.query(`INSERT INTO dsh_thread_queue (session_id, kind) VALUES ($1, 'interrupt')`, [sessionId]);
  await pool.query(`SELECT pg_notify('opendb_thread_wake', $1)`, [sessionId]).catch(() => { /* same */ });
}
export async function threadStatus(pool: pg.Pool, sessionId: string): Promise<'idle' | 'running' | 'interrupted' | undefined> {
  const r = await pool.query<{ status: 'idle' | 'running' | 'interrupted' }>('SELECT status FROM dsh_threads WHERE session_id = $1', [sessionId]);
  return r.rows[0]?.status;
}
/** Prompts nobody has picked up yet (dead letters excluded — they are reported, not waited for). */
export async function pendingQueue(pool: pg.Pool, sessionId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM dsh_thread_queue
      WHERE session_id = $1 AND kind IN ('queued','steer') AND admitted_at IS NULL AND failed_at IS NULL`,
    [sessionId],
  );
  return Number(r.rows[0].n);
}

/**
 * Rows the queue projection may still need to show: every pending row, plus recently admitted rows
 * (the Runtime has them but may not have persisted `user/message` yet — the caller drops the ones
 * whose message id is already durable). Pre-015 rows without a message id are only listed while pending.
 */
export async function openRows(pool: pg.Pool, sessionId: string): Promise<OpenRow[]> {
  const r = await pool.query<{ id: string; kind: QueueKind; message_id: string | null; admitted: boolean; attempts: number; payload: QueuePayload }>(
    `SELECT id, kind, message_id, (admitted_at IS NOT NULL) AS admitted, attempts, payload
       FROM dsh_thread_queue
      WHERE session_id = $1 AND kind IN ('queued','steer') AND failed_at IS NULL
        AND (admitted_at IS NULL OR (message_id IS NOT NULL AND admitted_at > now() - interval '10 minutes'))
      ORDER BY id`,
    [sessionId],
  );
  return r.rows.map((row) => ({ queueId: row.id, kind: row.kind, messageId: row.message_id, admitted: row.admitted, attempts: row.attempts, payload: row.payload }));
}

/** Native `updateQueue` remove: only a row nobody admitted yet can be retracted. */
export async function removePending(pool: pg.Pool, queueId: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM dsh_thread_queue WHERE id = $1 AND admitted_at IS NULL`, [queueId]);
  return (r.rowCount ?? 0) > 0;
}
/** Native `updateQueue` edit: rewrite the payload of a still-pending row. */
export async function replacePending(pool: pg.Pool, queueId: string, payload: QueuePayload): Promise<boolean> {
  const r = await pool.query(
    `UPDATE dsh_thread_queue SET payload = $2, message_id = $3 WHERE id = $1 AND admitted_at IS NULL`,
    [queueId, JSON.stringify(payload), payload.message?.id ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * A re-offered row whose message is already in the durable log (the pod died AFTER persisting the
 * turn but before release) must not run twice: settle it as admitted by the Host.
 */
export async function settleDurable(pool: pg.Pool, sessionId: string, messageIds: readonly string[]): Promise<number> {
  if (messageIds.length === 0) return 0;
  const r = await pool.query(
    `UPDATE dsh_thread_queue SET admitted_at = now(), admitted_by = 'host-dedup'
      WHERE session_id = $1 AND admitted_at IS NULL AND failed_at IS NULL AND message_id = ANY($2::text[])`,
    [sessionId, [...messageIds]],
  );
  return r.rowCount ?? 0;
}

export async function unreportedFailures(pool: pg.Pool, sessionId: string): Promise<FailedRow[]> {
  const r = await pool.query<{ id: string; message_id: string | null; attempts: number; last_error: string | null }>(
    `SELECT id, message_id, attempts, last_error FROM dsh_thread_queue
      WHERE session_id = $1 AND failed_at IS NOT NULL AND reported_at IS NULL ORDER BY id`,
    [sessionId],
  );
  return r.rows.map((row) => ({ queueId: row.id, messageId: row.message_id, attempts: row.attempts, lastError: row.last_error }));
}
export async function markReported(pool: pg.Pool, queueIds: readonly string[]): Promise<void> {
  if (queueIds.length === 0) return;
  await pool.query(`UPDATE dsh_thread_queue SET reported_at = now() WHERE id = ANY($1::bigint[])`, [[...queueIds]]);
}

/**
 * Host-side stale reaper for ONE thread (the Runtime's `markStale` covers the fleet, but when every
 * Runtime is dead nobody runs it): a `running` thread with a heartbeat older than `staleMs` is
 * interrupted and its in-flight row re-offered. Returns true when it fired.
 */
export async function reapStaleThread(pool: pg.Pool, sessionId: string, staleMs: number): Promise<boolean> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const v = await c.query(
      `UPDATE dsh_threads SET status = 'interrupted', running_pod = NULL, updated_at = now()
        WHERE session_id = $1 AND status = 'running' AND heartbeat_at < now() - ($2 || ' milliseconds')::interval
        RETURNING session_id`,
      [sessionId, String(staleMs)],
    );
    if (v.rowCount === 0) { await c.query('COMMIT'); c.release(); return false; }
    await c.query(
      `UPDATE dsh_thread_queue SET admitted_at = NULL, admitted_by = NULL
        WHERE session_id = $1 AND kind IN ('queued','steer') AND failed_at IS NULL AND admitted_at IS NOT NULL
          AND admitted_by NOT IN ('interrupt','host-dedup')
          AND id = (SELECT max(id) FROM dsh_thread_queue
                     WHERE session_id = $1 AND kind IN ('queued','steer') AND failed_at IS NULL AND admitted_at IS NOT NULL
                       AND admitted_by NOT IN ('interrupt','host-dedup'))`,
      [sessionId],
    );
    await c.query('COMMIT');
    c.release();
    return true;
  } catch (e) {
    await rollbackAndRelease(c);
    throw e;
  }
}
