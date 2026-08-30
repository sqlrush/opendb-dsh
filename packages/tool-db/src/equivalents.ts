/**
 * PostgreSQL 专有写法 → openGauss 等价写法（只在目录确认对象不存在时附在字典单/报错里；不是每轮塞进 prompt）。
 * 2026-08-30 user："第 2 个之前在其他任务报告里也遇到过"——模型按 PG 习惯写 regnamespace / pg_stat_statements 等，og 没有。
 */
export const TYPE_EQUIVALENTS: Record<string, string> = {
  regnamespace: 'openGauss 没有 regnamespace：改为 JOIN pg_namespace n ON n.oid = c.relnamespace 并按 n.nspname 过滤（或 WHERE relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = \'…\')）',
  regrole: 'openGauss 没有 regrole：用 pg_roles / pg_authid 按 rolname 查 oid',
  regcollation: 'openGauss 没有 regcollation：用 pg_collation 按 collname 查',
  jsonpath: 'openGauss 没有 jsonpath 类型：用 jsonb 操作符（->、->>、#>）或 jsonb_path_* 之外的函数',
};
export const FUNCTION_EQUIVALENTS: Record<string, string> = {
  pg_current_wal_lsn: 'openGauss 对应 pg_current_xlog_location()',
  pg_current_wal_insert_lsn: 'openGauss 对应 pg_current_xlog_insert_location()',
  pg_walfile_name: 'openGauss 对应 pg_xlogfile_name()',
  pg_wal_lsn_diff: 'openGauss 对应 pg_xlog_location_diff()',
  pg_last_wal_receive_lsn: 'openGauss 对应 pg_last_xlog_receive_location()',
  pg_last_wal_replay_lsn: 'openGauss 对应 pg_last_xlog_replay_location()',
  pg_blocking_pids: 'openGauss 没有 pg_blocking_pids：锁链看 pg_thread_wait_status 的 block_sessionid / dbe_perf.thread_wait_status',
  pg_stat_statements_reset: 'openGauss 没有 pg_stat_statements：SQL 统计在 dbe_perf.statement / statement_history',
  jsonb_path_query: 'openGauss 没有 jsonb_path_*：用 jsonb 操作符与 jsonb_array_elements / jsonb_each',
  jsonb_path_exists: 'openGauss 没有 jsonb_path_*：用 jsonb 操作符与 jsonb_array_elements / jsonb_each',
  array_position: 'openGauss 可能没有 array_position：用 generate_subscripts + WHERE，或 CASE 表达式排序',
  pg_ls_waldir: 'openGauss 对应 pg_ls_dir(\'pg_xlog\')',
};
