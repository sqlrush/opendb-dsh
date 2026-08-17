import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/** Directory holding the ordered, idempotent SQL migration files shipped with this package. */
export const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');

/** Apply every sql/*.sql in name order. Files use IF NOT EXISTS so re-running is safe. */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  const files = (await readdir(SQL_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) await pool.query(await readFile(join(SQL_DIR, f), 'utf8'));
}
