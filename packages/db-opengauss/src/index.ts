import type { Context } from '@deepseek-ai/cordis';
import { BASELINE_METRICS, BASELINE_DICTIONARY, type Dialect } from '@opendb-dsh/db';

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
  metrics: [
    ...BASELINE_METRICS,
    { key: 'instance_time', title: '实例时间分布', sql: "SELECT 'db.instance_time.' || lower(stat_name) AS metric, value::float8 AS value FROM dbe_perf.instance_time" },
    { key: 'wait_total', title: '等待事件总量', sql: "SELECT 'db.wait_events_total' AS metric, coalesce(sum(total_wait_time), 0)::float8 AS value FROM dbe_perf.wait_events" },
    // ── 2026-08-24 user 报障补齐：og5 实测 TPS 3621 / WALFlushWait 55%，而模型判「未过载」，
    //    因为这些维度当时一个都没采。以下四组把「过载」判据的原料补全。 ──
    // OS 层（dbe_perf.os_runtime）：此前完全空白——连 CPU 使用率都没有，光看 CPU 就该判出来的场景判不出来。
    // BUSY/IDLE/IOWAIT 是累计 jiffies，入库后由消费方做差分得瞬时率；LOAD 本身即瞬时值。
    {
      key: 'os_runtime',
      title: 'OS 运行时（CPU/负载/内存）',
      sql: "SELECT 'db.os.' || lower(name) AS metric, value::float8 AS value FROM dbe_perf.os_runtime "
        + "WHERE name IN ('BUSY_TIME','IDLE_TIME','IOWAIT_TIME','USER_TIME','SYS_TIME','LOAD',"
        + "'NUM_CPUS','PHYSICAL_MEMORY_BYTES','AVG_BUSY_TIME','AVG_IDLE_TIME','AVG_IOWAIT_TIME')",
    },
    // 等待事件按类：此前只存 wait_events_total 一个总数，历史趋势里看不出 WALFlushWait 的占比变化。
    // 同样排除 STATUS（非等待，且 wait cmd 空闲占 99.94%），口径与 health 的 WAIT_EVENTS_REAL 一致。
    {
      key: 'wait_by_type',
      title: '等待事件按类',
      sql: "SELECT 'db.wait_by_type.' || lower(type) AS metric, sum(total_wait_time)::float8 AS value "
        + "FROM dbe_perf.wait_events WHERE total_wait_time > 0 AND upper(type) <> 'STATUS' GROUP BY type",
    },
    // QPS 原料：statement 的累计调用数与耗时，差分即得 QPS 与平均延迟。
    {
      key: 'stmt_totals',
      title: 'SQL 调用累计',
      sql: "SELECT 'db.stmt_calls' AS metric, coalesce(sum(n_calls), 0)::float8 AS value FROM dbe_perf.statement "
        + "UNION ALL SELECT 'db.stmt_elapse_us', coalesce(sum(total_elapse_time), 0)::float8 FROM dbe_perf.statement",
    },
  ],
  dictionary: BASELINE_DICTIONARY,
};

/** Register the openGauss dialect; disposal restores whatever was there before. */
export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  ctx.effect(() => anyCtx.opendbDb.registerDialect(OPENGAUSS_DIALECT), 'db-opengauss.dialect');
}
