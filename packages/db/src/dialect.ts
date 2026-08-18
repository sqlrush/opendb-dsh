/**
 * Engine dialect: named sets of canned SQL (the `db` seam's provider surface).
 * - overview: diagnostics shown to the model by tool-db
 * - metrics: rows contract (metric text, value numeric) — labels folded into the metric name
 * - dictionary: rows contract (kind text, sch text, name text, signature text)
 * `db-opengauss` overrides the baseline with dbe_perf views; plain PostgreSQL falls back here.
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
  metrics?: readonly DialectQuery[];
  dictionary?: readonly DialectQuery[];
}

// System schemas excluded from data-dictionary snapshots (PostgreSQL + openGauss built-ins).
const SYS_SCHEMAS = `'pg_catalog','information_schema','pg_toast','cstore','snapshot','blockchain','db4ai','dbe_pldebugger','dbe_pldeveloper','dbe_perf','dbe_sql_util','sqladvisor','pkg_service','coverage','pmk','dbms_om','dbms_sql'`;
const NOT_SYS = `n.nspname NOT LIKE 'pg_%' AND n.nspname NOT IN (${SYS_SCHEMAS})`;

/** Metric scrape set that works on both PostgreSQL and openGauss (catalog views only). */
export const BASELINE_METRICS: readonly DialectQuery[] = [
  { key: 'sessions', title: '会话数按状态', sql: "SELECT 'db.sessions.' || replace(coalesce(state, 'unknown'), ' ', '_') AS metric, count(*)::float8 AS value FROM pg_stat_activity GROUP BY 1" },
  { key: 'xact', title: '事务计数器', sql: "SELECT 'db.xact_commit' AS metric, sum(xact_commit)::float8 AS value FROM pg_stat_database UNION ALL SELECT 'db.xact_rollback', sum(xact_rollback)::float8 FROM pg_stat_database UNION ALL SELECT 'db.blks_read', sum(blks_read)::float8 FROM pg_stat_database UNION ALL SELECT 'db.blks_hit', sum(blks_hit)::float8 FROM pg_stat_database" },
  { key: 'locks', title: '等待锁数', sql: "SELECT 'db.waiting_locks' AS metric, count(*)::float8 AS value FROM pg_locks WHERE NOT granted" },
  { key: 'db_size', title: '库大小', sql: "SELECT 'db.size_bytes.' || datname AS metric, pg_database_size(datname)::float8 AS value FROM pg_database WHERE NOT datistemplate" },
  { key: 'connections_max', title: '最大连接占比', sql: "SELECT 'db.connections_used_ratio' AS metric, (SELECT count(*) FROM pg_stat_activity)::float8 / current_setting('max_connections')::float8 AS value" },
];

/** Data-dictionary snapshot set that works on both PostgreSQL and openGauss. */
export const BASELINE_DICTIONARY: readonly DialectQuery[] = [
  {
    key: 'tables', title: '表(列签名)',
    sql: `SELECT 'table' AS kind, n.nspname AS sch, c.relname AS name,
       md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' ORDER BY a.attnum)) AS signature
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE c.relkind = 'r' AND ${NOT_SYS} GROUP BY 2, 3`,
  },
  { key: 'indexes', title: '索引', sql: `SELECT 'index' AS kind, schemaname AS sch, indexname AS name, md5(indexdef) AS signature FROM pg_indexes WHERE schemaname NOT LIKE 'pg_%' AND schemaname NOT IN (${SYS_SCHEMAS})` },
  { key: 'views', title: '视图', sql: `SELECT 'view' AS kind, schemaname AS sch, viewname AS name, md5(definition) AS signature FROM pg_views WHERE schemaname NOT LIKE 'pg_%' AND schemaname NOT IN (${SYS_SCHEMAS})` },
  {
    key: 'functions', title: '函数',
    sql: `SELECT 'function' AS kind, n.nspname AS sch, p.proname AS name, md5(coalesce(p.prosrc, '')) AS signature
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${NOT_SYS}`,
  },
  {
    key: 'sequences', title: '序列',
    sql: `SELECT 'sequence' AS kind, n.nspname AS sch, c.relname AS name, '' AS signature
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'S' AND ${NOT_SYS}`,
  },
];

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
  metrics: BASELINE_METRICS,
  dictionary: BASELINE_DICTIONARY,
};
