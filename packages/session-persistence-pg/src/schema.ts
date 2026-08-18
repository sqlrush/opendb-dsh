import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/** Directory holding the ordered, idempotent SQL migration files shipped with this package. */
export const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');

/** Advisory lock key serializing migrations across Host/Runtime processes starting concurrently. */
const MIGRATION_LOCK_KEY = 7_204_211_001;

/**
 * Apply every sql/*.sql in name order. Files use IF NOT EXISTS so re-running is safe; the
 * session-level advisory lock avoids PostgreSQL's concurrent CREATE ... IF NOT EXISTS race
 * (duplicate key on pg_type_typname_nsp_index) when several pods boot against a fresh DB.
 */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  const files = (await readdir(SQL_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query("SET lock_timeout = '5s'");
    try {
      for (const f of files) {
        const sql = await readFile(join(SQL_DIR, f), 'utf8');
        for (let attempt = 1; ; attempt++) {
          try { await client.query(sql); break; }
          catch (err: unknown) {
            const code = (err as { code?: string }).code;
            if (code !== '55P03' || attempt >= 30) throw err;   // lock_not_available → retry (runtime claim churn)
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
