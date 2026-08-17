import { appendFileSync } from 'node:fs';
/** Debug trace that survives any console hijacking; enabled by OPENDB_DEBUG_LOG=<file>. */
export function trace(msg: string): void {
  const file = process.env.OPENDB_DEBUG_LOG;
  if (!file) return;
  try { appendFileSync(file, `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ }
}
