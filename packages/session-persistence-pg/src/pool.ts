import pg from 'pg';

/** One pg.Pool per provider instance; closed by the coordinator's dispose effect via close(). */
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
}

/**
 * Roll back and release a pooled client after an error. If ROLLBACK itself fails the
 * connection may still carry an open transaction — release(err) makes pg-pool DESTROY it
 * instead of returning it to the pool (a pooled open transaction blocks DDL forever and
 * makes later queries run inside a stale transaction; seen in P1 W1).
 */
export async function rollbackAndRelease(client: { query(sql: string): Promise<unknown>; release(err?: Error | boolean): void }): Promise<void> {
  try {
    await client.query('ROLLBACK');
    client.release();
  } catch (rollbackError) {
    client.release(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
  }
}
