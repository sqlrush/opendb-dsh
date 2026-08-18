import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/** Directory holding the ordered, idempotent SQL migration files shipped with this package. */
export const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');

/** Advisory lock key serializing migrations across Host/Runtime processes starting concurrently. */
const MIGRATION_LOCK_KEY = 7_204_211_001;

/**
 * Apply every sql/*.sql in name order. Files use IF NOT EXISTS so re-running is safe.
 *
 * Locking (W4 事故复盘后的形态): each file runs in its own transaction holding a
 * TRANSACTION-scoped advisory lock (pg_advisory_xact_lock) — a session-scoped lock once
 * outlived its zombie client for 32 minutes and stalled every service's startup, because a
 * killed pod's half-open TCP connection kept the session (and its lock) alive. With the
 * xact lock, COMMIT/ROLLBACK/connection death all release it, and the server-side
 * idle_in_transaction_session_timeout (set in the chart) can reap a stuck holder.
 * `SET lock_timeout` happens BEFORE the lock wait so waiting is also bounded (55P03 → retry).
 */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  const files = (await readdir(SQL_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    for (const f of files) {
      const sql = await readFile(join(SQL_DIR, f), 'utf8');
      for (let attempt = 1; ; attempt++) {
        try {
          await client.query('BEGIN');
          await client.query("SET LOCAL lock_timeout = '5s'");
          await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
          await client.query(sql);
          await client.query('COMMIT');
          break;
        } catch (err: unknown) {
          await client.query('ROLLBACK').catch(() => { /* connection may be gone; rethrow below */ });
          const code = (err as { code?: string }).code;
          if (code !== '55P03' || attempt >= 60) throw err;   // lock_not_available → bounded retry
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
  } finally {
    client.release();
  }
}
