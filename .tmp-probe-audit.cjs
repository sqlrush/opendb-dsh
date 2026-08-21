/* og5 审计/DDL 溯源地基探针（只读，用毕即删） */
const { createRequire } = require('node:module');
const req = createRequire('/app/packages/db/package.json');
const pg = req('pg');
const cred = JSON.parse(process.env.OPENDB_DB_CREDENTIALS || '{}');
const e = cred.og5 || cred['*'] || {};
const pool = new pg.Pool({
  host: '192.168.128.1', port: 5433, database: 'postgres',
  user: e.username || 'opendb_ro', password: e.password,
  max: 1, connectionTimeoutMillis: 8000, statement_timeout: 15000,
  options: '-c default_transaction_read_only=on',
});
const out = {};
async function q(name, sql) {
  try {
    const r = await pool.query(sql);
    out[name] = { rows: r.rows.slice(0, 15), fields: r.fields.map((f) => f.name) };
  } catch (c) { out[name] = { error: String(c.message || c).slice(0, 180) }; }
}
(async () => {
  await q('audit_guc', "SELECT name, setting FROM pg_settings WHERE name IN ('audit_enabled','audit_system_object','audit_dml_state','audit_function_exec','audit_directory') ORDER BY 1");
  await q('audit_try', "SELECT time, type, result, username, database, object_name, left(detail_info, 120) AS detail FROM pg_query_audit(now() - interval '7 days', now()) WHERE type LIKE 'ddl%' ORDER BY time DESC LIMIT 10");
  await q('audit_types', "SELECT type, count(*) FROM pg_query_audit(now() - interval '2 days', now()) GROUP BY 1 ORDER BY 2 DESC LIMIT 15");
  await q('stmt_ddl', "SELECT snap_user_name FROM (SELECT 1 AS x) t WHERE false");
  await q('dbe_stmt_ddl', "SELECT user_name, left(query, 90) AS q, n_calls, last_updated FROM dbe_perf.statement WHERE query ~* '^\\s*(create|alter|drop|truncate|comment|grant|revoke)\\b' ORDER BY last_updated DESC LIMIT 12");
  console.log(JSON.stringify(out, null, 1));
  await pool.end();
  process.exit(0);
})();
