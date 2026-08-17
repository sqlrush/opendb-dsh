import pg from 'pg';

/** One pg.Pool per provider instance; closed by the coordinator's dispose effect via close(). */
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
}
