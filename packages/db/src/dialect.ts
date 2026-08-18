/**
 * Engine dialect: a named set of canned diagnostic queries (the `db` seam's
 * provider surface). `db-opengauss` overrides the baseline with dbe_perf views;
 * plain PostgreSQL nodes fall back to this baseline.
 */
export interface DialectQuery {
  /** Stable key, also the section title shown to the model. */
  key: string;
  title: string;
  sql: string;
}

export interface Dialect {
  engine: string;
  overview: readonly DialectQuery[];
}

/** Baseline dialect for vanilla PostgreSQL nodes (catalog views only, no extensions assumed). */
export const POSTGRESQL_DIALECT: Dialect = {
  engine: 'postgresql',
  overview: [
    { key: 'version', title: '版本', sql: 'SELECT version()' },
    { key: 'sessions', title: '会话按状态', sql: "SELECT coalesce(state, 'unknown') AS state, count(*)::int AS sessions FROM pg_stat_activity GROUP BY 1 ORDER BY 2 DESC" },
    { key: 'waiting', title: '等待中的锁', sql: 'SELECT count(*)::int AS waiting_locks FROM pg_locks WHERE NOT granted' },
    { key: 'db_size', title: '库大小', sql: 'SELECT datname, pg_size_pretty(pg_database_size(datname)) AS size FROM pg_database WHERE NOT datistemplate ORDER BY pg_database_size(datname) DESC' },
    { key: 'replication', title: '复制状态', sql: 'SELECT client_addr, state, sync_state FROM pg_stat_replication' },
  ],
};
