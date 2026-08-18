/**
 * Read-only SQL gate (defense layer 1 of 3; layers 2/3 are connection-level
 * default_transaction_read_only and the opendb_ro account grants on the node).
 * Fail-closed: anything ambiguous is rejected with a reason the model can read.
 */

const ALLOWED_HEAD = /^(select|with|show|explain|values|table)\b/i;
const WRITE_WORDS = /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|vacuum|analyze|analyse|copy|call|do|set|reset|lock|comment|reindex|cluster|checkpoint|refresh|discard|listen|notify|unlisten|prepare|execute|deallocate|declare|fetch|move|close|begin|commit|rollback|savepoint|release|start|abort|security)\b/i;

// Functions that mutate session/server state or touch the filesystem even inside a
// read-only transaction (set_config can flip transaction_read_only itself).
const DANGEROUS_FUNCS = /\b(set_config|setval|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_[a-z]+|pg_create_restore_point|pg_start_backup|pg_stop_backup|lo_import|lo_export|lo_unlink|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_file_write|pg_advisory_[a-z_]*lock[a-z_]*|dblink[a-z_]*)\s*\(/i;

export type GuardResult = { ok: true; sql: string } | { ok: false; reason: string };

/** Strip line ("--") and block ("/" + "* ... *" + "/") comments so keywords cannot hide inside them. */
export function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  let quote: '\'' | '"' | undefined;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    const ch = sql[i];
    if (quote !== undefined) {
      out += ch;
      if (ch === quote) quote = undefined;
      i += 1;
    } else if (ch === '\'' || ch === '"') {
      quote = ch;
      out += ch;
      i += 1;
    } else if (two === '--') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) { i = sql.length; } else { i = end + 2; out += ' '; }
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/**
 * Validate that `sql` is a single read-only statement. String literals containing
 * write keywords are rejected too — acceptable for a diagnostics tool (fail closed).
 */
export function validateReadOnlySql(input: string): GuardResult {
  const noComments = stripComments(input).trim();
  const sql = noComments.endsWith(';') ? noComments.slice(0, -1).trim() : noComments;
  if (sql === '') return { ok: false, reason: 'SQL 为空' };
  if (sql.includes(';')) return { ok: false, reason: '只允许单条语句（检测到分号）' };
  if (!ALLOWED_HEAD.test(sql)) return { ok: false, reason: '只允许 SELECT / WITH / SHOW / EXPLAIN / VALUES / TABLE 开头的只读语句' };
  const hit = WRITE_WORDS.exec(sql);
  if (hit !== null) return { ok: false, reason: `检测到疑似写操作或会话控制关键词 "${hit[1]}"，诊断工具只允许只读查询` };
  const func = DANGEROUS_FUNCS.exec(sql);
  if (func !== null) return { ok: false, reason: `函数 "${func[1]}" 会改变会话/服务器状态或访问文件系统，诊断工具禁止调用` };
  return { ok: true, sql };
}
