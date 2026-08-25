import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  MAX_WRITE_BATCH_DELAY_MS,
  PersistenceCoordinator,
  SessionPersistence,
  SessionPersistenceRevision,
  type PersistenceBackend,
  type SessionPersistenceSnapshot,
  type StoredPrefix,
  type StoredSuffix,
} from '@deepseek-ai/dsh-session-persistence';
import type pg from 'pg';
import { createPool, rollbackAndRelease } from './pool.ts';
import { runMigrations } from './schema.ts';

export { createPool, rollbackAndRelease } from './pool.ts';
export { runMigrations, migrationFailures, SQL_DIR } from './schema.ts';

interface EventRow {
  seq: number;
  type: string;
  time: string | number;
  data: unknown;
  ignorable: boolean | null;
  surface_op: string | null;
  source_event_seqs: number[] | null;
}

type StoredEvent = SessionEvent & { surfaceOp?: string; sourceEventSeqs?: number[]; ignorable?: true };

export interface PgSessionPersistenceConfig {
  connectionString: string;
  preparedSessionCacheSize?: number;
  writeBatchMaxDelayMs?: number;
  guardRunningThreads?: boolean;
}

function rowToEvent(r: EventRow): SessionEvent {
  const ev: Record<string, unknown> = { type: r.type, seq: r.seq, time: Number(r.time), data: r.data };
  if (r.ignorable) ev.ignorable = true;
  if (r.surface_op) ev.surfaceOp = r.surface_op;
  if (r.source_event_seqs) ev.sourceEventSeqs = r.source_event_seqs;
  return ev as SessionEvent;
}

const SELECT_EVENTS = 'SELECT seq, type, time, data, ignorable, surface_op, source_event_seqs FROM dsh_session_events WHERE session_id = $1';
const INSERT_EVENT =
  'INSERT INTO dsh_session_events (session_id, seq, type, time, data, ignorable, surface_op, source_event_seqs) ' +
  'VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (session_id, seq) DO NOTHING';

/** How long one `runtimeOwns` answer is reused (ms). */
const OWNED_CACHE_MS = 1000;

async function insertEvents(client: pg.PoolClient, sessionId: string, events: readonly SessionEvent[]): Promise<void> {
  for (const raw of events) {
    const e = raw as StoredEvent;
    await client.query(INSERT_EVENT, [
      sessionId, e.seq, e.type, e.time, JSON.stringify(e.data),
      e.ignorable ?? null, e.surfaceOp ?? null, e.sourceEventSeqs ?? null,
    ]);
  }
}

/**
 * PostgreSQL persistence backend for `ctx.sessionPersistence`.
 *
 * - Service key is fixed by the base class (`sessionPersistence`); no ctx.provide needed.
 * - Writes are idempotent on `(session_id, seq)` so a mirroring Host process that replays
 *   Runtime-written events into its own live Session never double-writes.
 * - `create()` persists the header immediately (design §9: Runtime must be able to
 *   `resume` a session that has a header but no events yet).
 * - TornMarker = starting seq of the torn tail (same convention as the SQLite backend).
 */
export default class PgSessionPersistence extends SessionPersistence implements PersistenceBackend<number> {
  static inject = ['sessions'];
  static Config = z.object({
    connectionString: z.string().required(),
    preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS).default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
    /**
     * Host 侧开启：会话线程正在被 Runtime 运行（或有待认领的提问）时，本进程对该会话的任何落库都跳过。
     * 2026-08-25：无亲和的 Host 副本在 Runtime 运行中 resume 会话，dsh 会补 step/end + turn/end(interrupted) +
     * session/end-seed 并落库，与 Runtime 同 seq 的真实事件 ON CONFLICT DO NOTHING 互撞——先到者赢，输家静默丢失。
     */
    guardRunningThreads: z.boolean().default(false),
  });

  /** Backend label for coordinator diagnostics (shadows Service.name; the service key is already captured). */
  name = 'session-persistence-pg';
  supportsRawArtifacts = false;
  readonly pool: pg.Pool;
  private readonly coordinator: PersistenceCoordinator<number>;
  private readonly ready: Promise<void>;
  private sourceId = 'pg';
  private readonly guard: boolean;
  /** 每个会话最多每分钟打一条「跳过落库」日志 */
  private readonly skipLoggedAt = new Map<string, number>();
  /** runtimeOwns 的短缓存：write-behind 每批都会问一次，流式 turn 一秒几十批 */
  private readonly ownedCache = new Map<string, { owned: boolean; at: number }>();

  constructor(ctx: Context, config: PgSessionPersistenceConfig) {
    super(ctx);
    this.guard = config.guardRunningThreads === true;
    this.pool = createPool(config.connectionString);
    this.ready = runMigrations(this.pool).then(async () => {
      const r = await this.pool.query<{ oid: string }>('SELECT oid::text FROM pg_database WHERE datname = current_database()');
      this.sourceId = `pg:${r.rows[0]?.oid ?? '0'}`;
    });
    this.ready.catch(() => { /* surfaced by the first awaiting call */ });
    this.coordinator = new PersistenceCoordinator<number>(this.ctx, this, {
      preparedSessionCacheSize: config.preparedSessionCacheSize ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs: config.writeBatchMaxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    });
  }

  // ---------------------------------------------------------------- service face
  locate(): undefined { return undefined; }
  async create(meta: SessionHeader): Promise<void> {
    await this.ready;
    await this.coordinator.create(meta);
    await this.pool.query('INSERT INTO dsh_sessions (id, header) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [meta.id, meta]);
  }
  append(id: SessionId, events: readonly SessionEvent[]) { return this.coordinator.append(id, events); }
  prepare(id: SessionId, signal?: AbortSignal) { return this.coordinator.prepare(id, signal); }
  load(id: SessionId) { return this.coordinator.load(id); }
  inspect(id: SessionId, signal?: AbortSignal) { return this.coordinator.inspect(id, signal); }
  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal) { return this.coordinator.readFrom(id, fromSeq, signal); }
  async listSnapshots(): Promise<SessionPersistenceSnapshot[]> {
    await this.ready;
    const r = await this.pool.query<{ header: SessionHeader; max_seq: number | null; repair_gen: number }>(
      'SELECT s.header, s.repair_gen, (SELECT max(seq) FROM dsh_session_events e WHERE e.session_id = s.id) AS max_seq FROM dsh_sessions s',
    );
    return r.rows.map((row) => ({ header: row.header, revision: this.revision(row.header.id, row.max_seq, row.repair_gen) }));
  }

  // ---------------------------------------------------------------- backend face
  private revision(id: string, maxSeq: number | null, repairGen: number) {
    return SessionPersistenceRevision(`${this.sourceId}:${id}:${maxSeq ?? -1}:${repairGen}`);
  }

  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<number> | undefined> {
    signal?.throwIfAborted();
    await this.ready;
    const client = await this.pool.connect();
    let s: pg.QueryResult<{ header: SessionHeader; repair_gen: number }>;
    let e: pg.QueryResult<EventRow> | undefined;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      s = await client.query<{ header: SessionHeader; repair_gen: number }>('SELECT header, repair_gen FROM dsh_sessions WHERE id = $1', [id]);
      if (s.rowCount !== 0) {
        const cut = await this.ownedCut(id, client);   // same snapshot as the event read below
        e = cut === undefined
          ? await client.query<EventRow>(`${SELECT_EVENTS} ORDER BY seq`, [id])
          : await client.query<EventRow>(`${SELECT_EVENTS} AND seq <= $2 ORDER BY seq`, [id, cut]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await rollbackAndRelease(client);
      throw err;
    }
    client.release();
    if (e === undefined) return undefined;
    const events = e.rows.map(rowToEvent);
    const maxSeq = events.length > 0 ? events[events.length - 1].seq : null;
    return { meta: s.rows[0].header, events, revision: this.revision(id, maxSeq, s.rows[0].repair_gen) };
  }

  async readStoredRevision(id: SessionId, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.ready;
    const r = await this.pool.query<{ repair_gen: number; max_seq: number | null }>(
      'SELECT s.repair_gen, (SELECT max(seq) FROM dsh_session_events e WHERE e.session_id = s.id) AS max_seq FROM dsh_sessions s WHERE s.id = $1',
      [id],
    );
    if (r.rowCount === 0) return undefined;
    // must agree with loadStored: while a Runtime owns the log the revision names the cut prefix
    const cut = await this.ownedCut(id, this.pool);
    const maxSeq = cut === undefined ? r.rows[0].max_seq : Math.min(cut, r.rows[0].max_seq ?? cut);
    return this.revision(id, maxSeq, r.rows[0].repair_gen);
  }

  async loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined> {
    signal?.throwIfAborted();
    await this.ready;
    const s = await this.pool.query<{ header: SessionHeader }>('SELECT header FROM dsh_sessions WHERE id = $1', [id]);
    if (s.rowCount === 0) return undefined;
    const e = await this.pool.query<EventRow>(`${SELECT_EVENTS} AND seq >= $2 ORDER BY seq`, [id, fromSeq]);
    return { meta: s.rows[0].header, events: e.rows.map(rowToEvent) };
  }

  /**
   * True when a Runtime owns this session's log right now (thread running, or a prompt waiting to be
   * claimed — the claim can race this process's write). Only consulted with `guardRunningThreads`.
   */
  private async runtimeOwns(sessionId: string, q: Pick<pg.PoolClient, 'query'> = this.pool): Promise<boolean> {
    const cached = this.ownedCache.get(sessionId);
    if (cached !== undefined && Date.now() - cached.at < OWNED_CACHE_MS) return cached.owned;
    const r = await q.query<{ owned: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM dsh_threads WHERE session_id = $1 AND status = 'running')
           OR EXISTS (SELECT 1 FROM dsh_thread_queue WHERE session_id = $1 AND kind IN ('queued','steer')
                        AND admitted_at IS NULL AND failed_at IS NULL) AS owned`,
      [sessionId],
    );
    const owned = r.rows[0]?.owned === true;
    this.ownedCache.set(sessionId, { owned, at: Date.now() });
    return owned;
  }

  /**
   * While a Runtime owns the log, this process reads the session only up to its last `session/end-seed`
   * (inclusive): every Runtime claim resumes the session and writes that marker right before the turn it
   * runs, so the prefix ends balanced — no open turn for the coordinator to "repair" (skipping the repair
   * made it re-prepare forever), no closers, and the Session constructor does not add another marker
   * either. The tail (`readFrom`) is NOT cut, so the live turn mirrors in from exactly the next seq.
   * Returns undefined when nothing has to be cut.
   */
  private async ownedCut(sessionId: string, q: Pick<pg.PoolClient, 'query'>): Promise<number | undefined> {
    if (!this.guard || !(await this.runtimeOwns(sessionId, q))) return undefined;
    const r = await q.query<{ cut: number | null }>(
      `SELECT max(seq) AS cut FROM dsh_session_events WHERE session_id = $1 AND type = 'session/end-seed'`,
      [sessionId],
    );
    const cut = r.rows[0]?.cut;
    return cut === null || cut === undefined ? undefined : Number(cut);
  }

  private logSkip(sessionId: string, what: string): void {
    const now = Date.now();
    if (now - (this.skipLoggedAt.get(sessionId) ?? 0) < 60_000) return;
    this.skipLoggedAt.set(sessionId, now);
    process.stderr.write(`[session-persistence-pg] ${sessionId}: skipped ${what} — a Runtime owns this session's log (guardRunningThreads)\n`);
  }

  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], _isMaterialized: boolean): Promise<void> {
    await this.ready;
    if (this.guard && events.length > 0 && await this.runtimeOwns(meta.id)) {
      this.logSkip(meta.id, `${events.length} local event(s) from seq ${(events[0] as StoredEvent).seq}`);
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO dsh_sessions (id, header) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [meta.id, meta]);
      await insertEvents(client, meta.id, events);
      await client.query('UPDATE dsh_sessions SET updated_at = now() WHERE id = $1', [meta.id]);
      await client.query('COMMIT');
    } catch (err) {
      await rollbackAndRelease(client);
      throw err;
    }
    client.release();
  }

  async commitRepair(meta: SessionHeader, tornMarker: number | undefined, closers: readonly SessionEvent[]): Promise<void> {
    await this.ready;
    // 「未闭合的 turn」在这里不是撕裂，而是 Runtime 正在跑：闭合事件只留在本进程内存，绝不落库
    if (this.guard && (closers.length > 0 || tornMarker !== undefined) && await this.runtimeOwns(meta.id)) {
      this.logSkip(meta.id, `repair (${closers.length} closer(s)${tornMarker === undefined ? '' : `, torn from ${tornMarker}`})`);
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (tornMarker !== undefined) await client.query('DELETE FROM dsh_session_events WHERE session_id = $1 AND seq >= $2', [meta.id, tornMarker]);
      await insertEvents(client, meta.id, closers);
      await client.query('UPDATE dsh_sessions SET repair_gen = repair_gen + 1, updated_at = now() WHERE id = $1', [meta.id]);
      await client.query('COMMIT');
    } catch (err) {
      await rollbackAndRelease(client);
      throw err;
    }
    client.release();
  }

  async list(): Promise<SessionHeader[]> {
    await this.ready;
    const r = await this.pool.query<{ header: SessionHeader }>('SELECT header FROM dsh_sessions ORDER BY created_at');
    return r.rows.map((x) => x.header);
  }

  async close(): Promise<void> {
    await this.ready.catch(() => {});
    await this.pool.end();
  }
}

export { PgSessionPersistence };
