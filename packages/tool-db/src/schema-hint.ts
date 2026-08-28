/**
 * db_query 报错增强（2026-08-26 user："column event_name does not exist 为什么经常报"）：
 * 模型按 PostgreSQL/其它库的印象猜 openGauss dbe_perf 视图的列名（wait_events 的 event 写成 event_name、
 * 凭空发明 avg_wait_time_ms），报错后要再猜一轮。这里在「列/表/函数不存在」时把 SQL 引用的每个关系
 * 的**真实列名**查出来附在错误里，并给出最接近的列名建议，让模型一次改对。纯函数部分可单测。
 */

/** PG 错误码：42703 列不存在 / 42P01 表不存在 / 42883 函数不存在 */
export const HINT_CODES = new Set(['42703', '42P01', '42883']);

/** 从 SQL 里抽出 FROM / JOIN 后面的关系名（schema.table 或 table；跳过子查询与 CTE 名） */
export function referencedRelations(sql: string, cteNames: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  const re = /\b(?:from|join)\s+([a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1].toLowerCase();
    if (cteNames.has(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** WITH 里定义的 CTE 名（这些不是真实关系，不去查） */
export function cteNames(sql: string): Set<string> {
  const names = new Set<string>();
  const re = /(?:\bwith\s+(?:recursive\s+)?|,\s*)([a-zA-Z_][\w$]*)\s*(?:\([^)]*\))?\s+as\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) names.add(m[1].toLowerCase());
  return names;
}

/** 从 PG 的 42703 报错文本里取出那个不存在的列名 */
export function missingColumn(message: string): string | undefined {
  const m = /column "([^"]+)" does not exist/i.exec(message) ?? /column ([\w.]+) does not exist/i.exec(message);
  const raw = m?.[1];
  if (raw === undefined) return undefined;
  return raw.includes('.') ? raw.slice(raw.lastIndexOf('.') + 1) : raw;
}

/** 与不存在的列名最接近的真实列名（子串 / 前缀 / 去掉 _name、_ms 等后缀 / 编辑距离 ≤ 3） */
export function closestColumn(wanted: string, columns: readonly string[]): string | undefined {
  const w = wanted.toLowerCase();
  const stripped = w.replace(/_(name|ms|us|sec|seconds|count|total|id)$/, '');
  const exact = columns.find((c) => c.toLowerCase() === stripped);
  if (exact !== undefined) return exact;
  const contains = columns.filter((c) => c.toLowerCase().includes(stripped) || stripped.includes(c.toLowerCase()));
  if (contains.length > 0) return contains.sort((a, b) => Math.abs(a.length - w.length) - Math.abs(b.length - w.length))[0];
  let best: { c: string; d: number } | undefined;
  for (const c of columns) {
    const d = editDistance(w, c.toLowerCase());
    if (d <= 3 && (best === undefined || d < best.d)) best = { c, d };
  }
  if (best !== undefined) return best.c;
  // 词元重合：total_elapsed → total_elapse_time（"elapsed" 与 "elapse" 前 4 字母相同视为同一词元）
  const tokens = (s: string) => s.toLowerCase().split(/[_\s]+/).filter((t) => t.length > 0);
  const same = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b.slice(0, 4)) || b.startsWith(a.slice(0, 4))));
  const wt = tokens(w);
  let top: { c: string; n: number } | undefined;
  for (const c of columns) {
    const n = tokens(c).filter((ct) => wt.some((t) => same(t, ct))).length;
    if (n > 0 && (top === undefined || n > top.n || (n === top.n && Math.abs(c.length - w.length) < Math.abs(top.c.length - w.length)))) top = { c, n };
  }
  return top?.c;
}

function editDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** 拼装附加提示；columnsOf 返回某关系的真实列（不存在返回 undefined） */
export function buildHint(
  sql: string, error: { code?: string; message?: string },
  columnsOf: (relation: string) => readonly string[] | undefined,
  /** 同名表/视图所在的其他 schema（2026-08-28：模型把 WDR 快照写成 dbe_perf.snapshot，其实在 snapshot.snapshot） */
  sameNameIn: (relation: string) => readonly string[] | undefined = () => undefined,
): string {
  const code = String(error.code ?? '');
  if (!HINT_CODES.has(code)) return '';
  const rels = referencedRelations(sql, cteNames(sql));
  const lines: string[] = [];
  const missing = code === '42703' ? missingColumn(String(error.message ?? '')) : undefined;
  for (const rel of rels) {
    const cols = columnsOf(rel);
    if (cols === undefined) {
      const table = rel.includes('.') ? rel.split('.', 2)[1] : rel;
      const elsewhere = (sameNameIn(rel) ?? []).filter((s) => s !== '');
      lines.push(elsewhere.length > 0
        ? `关系 ${rel} 不存在——同名表/视图在 schema ${elsewhere.join(' / ')}：应写 ${elsewhere.map((s) => `${s}.${table}`).join(' 或 ')}`
        : `关系 ${rel} 不存在（或无权访问）`);
      continue;
    }
    const suggest = missing !== undefined ? closestColumn(missing, cols) : undefined;
    lines.push(`${rel} 的实际列：${cols.join(', ')}${suggest !== undefined ? `——你写的 "${missing}" 应为 "${suggest}"` : ''}`);
  }
  if (code === '42883') lines.push('该函数在 openGauss 中不存在：优先用视图现成列做算术，或改用 PG 通用函数');
  if (lines.length === 0) return '';
  return `\n提示（openGauss dbe_perf 视图列名与 PostgreSQL 不同，请按下面的实际列改写后重试）：\n- ${lines.join('\n- ')}`;
}

/** 工具描述里的一行速查（每轮都会发给模型，保持短） */
export const OG_SCHEMA_HINT = 'openGauss dbe_perf 视图列名与 PG 不同——wait_events(type,event,wait,total_wait_time,avg_wait_time…，没有 event_name)、statement(unique_sql_id,query,n_calls,total_elapse_time,db_time,cpu_time…)、os_runtime(name,value 键值对：LOAD/NUM_CPUS/BUSY_TIME…)、session_stat_activity≈pg_stat_activity；WDR 快照不在 dbe_perf，在 schema snapshot：snapshot.snapshot(snapshot_id,start_ts,end_ts) 与 snapshot.snap_*；不确定先查 information_schema.columns / tables。';
