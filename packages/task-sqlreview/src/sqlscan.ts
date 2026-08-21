/**
 * 慢 SQL 扫描 + 执行计划锚定（opencode_skill sqltune 方法论在只读约束下的落地）：
 * - Top-N 慢 SQL 取自 dbe_perf.statement（按均耗时，过滤监控自身查询）；
 * - 逐条尝试 EXPLAIN（只读；参数化文本失败则如实降级"无法取得计划"）；
 * - 计划文本确定性标注：Seq Scan / 大 rows / 总 cost 提取——优化点由脚本标，改写由模型做；
 * - og-lite 无 hypopg：索引类建议 verify 只能是 estimated；改写类由模型 EXPLAIN 实证（cost 可比）。
 */

export interface PlanFinding { code: string; line: number; level: 'notice' | 'warn'; detail: string }

export interface SqlItem {
  key: string;                 // 短标识（文本 hash 前 10 位）
  text: string;
  calls: number;
  avgMs: number;
  totalMs: number;
  explainOk: boolean;
  plan: string[];              // EXPLAIN 输出行（截断到 30 行）
  planCost?: number;           // 顶层计划总 cost（cost=..X 的 X）
  planFindings: PlanFinding[];
  note?: string;               // EXPLAIN 失败原因
}

export type QueryFn = (sql: string, maxRows?: number) => Promise<{ rows: Record<string, unknown>[] }>;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** 无依赖短 hash（fnv1a hex），给慢 SQL 一个稳定短标识 */
export function shortKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 顶层总 cost：第一行 (cost=a..B 的 B) */
export function topCost(planLines: string[]): number | undefined {
  const m = planLines[0]?.match(/cost=\d+(?:\.\d+)?\.\.(\d+(?:\.\d+)?)/);
  return m !== null && m !== undefined ? Number(m[1]) : undefined;
}

/** 计划行确定性标注：全表扫（含大行数升级）与外排提示 */
export function annotatePlan(planLines: string[]): PlanFinding[] {
  const out: PlanFinding[] = [];
  planLines.forEach((line, i) => {
    const seq = line.match(/Seq Scan on (\S+)/);
    if (seq !== null) {
      const rows = line.match(/rows=(\d+)/);
      const big = rows !== null && Number(rows[1]) > 100000;
      out.push({
        code: 'PLAN_SEQSCAN', line: i, level: big ? 'warn' : 'notice',
        detail: `全表扫描 ${seq[1]}${rows !== null ? `（估算 ${rows[1]} 行）` : ''}${big ? '——行数大，优先怀疑缺索引' : ''}`,
      });
    }
    if (/Sort Method: external|Disk:/i.test(line)) {
      out.push({ code: 'PLAN_SPILL', line: i, level: 'warn', detail: '排序/聚合下盘（外存），work_mem 不足或输入过大' });
    }
  });
  return out.slice(0, 6);
}

/** Top-N 慢 SQL（按均耗时降序；过滤平台监控/字典查询自身） */
export async function fetchTopSql(q: QueryFn, topN: number): Promise<{ text: string; calls: number; avgMs: number; totalMs: number }[]> {
  const rows = (await q(`SELECT query, n_calls::bigint AS calls, total_elapse_time::bigint AS total
FROM dbe_perf.statement
WHERE n_calls > 0
  AND query NOT ILIKE '%dbe_perf.%' AND query NOT ILIKE '%pg_catalog.%'
  AND query NOT ILIKE '%pg_stat_%' AND query NOT ILIKE '%pg_database_size%'
  AND query NOT ILIKE 'EXPLAIN%' AND query NOT ILIKE 'SET %'
ORDER BY total_elapse_time / n_calls DESC LIMIT ${Math.max(1, Math.min(topN, 20))}`, 20)).rows;
  return rows.map((r) => ({
    text: str(r.query),
    calls: num(r.calls),
    avgMs: Math.round(num(r.total) / Math.max(1, num(r.calls)) / 1000),
    totalMs: Math.round(num(r.total) / 1000),
  }));
}

/** 单条 SQL 的计划锚定：EXPLAIN → cost + 标注；失败如实降级 */
export async function explainOne(q: QueryFn, text: string): Promise<Pick<SqlItem, 'explainOk' | 'plan' | 'planCost' | 'planFindings' | 'note'>> {
  try {
    const r = await q(`EXPLAIN ${text}`, 40);
    const lines = r.rows.map((row) => str(Object.values(row)[0])).slice(0, 30);
    return { explainOk: true, plan: lines, planCost: topCost(lines), planFindings: annotatePlan(lines) };
  } catch (cause) {
    return {
      explainOk: false, plan: [], planFindings: [],
      note: `无法取得执行计划：${String((cause as Error).message ?? cause).slice(0, 120)}（多为参数化/截断文本，属正常降级）`,
    };
  }
}

export async function scanSql(q: QueryFn, topN: number, extraSqls: string[], notes: string[]): Promise<SqlItem[]> {
  let top: { text: string; calls: number; avgMs: number; totalMs: number }[] = [];
  try {
    top = await fetchTopSql(q, topN);
  } catch (cause) {
    notes.push(`慢 SQL 扫描降级：dbe_perf.statement 不可读（${String((cause as Error).message ?? cause).slice(0, 120)}）`);
  }
  const seed = [
    ...top,
    ...extraSqls.map((text) => ({ text, calls: 0, avgMs: 0, totalMs: 0 })),
  ];
  const out: SqlItem[] = [];
  for (const s of seed.slice(0, Math.max(topN, seed.length > topN ? seed.length : topN))) {
    const anchored = await explainOne(q, s.text);
    out.push({ key: shortKey(s.text), text: s.text.slice(0, 1200), calls: s.calls, avgMs: s.avgMs, totalMs: s.totalMs, ...anchored });
  }
  return out;
}
