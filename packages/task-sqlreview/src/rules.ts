/**
 * SQL 审核确定性规则引擎（opencode_skill sqlreview 方法论：规则判定由脚本产出，模型只解读）。
 * 12 条规则 = 7 条目录类（catalog 只读查询）+ 5 条文本类（对慢 SQL 文本正则）。
 * 严重度由规则静态决定（联动升级也走确定性条件），客户规范经知识库对照——参考不改判。
 */

import { specsFrom, applyOverrides, type ThresholdSpec } from '@opendb-dsh/thresholds-pg';

export type RuleLevel = 'ok' | 'notice' | 'warn' | 'critical';

export interface RuleFinding {
  rule: string;
  level: RuleLevel;
  object: string;
  problem: string;
  advice: string;
  evidence: string;
}

export type QueryFn = (sql: string, maxRows?: number) => Promise<{ rows: Record<string, unknown>[] }>;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export const LEVEL_ORDER: Record<RuleLevel, number> = { ok: 0, notice: 1, warn: 2, critical: 3 };
export function worstRuleLevel(findings: RuleFinding[]): RuleLevel {
  return findings.reduce<RuleLevel>((acc, f) => (LEVEL_ORDER[f.level] > LEVEL_ORDER[acc] ? f.level : acc), 'ok');
}

/**
 * 目录类规则里的数值判据（阈值可配置化，2026-08-24）：原先是埋在 SQL 文本里的字面量，
 * 提成常量后值一个不变，规则语义不动——只是让平台阈值服务能覆盖它们。
 * 拼进 SQL 前一律过 sqlNum：只接受有限数并取整，杜绝任何非数值进入查询文本。
 */
export const SQLREVIEW_THRESHOLDS = {
  bigTableRows: 10000,      // TBL001：超过此行数且无主键/唯一键
  noIndexRows: 100000,      // TBL002：超过此行数且无任何索引
  indexMaxCols: 5,          // IDX002：索引列数超过此值
  varcharMaxLen: 4000,      // COL001：varchar 长度超过此值
  seqScanWarnRows: 100000,  // PLAN_SEQSCAN：全表扫估算行数超过此值升 warn
} as const;

export type SqlreviewThresholds = { [K in keyof typeof SQLREVIEW_THRESHOLDS]: number };

const SQLREVIEW_THRESHOLD_META = {
  bigTableRows: { label: '大表无主键行数线', rule: 'TBL001', cmp: '>' as const, unit: 'count' as const, desc: 'reltuples 超过此值且无 PK/唯一键' },
  noIndexRows: { label: '大表无索引行数线', rule: 'TBL002', cmp: '>' as const, unit: 'count' as const, desc: 'reltuples 超过此值且无任何索引' },
  indexMaxCols: { label: '索引列数上限', rule: 'IDX002', cmp: '>' as const, unit: 'count' as const, desc: 'indnatts 超过此值' },
  varcharMaxLen: { label: 'varchar 长度上限', rule: 'COL001', cmp: '>' as const, unit: 'count' as const, desc: 'varchar(n) 的 n 超过此值' },
  seqScanWarnRows: { label: '全表扫升级行数', rule: 'PLAN_SEQSCAN', cmp: '>' as const, unit: 'count' as const, desc: 'EXPLAIN 估算 rows 超过此值时 notice → warn' },
};

export const SQLREVIEW_THRESHOLD_SPECS: ThresholdSpec[] = specsFrom('sqlreview', SQLREVIEW_THRESHOLDS, SQLREVIEW_THRESHOLD_META);

export function withSqlreviewThresholds(flat: Record<string, number>): SqlreviewThresholds {
  return applyOverrides(SQLREVIEW_THRESHOLDS, flat);
}

/** 拼进 SQL 文本的数值守门：非有限数一律退回 0，取整 */
const sqlNum = (v: number): number => (Number.isFinite(v) ? Math.floor(v) : 0);

// ── 目录类规则（每条独立 try/catch 由编排层兜）────────────────────────────────

/** TBL001 大表无主键；若其被慢 SQL 的 UPDATE/DELETE 命中 → 升级 critical（确定性联动） */
export async function ruleTbl001(q: QueryFn, slowTexts: string[], T: SqlreviewThresholds = SQLREVIEW_THRESHOLDS): Promise<RuleFinding[]> {
  const rows = (await q(`SELECT c.relname AS t, n.nspname AS s, c.reltuples::bigint AS n
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog','information_schema','dbe_perf','dbe_pldeveloper','db4ai','cstore','pg_toast')
  AND c.reltuples > ${sqlNum(T.bigTableRows)}
  AND NOT EXISTS (SELECT 1 FROM pg_constraint x WHERE x.conrelid = c.oid AND x.contype IN ('p','u'))
ORDER BY c.reltuples DESC LIMIT 8`, 8)).rows;
  return rows.map((r) => {
    const table = str(r.t);
    const hitByDml = slowTexts.some((t) => new RegExp(`(update|delete\\s+from)\\s+(\\S+\\.)?${table}\\b`, 'i').test(t));
    return {
      rule: 'TBL001', level: hitByDml ? 'critical' as const : 'warn' as const,
      object: `${str(r.s)}.${table}`,
      problem: `表无主键/唯一键（约 ${num(r.n)} 行）${hitByDml ? '——且被线上慢 SQL 的 UPDATE/DELETE 命中，回滚与复制均不可控' : ''}`,
      advice: '补自增主键或业务唯一键；上线前 DDL 评审拦截',
      evidence: `reltuples=${num(r.n)}${hitByDml ? ' · 慢SQL DML 命中' : ''}`,
    };
  });
}

/** TBL002 大表无任何索引 */
export async function ruleTbl002(q: QueryFn, T: SqlreviewThresholds = SQLREVIEW_THRESHOLDS): Promise<RuleFinding[]> {
  const rows = (await q(`SELECT c.relname AS t, n.nspname AS s, c.reltuples::bigint AS n
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog','information_schema','dbe_perf','dbe_pldeveloper','db4ai','cstore','pg_toast')
  AND c.reltuples > ${sqlNum(T.noIndexRows)} AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid)
ORDER BY c.reltuples DESC LIMIT 5`, 5)).rows;
  return rows.map((r) => ({
    rule: 'TBL002', level: 'warn' as const, object: `${str(r.s)}.${str(r.t)}`,
    problem: `大表（约 ${num(r.n)} 行）无任何索引，所有查询全表扫`,
    advice: '按查询画像补关键索引', evidence: `reltuples=${num(r.n)}`,
  }));
}

/** IDX001 失效索引 */
export async function ruleIdx001(q: QueryFn): Promise<RuleFinding[]> {
  const rows = (await q(`SELECT ci.relname AS idx, ct.relname AS t FROM pg_index i
JOIN pg_class ci ON ci.oid = i.indexrelid JOIN pg_class ct ON ct.oid = i.indrelid
WHERE NOT i.indisvalid LIMIT 6`, 6)).rows;
  return rows.map((r) => ({
    rule: 'IDX001', level: 'warn' as const, object: str(r.idx),
    problem: `失效索引（indisvalid=false，表 ${str(r.t)}）——占空间且拖慢写入但不服务查询`,
    advice: '重建（REINDEX）或删除', evidence: 'pg_index.indisvalid=false',
  }));
}

/** IDX002 索引列数过多（>5） */
export async function ruleIdx002(q: QueryFn, T: SqlreviewThresholds = SQLREVIEW_THRESHOLDS): Promise<RuleFinding[]> {
  const rows = (await q(`SELECT ci.relname AS idx, ct.relname AS t, i.indnatts::int AS n FROM pg_index i
JOIN pg_class ci ON ci.oid = i.indexrelid JOIN pg_class ct ON ct.oid = i.indrelid
JOIN pg_namespace ns ON ns.oid = ct.relnamespace
WHERE i.indnatts > ${sqlNum(T.indexMaxCols)} AND ns.nspname NOT IN ('pg_catalog','information_schema','dbe_perf','dbe_pldeveloper','db4ai') LIMIT 6`, 6)).rows;
  return rows.map((r) => ({
    rule: 'IDX002', level: 'notice' as const, object: str(r.idx),
    problem: `索引 ${num(r.n)} 列（>5），写放大且低区分度尾列多半无效`,
    advice: '按查询画像裁剪到 ≤4 列', evidence: `indnatts=${num(r.n)} 表=${str(r.t)}`,
  }));
}

/** IDX003 完全重复索引 + IDX004 前缀冗余索引（一次目录扫描两条规则） */
export async function ruleIdx003And004(q: QueryFn): Promise<RuleFinding[]> {
  const rows = (await q(`SELECT ct.relname AS t, ci.relname AS idx, i.indkey::text AS cols, i.indisprimary AS pk
FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid JOIN pg_class ct ON ct.oid = i.indrelid
JOIN pg_namespace ns ON ns.oid = ct.relnamespace
WHERE ns.nspname NOT IN ('pg_catalog','information_schema','dbe_perf','dbe_pldeveloper','db4ai','pg_toast')
ORDER BY ct.relname LIMIT 200`, 200)).rows;
  const byTable = new Map<string, { idx: string; cols: string; pk: boolean }[]>();
  for (const r of rows) {
    const t = str(r.t);
    byTable.set(t, [...(byTable.get(t) ?? []), { idx: str(r.idx), cols: str(r.cols), pk: r.pk === true }]);
  }
  const out: RuleFinding[] = [];
  for (const [t, idxes] of byTable) {
    for (let a = 0; a < idxes.length; a += 1) {
      for (let b = 0; b < idxes.length; b += 1) {
        if (a === b || idxes[a].pk) continue;
        const ca = idxes[a].cols; const cb = idxes[b].cols;
        if (ca === cb && a < b && !idxes[b].pk) {
          out.push({ rule: 'IDX003', level: 'warn', object: `${idxes[a].idx} / ${idxes[b].idx}`, problem: `表 ${t} 上完全重复索引（列序一致：${ca}）`, advice: '保留一个，删除另一个', evidence: `indkey=${ca}` });
        } else if (cb.startsWith(`${ca} `)) {
          out.push({ rule: 'IDX004', level: 'notice', object: idxes[a].idx, problem: `前缀冗余：(${ca}) 被 ${idxes[b].idx}(${cb}) 覆盖（表 ${t}）`, advice: `删除 ${idxes[a].idx}，先入观察清单`, evidence: `indkey ${ca} ⊂ ${cb}` });
        }
      }
    }
  }
  return out.slice(0, 8);
}

/** IDX005 从未使用的索引（非 PK/unique） */
export async function ruleIdx005(q: QueryFn): Promise<RuleFinding[]> {
  const rows = (await q(`SELECT s.schemaname AS sch, s.indexrelname AS idx, s.relname AS t
FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0 AND NOT i.indisprimary AND NOT i.indisunique
  AND s.schemaname NOT IN ('dbe_pldeveloper','db4ai') LIMIT 6`, 6)).rows;
  if (rows.length === 0) return [];
  return [{
    rule: 'IDX005', level: 'notice', object: rows.map((r) => str(r.idx)).join(', '),
    problem: `${rows.length}+ 个索引从未被扫描（idx_scan=0，非主键/唯一）`,
    advice: '确认无低频批处理依赖后删除；先转观察清单',
    evidence: rows.map((r) => `${str(r.sch)}.${str(r.idx)}`).join(', '),
  }];
}

/** COL001 超长 varchar 列（length>4000） */
export async function ruleCol001(q: QueryFn, T: SqlreviewThresholds = SQLREVIEW_THRESHOLDS): Promise<RuleFinding[]> {
  const rows = (await q(`SELECT c.relname AS t, a.attname AS col, a.atttypmod - 4 AS len
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE a.atttypid IN ('varchar'::regtype) AND a.atttypmod - 4 > ${sqlNum(T.varcharMaxLen)} AND c.relkind = 'r' AND a.attnum > 0
  AND n.nspname NOT IN ('pg_catalog','information_schema','dbe_perf','dbe_pldeveloper','db4ai') LIMIT 5`, 5)).rows;
  return rows.map((r) => ({
    rule: 'COL001', level: 'notice' as const, object: `${str(r.t)}.${str(r.col)}`,
    problem: `varchar(${num(r.len)}) 超长列——常为设计噪声，膨胀行宽`,
    advice: '评估改 text 或收窄长度', evidence: `atttypmod=${num(r.len)}`,
  }));
}

// ── 文本类规则（对慢 SQL 文本；q 无关）─────────────────────────────────────

export interface SlowSqlText { key: string; text: string }

export function textRules(sqls: SlowSqlText[]): RuleFinding[] {
  const out: RuleFinding[] = [];
  for (const { key, text } of sqls) {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (/^\s*(update|delete)\b/i.test(flat) && !/\bwhere\b/i.test(flat)) {
      out.push({ rule: 'DML001', level: 'critical', object: key, problem: '无 WHERE 的全表 UPDATE/DELETE', advice: '补 WHERE 或改批处理分片；触发前业务侧评审', evidence: flat.slice(0, 100) });
    }
    if (/\bselect\s+\*\s+from\b/i.test(flat)) {
      out.push({ rule: 'DQL001', level: 'notice', object: key, problem: 'SELECT * 全列拉取，回表/网络放大', advice: '显式列清单；宽表尤其收益大', evidence: flat.slice(0, 100) });
    }
    if (/\blike\s+'%/i.test(flat)) {
      out.push({ rule: 'DQL002', level: 'warn', object: key, problem: "前置模糊匹配 LIKE '%…' 无法走索引", advice: '改后缀匹配/全文检索；或业务标签化', evidence: flat.slice(0, 100) });
    }
    if (/\bnot\s+in\s*\(\s*select\b/i.test(flat)) {
      out.push({ rule: 'DQL003', level: 'notice', object: key, problem: 'NOT IN (子查询)——NULL 语义陷阱且优化器多半走低效反连接', advice: '改 NOT EXISTS', evidence: flat.slice(0, 100) });
    }
  }
  return out;
}

/** 目录类规则编排：逐条独立降级 */
export async function runCatalogRules(q: QueryFn, slowTexts: string[], notes: string[], T: SqlreviewThresholds = SQLREVIEW_THRESHOLDS): Promise<RuleFinding[]> {
  const jobs: { name: string; run: () => Promise<RuleFinding[]> }[] = [
    { name: 'TBL001', run: () => ruleTbl001(q, slowTexts, T) },
    { name: 'TBL002', run: () => ruleTbl002(q, T) },
    { name: 'IDX001', run: () => ruleIdx001(q) },
    { name: 'IDX002', run: () => ruleIdx002(q, T) },
    { name: 'IDX003/004', run: () => ruleIdx003And004(q) },
    { name: 'IDX005', run: () => ruleIdx005(q) },
    { name: 'COL001', run: () => ruleCol001(q, T) },
  ];
  const out: RuleFinding[] = [];
  for (const j of jobs) {
    try {
      out.push(...await j.run());
    } catch (cause) {
      notes.push(`规则 ${j.name} 采集降级：${String((cause as Error).message ?? cause).slice(0, 140)}（该规则不产结论）`);
    }
  }
  return out;
}
