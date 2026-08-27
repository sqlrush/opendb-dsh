import type pg from 'pg';
import { rollbackAndRelease } from '@opendb-dsh/session-persistence-pg';

/** Queue row payload as written by the Host (`agent-loop-dispatch`). `message` carries the Host-minted id. */
export interface QueuePayload {
  content: unknown[];
  source: unknown;
  /** Full frozen user message from the Host (id included) — present since migration 015; older rows lack it. */
  message?: { id: string; role: string; content: unknown[]; source: unknown };
  agentOptions?: { provider?: string; model?: string; maxTokens?: number };
}

/** One admitted queue item plus the session it belongs to. */
export interface Claimed {
  queueId: string;
  sessionId: string;
  kind: 'queued' | 'steer';
  /** Failed runs so far for this row (0 on first delivery). */
  attempts: number;
  payload: QueuePayload;
}

/**
 * Atomically claim the oldest pending `queued`/`steer` item whose thread is idle/interrupted and
 * belongs to `runtimeClass`. Uses FOR UPDATE SKIP LOCKED so concurrent workers never
 * take the same item; the thread row moves to `running` in the same transaction.
 * A `steer` row is only claimed here when its turn already ended (race: the Host saw
 * `running`, the Runtime released a moment later) — it then simply starts a new turn.
 */
export async function claimNext(pool: pg.Pool, runtimeClass: string, podName: string): Promise<Claimed | undefined> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const q = await c.query<{ id: string; session_id: string; kind: 'queued' | 'steer'; attempts: number; payload: QueuePayload }>(
      `SELECT q.id, q.session_id, q.kind, q.attempts, q.payload
         FROM dsh_thread_queue q JOIN dsh_threads t USING (session_id)
        WHERE q.admitted_at IS NULL AND q.failed_at IS NULL AND q.kind IN ('queued','steer')
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
    return { queueId: row.id, sessionId: row.session_id, kind: row.kind, attempts: row.attempts, payload: row.payload };
  } catch (e) {
    await rollbackAndRelease(c);
    throw e;
  }
}

/**
 * Heartbeat doubles as the ownership fence (2026-08-27 incident: Host re-offered a stale-looking turn to a
 * second pod while the first was still running it → the same turn executed on two pods at once).
 * Returns false when this pod no longer owns the thread (Host reaped it / another pod claimed it):
 * the caller must cancel its local turn and must not release, requeue or report anything for it.
 */
export async function heartbeat(pool: pg.Pool, sessionId: string, podName: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE dsh_threads SET heartbeat_at = now() WHERE session_id = $1 AND status = 'running' AND running_pod = $2`,
    [sessionId, podName],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function release(pool: pg.Pool, sessionId: string, podName: string, status: 'idle' | 'interrupted'): Promise<void> {
  await pool.query(
    `UPDATE dsh_threads SET status = $3, running_pod = NULL, updated_at = now() WHERE session_id = $1 AND running_pod = $2`,
    [sessionId, podName, status],
  );
}

/** Outcome of {@link requeueFailed}: re-offered to any pod, or dead-lettered after the attempt cap. */
export interface RequeueOutcome { attempts: number; failed: boolean }

/**
 * A run threw before the turn closed (2026-08-25 poisoned-pod incident: every resume failed in
 * 9ms and the admitted row became a silent dead letter). Count the attempt; below the cap,
 * un-admit the row so ANY pod re-claims it (the failing pod sits out a penalty window, see
 * worker); at the cap, stamp `failed_at` — the Host reports it to the user as `agent/error`.
 */
export async function requeueFailed(
  pool: pg.Pool, queueId: string, error: string, maxAttempts: number,
  options: { rotateMessageId?: boolean; ownerPod?: string } = {},
): Promise<RequeueOutcome | undefined> {
  // 被 pod 终止切断的轮次：user/message 已经落日志了，原 id 再投会被 Host 的 settleDurable 当作「已处理」吞掉，
  // 也不能让同一 id 在日志里出现两次——换一个新 id 重投，日志上就是"系统重发了一遍"（第一轮标 interrupted）。
  // ownerPod：只有这一行仍由本 pod 领着（admitted_by = 本 pod）才重投——被 Host 回收/别的 pod 已重领的行不归本 pod 管
  //（2026-08-27：崩溃 pod 的关机钩子把别人已经完成的轮次又投了一遍）。
  const rotate = options.rotateMessageId === true;
  const r = await pool.query<{ session_id: string; attempts: number; failed: boolean }>(
    `UPDATE dsh_thread_queue
        SET attempts    = attempts + 1,
            last_error  = left($2, 2000),
            admitted_at = CASE WHEN attempts + 1 >= $3 THEN admitted_at ELSE NULL END,
            admitted_by = CASE WHEN attempts + 1 >= $3 THEN admitted_by ELSE NULL END,
            failed_at   = CASE WHEN attempts + 1 >= $3 THEN now() ELSE NULL END,
            message_id  = CASE WHEN $4 AND attempts + 1 < $3 AND payload ? 'message' THEN gen_random_uuid()::text ELSE message_id END,
            payload     = CASE WHEN $4 AND attempts + 1 < $3 AND payload ? 'message'
                               THEN jsonb_set(payload, '{message,id}', to_jsonb(gen_random_uuid()::text), false)
                               ELSE payload END
      WHERE id = $1 AND ($5::text IS NULL OR admitted_by = $5)
      RETURNING session_id, attempts, (failed_at IS NOT NULL) AS failed`,
    [queueId, error, maxAttempts, rotate, options.ownerPod ?? null],
  );
  if (r.rows[0] === undefined) return undefined;
  if (rotate && r.rows[0] !== undefined && !r.rows[0].failed) {
    // 两处 gen_random_uuid() 各自取值：把列同步成 payload 里的那个
    await pool.query(`UPDATE dsh_thread_queue SET message_id = payload->'message'->>'id' WHERE id = $1 AND payload ? 'message'`, [queueId]);
  }
  const row = r.rows[0];
  if (!row.failed) {
    await pool.query(`SELECT pg_notify('opendb_thread_wake', $1)`, [row.session_id]).catch(() => { /* poll 保底 */ });
  }
  return { attempts: row.attempts, failed: row.failed };
}

/**
 * Consume pending `steer` rows of a RUNNING session (the pod that owns the turn polls this):
 * they are steered into the current turn via `agent.steer()`. Returned in queue order.
 */
export async function pendingSteers(pool: pg.Pool, sessionId: string, podName: string): Promise<Array<{ queueId: string; payload: QueuePayload }>> {
  const r = await pool.query<{ id: string; payload: QueuePayload }>(
    `WITH picked AS (
        SELECT id FROM dsh_thread_queue
         WHERE session_id = $1 AND kind = 'steer' AND admitted_at IS NULL AND failed_at IS NULL
         FOR UPDATE SKIP LOCKED)
     UPDATE dsh_thread_queue q SET admitted_at = now(), admitted_by = $2
       FROM picked WHERE q.id = picked.id
     RETURNING q.id, q.payload`,
    [sessionId, podName],
  );
  return [...r.rows].sort((a, b) => Number(a.id) - Number(b.id)).map((row) => ({ queueId: row.id, payload: row.payload }));
}

/**
 * Any `running` thread whose heartbeat is older than `olderThanMs` is an orphan → interrupted
 * (re-claimable). The dead pod's in-flight queue row (its latest admitted `queued`/`steer` row for that
 * session) is un-admitted in the same statement so the prompt is re-delivered by the next claim
 * (at-least-once: a pod that died between turn completion and release may cause one duplicate turn —
 * the Host settles rows whose message is already durable, see agent-loop-dispatch `settleDurable`).
 */
export async function markStale(pool: pg.Pool, olderThanMs: number): Promise<number> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const reset = await c.query<{ session_id: string; running_pod: string }>(
      `WITH victims AS (
          SELECT session_id, running_pod FROM dsh_threads
           WHERE status = 'running' AND heartbeat_at < now() - ($1 || ' milliseconds')::interval
           FOR UPDATE SKIP LOCKED
       )
       UPDATE dsh_threads t SET status = 'interrupted', running_pod = NULL, updated_at = now()
         FROM victims v WHERE t.session_id = v.session_id
       RETURNING v.session_id, v.running_pod`,
      [String(olderThanMs)],
    );
    for (const v of reset.rows) {
      await c.query(
        `UPDATE dsh_thread_queue SET admitted_at = NULL, admitted_by = NULL
          WHERE session_id = $1 AND admitted_by = $2 AND kind IN ('queued','steer') AND failed_at IS NULL
            AND id = (SELECT max(id) FROM dsh_thread_queue
                       WHERE session_id = $1 AND admitted_by = $2 AND kind IN ('queued','steer') AND failed_at IS NULL)`,
        [v.session_id, v.running_pod],
      );
    }
    await c.query('COMMIT');
    c.release();
    return reset.rowCount ?? 0;
  } catch (e) {
    await rollbackAndRelease(c);
    throw e;
  }
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
