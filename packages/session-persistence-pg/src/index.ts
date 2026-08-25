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
  });

  /** Backend label for coordinator diagnostics (shadows Service.name; the service key is already captured). */
  name = 'session-persistence-pg';
  supportsRawArtifacts = false;
  readonly pool: pg.Pool;
  private readonly coordinator: PersistenceCoordinator<number>;
  private readonly ready: Promise<void>;
  private sourceId = 'pg';

  constructor(ctx: Context, config: PgSessionPersistenceConfig) {
    super(ctx);
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
      if (s.rowCount !== 0) e = await client.query<EventRow>(`${SELECT_EVENTS} ORDER BY seq`, [id]);
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
    return this.revision(id, r.rows[0].max_seq, r.rows[0].repair_gen);
  }

  async loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined> {
    signal?.throwIfAborted();
    await this.ready;
    const s = await this.pool.query<{ header: SessionHeader }>('SELECT header FROM dsh_sessions WHERE id = $1', [id]);
    if (s.rowCount === 0) return undefined;
    const e = await this.pool.query<EventRow>(`${SELECT_EVENTS} AND seq >= $2 ORDER BY seq`, [id, fromSeq]);
    return { meta: s.rows[0].header, events: e.rows.map(rowToEvent) };
  }

  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], _isMaterialized: boolean): Promise<void> {
    await this.ready;
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
