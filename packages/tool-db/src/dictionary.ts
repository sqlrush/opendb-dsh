/**
 * 字典门（2026-08-29 user 定）：db_query 执行前按目标库的真实数据字典校验 SQL 引用的表/列——
 * 有不存在的表/列就不执行，直接把该关系的真实列、最接近的列名、以及"哪些关系有这一列"作为字典单返回，
 * 模型一次改对；SQL 正确时只多一次本地解析（缓存命中 ≈1 ms）。
 * 目录查询走 pg_class / pg_namespace / pg_attribute（information_schema 在 openGauss 里不收 pg_catalog 视图，
 * 08-26 的报错提示就是因此没兜住 pg_stat_activity）。按节点 + 关系缓存（TTL 10 分钟，LRU 500）。
 */
import { extractReferences, validateReferences } from './sql-refs.ts';
import type { RelInfo, Problem } from './sql-refs.ts';
import { closestColumn } from './schema-hint.ts';

type QueryFn = (node: any, sql: string, opts: { maxRows: number }) => Promise<{ rows: any[] }>;
export interface GateOptions { ttlMs?: number; maxEntries?: number; searchPath?: readonly string[] }
export type Validation = { ok: true } | { ok: false; report: string; problems: Problem[] };

/** 无 schema 限定时的查找顺序（平台账号常查的四个）；其余 schema 兜底，系统内部 schema 排除 */
const DEFAULT_SEARCH = ['pg_catalog', 'public', 'dbe_perf', 'snapshot'] as const;
const EXCLUDED_SCHEMAS = ['information_schema', 'pg_toast', 'db4ai', 'dbe_pldeveloper', 'dbe_pldebugger', 'cstore', 'sqladvisor', 'pkg_service', 'dbe_sql_util', 'blockchain', 'dbe_perf_test'];
const KIND_CN: Record<string, string> = { r: '表', v: '视图', m: '物化视图', f: '外部表', p: '分区表' };
const q = (s: string) => s.replace(/'/g, "''");
const nodeKey = (node: any): string => String(node?.id ?? node?.name ?? 'node');

interface Entry { info: RelInfo | undefined; at: number }

export class DictionaryGate {
  private readonly cache = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly searchPath: readonly string[];
  private readonly query: QueryFn;
  // 不用构造参数属性：node --experimental-strip-types 的 strip-only 模式不支持（单测直跑 .ts）
  constructor(query: QueryFn, opts: GateOptions = {}) {
    this.query = query;
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.maxEntries = opts.maxEntries ?? 500;
    this.searchPath = opts.searchPath ?? DEFAULT_SEARCH;
  }

  private schemaRank(): string {
    return `CASE n.nspname ${this.searchPath.map((s, i) => `WHEN '${q(s)}' THEN ${i + 1}`).join(' ')} ELSE 9 END`;
  }
  private excluded(): string {
    return `n.nspname NOT IN (${EXCLUDED_SCHEMAS.map((s) => `'${s}'`).join(', ')}) AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'`;
  }

  /** 解析关系：显式 schema 精确找；否则按 searchPath 顺序找第一个。返回 undefined = 确定不存在；抛错 = 目录不可读 */
  async resolve(node: any, schema: string | undefined, name: string): Promise<RelInfo | undefined> {
    const key = `${nodeKey(node)}|${schema ?? ''}|${name}`;
    const hit = this.cache.get(key);
    if (hit !== undefined && Date.now() - hit.at < this.ttlMs) { this.cache.delete(key); this.cache.set(key, hit); return hit.info; }
    const where = schema !== undefined ? `n.nspname = '${q(schema)}'` : this.excluded();
    const r = await this.query(node, `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS type
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
WHERE c.relname = '${q(name)}' AND ${where} AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','v','m','f','p')
ORDER BY ${this.schemaRank()}, n.nspname, a.attnum`, { maxRows: 400 });
    const first = r.rows[0];
    const info: RelInfo | undefined = first === undefined ? undefined : {
      schema: String(first.schema), name: String(first.name), kind: String(first.kind),
      columns: r.rows.filter((row) => String(row.schema) === String(first.schema)).map((row) => ({ name: String(row.col), type: String(row.type) })),
    };
    this.remember(key, info);
    return info;
  }

  private remember(key: string, info: RelInfo | undefined): void {
    this.cache.set(key, { info, at: Date.now() });
    while (this.cache.size > this.maxEntries) { const oldest = this.cache.keys().next().value; if (oldest === undefined) break; this.cache.delete(oldest); }
  }

  /** 同名关系在哪些 schema（模型把 snapshot.snapshot 写成 dbe_perf.snapshot 之类） */
  async sameNameIn(node: any, name: string): Promise<string[]> {
    const r = await this.query(node, `SELECT DISTINCT n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = '${q(name)}' AND c.relkind IN ('r','v','m','f','p') AND ${this.excluded()} ORDER BY 1`, { maxRows: 12 });
    return r.rows.map((row) => String(row.schema));
  }
  /** 名字相近的关系（关系不存在时给候选） */
  async similarRelations(node: any, name: string): Promise<string[]> {
    const core = name.replace(/^(pg_|snap_|global_|summary_|local_)/, '').replace(/_?(stat|status|info|detail|s)$/, '');
    if (core.length < 3) return [];
    const r = await this.query(node, `SELECT n.nspname || '.' || c.relname AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname ILIKE '%${q(core)}%' AND c.relkind IN ('r','v','m','f','p') AND ${this.excluded()} ORDER BY ${this.schemaRank()}, length(c.relname), c.relname`, { maxRows: 12 });
    return r.rows.map((row) => String(row.rel));
  }
  /** 全库按列名反查：哪些关系有这一列 */
  async findColumns(node: any, keyword: string): Promise<{ rel: string; column: string; type: string }[]> {
    const kw = keyword.trim().toLowerCase();
    if (kw === '') return [];
    const r = await this.query(node, `SELECT n.nspname || '.' || c.relname AS rel, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS type
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE a.attname ILIKE '%${q(kw)}%' AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','v','m','f','p') AND ${this.excluded()}
ORDER BY CASE WHEN a.attname = '${q(kw)}' THEN 0 ELSE 1 END, ${this.schemaRank()}, n.nspname, c.relname, a.attnum`, { maxRows: 40 });
    return r.rows.map((row) => ({ rel: String(row.rel), column: String(row.col), type: String(row.type) }));
  }

  /** db_describe：一张关系的字典；找不到时给同名/近名候选 */
  async describe(node: any, ref: string): Promise<{ info?: RelInfo; elsewhere: string[]; similar: string[] }> {
    const [schema, name] = ref.includes('.') ? ref.split('.', 2) : [undefined, ref];
    const info = await this.resolve(node, schema, name);
    if (info !== undefined) return { info, elsewhere: [], similar: [] };
    return { info, elsewhere: await this.sameNameIn(node, name), similar: await this.similarRelations(node, name) };
  }

  /** 供报错提示复用：某关系的列名（解析不到返回 undefined） */
  async columnsFor(node: any, rel: string): Promise<readonly string[] | undefined> {
    const [schema, name] = rel.includes('.') ? rel.split('.', 2) : [undefined, rel];
    try { return (await this.resolve(node, schema, name))?.columns.map((c) => c.name); } catch { return undefined; }
  }

  /** 执行前校验；任何目录查询失败都放行（fail-open），让真实的数据库错误自己说话 */
  async validate(node: any, sql: string): Promise<Validation> {
    const ex = extractReferences(sql);
    if (!ex.parsed || ex.scopes.length === 0) return { ok: true };
    const wanted = new Map<string, { schema?: string; name: string }>();
    for (const s of ex.scopes) for (const r of s.relations) wanted.set(`${r.schema ?? ''}|${r.name}`, { schema: r.schema, name: r.name });
    const resolved = new Map<string, RelInfo | undefined | null>();
    try {
      await Promise.all([...wanted.entries()].map(async ([k, r]) => { resolved.set(k, await this.resolve(node, r.schema, r.name)); }));
    } catch { return { ok: true }; }
    // map 里 undefined = 目录确认不存在；不在 map 里 = 没查到（不可知 → null 放行）
    const problems = validateReferences(ex, (schema, name) => { const k = `${schema ?? ''}|${name}`; return resolved.has(k) ? resolved.get(k) : null; });
    if (problems.length === 0) return { ok: true };
    return { ok: false, problems, report: await this.report(node, problems) };
  }

  private async report(node: any, problems: Problem[]): Promise<string> {
    const lines: string[] = [];
    const shown = new Set<string>();
    const dict = (info: RelInfo) => {
      const key = `${info.schema}.${info.name}`;
      if (shown.has(key)) return; shown.add(key);
      lines.push(`${key}（${KIND_CN[info.kind] ?? info.kind}）的列：${info.columns.slice(0, 60).map((c) => `${c.name} ${c.type}`).join(', ')}${info.columns.length > 60 ? ` …共 ${info.columns.length} 列` : ''}`);
    };
    for (const p of problems) {
      if (p.kind === 'relation') {
        const full = p.schema !== undefined ? `${p.schema}.${p.name}` : p.name;
        let elsewhere: string[] = []; let similar: string[] = [];
        try { elsewhere = await this.sameNameIn(node, p.name); similar = await this.similarRelations(node, p.name); } catch { /* 候选查不到就只报不存在 */ }
        lines.push(`关系 ${full} 不存在${elsewhere.length > 0 ? `——同名关系在 schema ${elsewhere.join(' / ')}，应写 ${elsewhere.map((s) => `${s}.${p.name}`).join(' 或 ')}` : similar.length > 0 ? `；名字相近的关系：${similar.join(', ')}` : ''}`);
        continue;
      }
      const owner = p.candidates.length === 1 ? `${p.candidates[0].schema}.${p.candidates[0].name}` : p.candidates.map((c) => `${c.schema}.${c.name}`).join(' / ');
      const pool = p.candidates.flatMap((c) => c.columns.map((col) => col.name));
      const closest = closestColumn(p.name, pool);
      let where: { rel: string; column: string; type: string }[] = [];
      try { where = await this.findColumns(node, p.name); } catch { /* 反查失败不影响主结论 */ }
      const whereLine = where.length > 0 ? `；含 ${p.name} 列的关系：${[...new Set(where.map((w) => `${w.rel}.${w.column}`))].slice(0, 8).join(', ')}` : '';
      lines.push(`${owner} 没有列 ${p.qualifier !== undefined ? `${p.qualifier}.` : ''}${p.name}${closest !== undefined && closest.toLowerCase() !== p.name.toLowerCase() ? `——最接近的是 ${closest}` : ''}${whereLine}`);
      for (const c of p.candidates) dict(c);
    }
    return `字典校验未通过，SQL 未执行（目标库的真实字典如下，按它改写后重试；不确定时先用 db_describe / db_find_columns 查字典）：\n- ${lines.join('\n- ')}`;
  }
}

export function formatRelInfo(info: RelInfo): string {
  return `${info.schema}.${info.name}（${KIND_CN[info.kind] ?? info.kind}，${info.columns.length} 列）\n${info.columns.map((c) => `  ${c.name}  ${c.type}`).join('\n')}`;
}
