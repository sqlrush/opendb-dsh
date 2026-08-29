/**
 * 字典门的纯函数半边（2026-08-29 user："补提示词补不完的，让模型先确认字典再写 SQL"）：
 * 把 SQL 解析成 AST（pgsql-ast-parser），按作用域抽出引用的关系与列，再对照真实字典找出不存在的表/列。
 * 原则：**fail-open**——解析不了的方言语句、归属不清的列一律放行，只拦"能确定引用了哪张表、而那张表确实没有这一列"的情况。
 * 不碰连接，可单测；查目录与缓存在 dictionary.ts。
 */
import { parse } from 'pgsql-ast-parser';

export interface RelRef { schema?: string; name: string; alias?: string }
export interface ColRef { qualifier?: string; name: string }
export interface Scope {
  relations: RelRef[];
  /** 子查询 / CTE / 函数表 的别名——它们的列不可知，落在它们上的引用放行 */
  derived: Set<string>;
  refs: ColRef[];
  /** SELECT 列表里的别名（ORDER BY n 这种引用不是真实列） */
  selectAliases: Set<string>;
  parent?: Scope;
}
export interface Extracted { parsed: boolean; scopes: Scope[] }
export interface RelInfo { schema: string; name: string; kind: string; columns: { name: string; type: string }[] }
export type Problem =
  | { kind: 'relation'; schema?: string; name: string }
  | { kind: 'column'; name: string; qualifier?: string; candidates: RelInfo[] };

/** EXPLAIN [(...)] [ANALYZE|VERBOSE|...] 前缀解析器不认，剥掉后按内层语句校验 */
export function stripExplain(sql: string): { sql: string; explain: boolean } {
  const m = /^\s*explain\b(?:\s*\([^)]*\))?(?:\s+(?:analyze|analyse|verbose|costs|buffers|timing|summary|performance|format\s+\w+))*\s*/i.exec(sql);
  if (m === null) return { sql, explain: false };
  return { sql: sql.slice(m[0].length), explain: true };
}

const STATEMENT_TYPES = new Set(['select', 'with', 'union', 'union all', 'intersect', 'intersect all', 'except', 'except all', 'values', 'insert', 'update', 'delete', 'with recursive']);

export function extractReferences(sql: string): Extracted {
  let stmts: any[];
  try { stmts = parse(stripExplain(sql).sql) as any[]; } catch { return { parsed: false, scopes: [] }; }
  const scopes: Scope[] = [];
  for (const st of stmts) walkStatement(st, undefined, new Set(), scopes);
  return { parsed: true, scopes };
}

function newScope(parent: Scope | undefined): Scope {
  return { relations: [], derived: new Set(), refs: [], selectAliases: new Set(), parent };
}

function walkStatement(node: any, parent: Scope | undefined, cte: Set<string>, out: Scope[]): void {
  if (node === null || typeof node !== 'object') return;
  const t = String(node.type ?? '');
  if (t === 'with' || t === 'with recursive') {
    const names = new Set(cte);
    for (const b of node.bind ?? []) names.add(String(b.alias?.name ?? '').toLowerCase());
    // CTE 体看不到外层查询的 FROM：作用域不继承
    for (const b of node.bind ?? []) walkStatement(b.statement, undefined, names, out);
    walkStatement(node.in, parent, names, out);
    return;
  }
  if (t === 'union' || t === 'union all' || t === 'intersect' || t === 'intersect all' || t === 'except' || t === 'except all') {
    walkStatement(node.left, parent, cte, out); walkStatement(node.right, parent, cte, out); return;
  }
  if (t === 'select') {
    const scope = newScope(parent);
    for (const item of node.from ?? []) {
      const it = String(item.type ?? '');
      if (it === 'table') {
        const name = String(item.name?.name ?? ''); const schema = item.name?.schema !== undefined ? String(item.name.schema) : undefined; const alias = item.name?.alias !== undefined ? String(item.name.alias) : undefined;
        if (schema === undefined && cte.has(name.toLowerCase())) scope.derived.add((alias ?? name).toLowerCase());
        else scope.relations.push({ schema, name, alias });
      } else if (it === 'statement') {
        scope.derived.add(String(item.alias ?? '').toLowerCase());
        // FROM 里的派生表（非 LATERAL）看不到同级/外层 FROM：作用域不继承，其内部无限定列照常按自己的基表校验
        walkStatement(item.statement, undefined, cte, out);
      } else if (it === 'call') {
        scope.derived.add(String(item.alias?.name ?? item.function?.name ?? '').toLowerCase());
        walkExpr(item.args, scope, cte, out);
      }
      if (item.join !== undefined) walkExpr(item.join.on, scope, cte, out);
    }
    for (const c of node.columns ?? []) {
      if (c.alias?.name !== undefined) scope.selectAliases.add(String(c.alias.name).toLowerCase());
      walkExpr(c.expr, scope, cte, out);
    }
    walkExpr(node.where, scope, cte, out); walkExpr(node.groupBy, scope, cte, out); walkExpr(node.having, scope, cte, out);
    walkExpr(node.orderBy, scope, cte, out); walkExpr(node.limit, scope, cte, out); walkExpr(node.distinct, scope, cte, out);
    out.push(scope);
    return;
  }
  if (t === 'update' || t === 'delete' || t === 'insert') {
    const scope = newScope(parent);
    const tbl = t === 'update' ? node.table : t === 'delete' ? node.from : node.into;
    if (tbl?.name !== undefined) scope.relations.push({ schema: tbl.schema !== undefined ? String(tbl.schema) : undefined, name: String(tbl.name), alias: tbl.alias !== undefined ? String(tbl.alias) : undefined });
    for (const f of node.from ?? []) if (f?.type === 'table' && f.name?.name !== undefined) scope.relations.push({ schema: f.name.schema, name: String(f.name.name), alias: f.name.alias });
    for (const s of node.sets ?? []) { if (s.column?.name !== undefined) scope.refs.push({ name: String(s.column.name) }); walkExpr(s.value, scope, cte, out); }
    for (const c of node.columns ?? []) if (c?.name !== undefined) scope.refs.push({ name: String(c.name) });
    walkExpr(node.where, scope, cte, out); walkExpr(node.returning, scope, cte, out);
    if (node.insert !== undefined) walkStatement(node.insert, scope, cte, out);
    out.push(scope);
    return;
  }
  // SHOW / SET / DDL / 其它：不校验
}

function walkExpr(expr: any, scope: Scope, cte: Set<string>, out: Scope[]): void {
  if (expr === null || expr === undefined || typeof expr !== 'object') return;
  if (Array.isArray(expr)) { for (const e of expr) walkExpr(e, scope, cte, out); return; }
  const t = String(expr.type ?? '');
  if (t === 'ref') {
    const name = String(expr.name ?? '');
    if (name !== '*' && name !== '') scope.refs.push({ qualifier: expr.table !== undefined ? qualifierOf(expr.table) : undefined, name });
    return;
  }
  if (STATEMENT_TYPES.has(t)) { walkStatement(expr, scope, cte, out); return; }
  for (const k of Object.keys(expr)) { if (k === 'type' || k === '_location') continue; walkExpr(expr[k], scope, cte, out); }
}

const qualifierOf = (tbl: any): string => (tbl.schema !== undefined ? `${String(tbl.schema)}.${String(tbl.name)}` : String(tbl.name ?? ''));
const lc = (s: string) => s.toLowerCase();

/** 关系在字典里的样子：lookup 返回 undefined = 确定不存在；null = 查不到（连接/权限问题）→ 视为不可知，放行 */
export type Lookup = (schema: string | undefined, name: string) => RelInfo | undefined | null;

export function validateReferences(ex: Extracted, lookup: Lookup): Problem[] {
  if (!ex.parsed) return [];
  const problems: Problem[] = [];
  const seen = new Set<string>();
  const push = (p: Problem) => { const k = p.kind === 'relation' ? `r|${p.schema ?? ''}|${p.name}` : `c|${p.qualifier ?? ''}|${p.name}`; if (!seen.has(k)) { seen.add(k); problems.push(p); } };
  // 每个作用域：别名 → 关系信息（null = 不可知）
  const infoOf = (scope: Scope): Map<string, RelInfo | null> => {
    const m = new Map<string, RelInfo | null>();
    for (const r of scope.relations) {
      const info = lookup(r.schema, r.name);
      const v = info === undefined ? null : info;
      if (info === undefined) push({ kind: 'relation', schema: r.schema, name: r.name });
      for (const key of [r.alias, r.name, r.schema !== undefined ? `${r.schema}.${r.name}` : undefined]) if (key !== undefined) m.set(lc(key), v);
    }
    return m;
  };
  const chainOf = (scope: Scope): Scope[] => { const c: Scope[] = []; for (let s: Scope | undefined = scope; s !== undefined; s = s.parent) c.push(s); return c; };
  const infos = new Map<Scope, Map<string, RelInfo | null>>();
  for (const scope of ex.scopes) infos.set(scope, infoOf(scope));
  const hasCol = (info: RelInfo, col: string) => info.columns.some((c) => lc(c.name) === lc(col));
  for (const scope of ex.scopes) {
    const chain = chainOf(scope);
    for (const ref of scope.refs) {
      if (ref.qualifier !== undefined) {
        const q = lc(ref.qualifier);
        let found: RelInfo | null | 'derived' | undefined;
        for (const s of chain) {
          if (s.derived.has(q)) { found = 'derived'; break; }
          const m = infos.get(s); if (m?.has(q)) { found = m.get(q); break; }
        }
        if (found === undefined || found === null || found === 'derived') continue;   // 归属不清 / 不可知 / 派生表 → 放行
        if (!hasCol(found, ref.name)) push({ kind: 'column', name: ref.name, qualifier: ref.qualifier, candidates: [found] });
        continue;
      }
      // 无限定名：在作用域链上所有已知关系里找；链上有派生表/不可知关系，或命中 SELECT 别名 → 放行
      if (chain.some((s) => s.selectAliases.has(lc(ref.name)))) continue;
      const known: RelInfo[] = []; let opaque = false;
      for (const s of chain) {
        if (s.derived.size > 0) opaque = true;
        for (const v of infos.get(s)?.values() ?? []) { if (v === null) opaque = true; else if (!known.includes(v)) known.push(v); }
      }
      if (known.length === 0 || opaque) continue;
      if (!known.some((info) => hasCol(info, ref.name))) push({ kind: 'column', name: ref.name, candidates: known });
    }
  }
  return problems;
}
