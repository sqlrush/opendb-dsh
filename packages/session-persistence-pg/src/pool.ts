import pg from 'pg';

/**
 * One pg.Pool per provider instance; closed by the coordinator's dispose effect via close().
 * P3 多租户：每个连接经 startup options 注入 `app.tenant`（env OPENDB_TENANT，默认 default）——
 * 009 迁移对全部带 tenant_id 的表 FORCE RLS，策略按该 GUC 隔离；平台自身连接必须带租户身份，
 * 否则 FORCE 后全部查询 0 行（平台失明）。
 */
export function createPool(connectionString: string): pg.Pool {
  const tenant = (process.env.OPENDB_TENANT ?? 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    options: `-c app.tenant=${tenant}`,
  });
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
