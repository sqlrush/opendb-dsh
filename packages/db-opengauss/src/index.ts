import type { Context } from '@deepseek-ai/cordis';
import type { Dialect } from '@opendb-dsh/db';

export const name = 'db-opengauss';
export const inject = ['opendbDb'];

/**
 * openGauss dialect for the db seam (verified against openGauss-lite 5.0.3 / og5):
 * dbe_perf.* monitoring views need the platform account's MONADMIN attribute.
 */
export const OPENGAUSS_DIALECT: Dialect = {
  engine: 'opengauss',
  overview: [
    { key: 'version', title: '版本', sql: 'SELECT version()' },
    { key: 'sessions', title: '会话按状态', sql: "SELECT coalesce(state, 'unknown') AS state, count(*)::int AS sessions FROM pg_stat_activity GROUP BY 1 ORDER BY 2 DESC" },
    { key: 'instance_time', title: '实例时间分布(μs)', sql: 'SELECT stat_name, value FROM dbe_perf.instance_time ORDER BY value DESC' },
    { key: 'top_sql', title: 'Top SQL(按总耗时)', sql: 'SELECT left(query, 120) AS query, n_calls, total_elapse_time, n_returned_rows FROM dbe_perf.statement ORDER BY total_elapse_time DESC LIMIT 10' },
    { key: 'wait_events', title: 'Top 等待事件', sql: 'SELECT type, event, wait, total_wait_time FROM dbe_perf.wait_events ORDER BY total_wait_time DESC LIMIT 10' },
    { key: 'waiting', title: '等待中的锁', sql: 'SELECT count(*)::int AS waiting_locks FROM pg_locks WHERE NOT granted' },
    { key: 'db_size', title: '库大小', sql: 'SELECT datname, pg_size_pretty(pg_database_size(datname)) AS size FROM pg_database WHERE NOT datistemplate ORDER BY pg_database_size(datname) DESC' },
    { key: 'replication', title: '复制状态', sql: 'SELECT client_addr, state, sync_state FROM pg_stat_replication' },
  ],
};

/** Register the openGauss dialect; disposal restores whatever was there before. */
export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  ctx.effect(() => anyCtx.opendbDb.registerDialect(OPENGAUSS_DIALECT), 'db-opengauss.dialect');
}
