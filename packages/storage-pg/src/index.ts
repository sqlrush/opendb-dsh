import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { StorageError, UNIT_NAME_RE, storageBackendServiceKey } from '@deepseek-ai/dsh-storage';
import type pg from 'pg';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '@opendb-dsh/session-persistence-pg';
import { PgKvUnit, type KvUnitDescriptor } from './unit.ts';

export { PgKvUnit } from './unit.ts';

const SQL_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql', '001_kv.sql');
const MIGRATION_LOCK_KEY = 7_204_211_002;
export const BACKEND_NAME = 'pg';

/** PostgreSQL implementation of dsh's StorageBackend (kv facet only). */
export class PgStorageBackend {
  private readonly open = new Map<string, PgKvUnit>();
  private readonly opening = new Map<string, Promise<PgKvUnit>>();
  private closed = false;
  private readonly ready: Promise<void>;
  readonly pool: pg.Pool;
  constructor(pool: pg.Pool) {
    this.pool = pool;
    this.ready = (async () => {
      const c = await pool.connect();
      try {
        await c.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
        try { await c.query(await readFile(SQL_FILE, 'utf8')); } finally { await c.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]); }
      } finally { c.release(); }
    })();
    this.ready.catch(() => {});
  }

  readonly kv = {
    open: async (descriptor: KvUnitDescriptor): Promise<PgKvUnit> => {
      if (this.closed) throw new StorageError('closed', 'pg backend is closed');
      validateDescriptor(descriptor);
      if (this.open.has(descriptor.name) || this.opening.has(descriptor.name)) throw new Error(`unit '${descriptor.name}' is already open; a unit has exactly one live handle`);
      const opening = this.openUnit(descriptor);
      this.opening.set(descriptor.name, opening);
      return opening.finally(() => this.opening.delete(descriptor.name));
    },
  };

  private async openUnit(descriptor: KvUnitDescriptor): Promise<PgKvUnit> {
    await this.ready;
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const existing = await c.query<{ version: number }>('SELECT version FROM dsh_kv_units WHERE unit = $1 FOR UPDATE', [descriptor.name]);
      if (existing.rowCount === 0) {
        await c.query('INSERT INTO dsh_kv_units (unit, version, has_global, global) VALUES ($1, $2, $3, NULL)', [descriptor.name, descriptor.version, descriptor.hasGlobal]);
      } else if (existing.rows[0].version !== descriptor.version) {
        await c.query('ROLLBACK');
        throw new StorageError('version-mismatch', `unit '${descriptor.name}' is at version ${existing.rows[0].version}, expected ${descriptor.version}`);
      }
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { c.release(); }
    if (this.closed) throw new StorageError('closed', 'pg backend is closed');
    const unit = new PgKvUnit(this.pool, descriptor, () => this.open.delete(descriptor.name));
    this.open.set(descriptor.name, unit);
    return unit;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.opening.values()]);
    for (const unit of [...this.open.values()]) await unit.close();
    await this.pool.end();
  }
}

function validateDescriptor(d: KvUnitDescriptor): void {
  if (!UNIT_NAME_RE.test(d.name)) throw new StorageError('malformed-medium', `invalid unit name '${d.name}'`);
  for (const t of d.tables) if (!UNIT_NAME_RE.test(t)) throw new StorageError('malformed-medium', `invalid table name '${t}' in unit '${d.name}'`);
}

export const name = 'storage-pg';
export const inject = ['storage'];
export const Config = z.object({ connectionString: z.string().required() });

/** Register the `pg` backend on the storage hub (and provide its lifecycle service key). */
export function apply(ctx: Context, config: { connectionString: string }): void {
  const backend = new PgStorageBackend(createPool(config.connectionString));
  const anyCtx = ctx as any;
  ctx.effect(() => {
    const unregister = anyCtx.storage.backend.register(BACKEND_NAME, backend);
    return async () => { unregister(); await backend.close(); };
  }, 'storage-pg.register');
  anyCtx.provide(storageBackendServiceKey(BACKEND_NAME), backend);
}
