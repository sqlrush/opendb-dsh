import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { QueryResult } from '@opendb-dsh/db';
import { resolvePlatformAgent } from './agent.ts';
import { renderTable, clampText } from './render.ts';
import { buildHint, cteNames, referencedRelations, HINT_CODES, OG_SCHEMA_HINT, TIMEOUT_CODE, timeoutHint } from './schema-hint.ts';
import { DictionaryGate, formatRelInfo } from './dictionary.ts';

export { resolvePlatformAgent } from './agent.ts';
export { renderTable, clampText, cell } from './render.ts';
export { DictionaryGate } from './dictionary.ts';
export { extractReferences, validateReferences, stripExplain } from './sql-refs.ts';

export const name = 'tool-db';
export const inject = ['opendbDb', 'opendbRegistry'];
export const Config = z.object({
  maxRows: z.number().step(1).min(1).default(200),
  maxContentBytes: z.number().step(1).min(1024).default(20000),
  /** db_query 的语句超时（user 2026-08-28：15s 撞上 3,355 万行整表聚合，放到 60s；采集器仍用 db seam 的 15s） */
  queryTimeoutMs: z.number().step(1).min(1000).default(60000),
  /** 模型可传 timeout_ms 放宽到的上限 */
  maxQueryTimeoutMs: z.number().step(1).min(1000).default(120000),
  /** 字典门：执行前按目标库真实字典校验引用的表/列（2026-08-29 user 定）；关掉则只保留报错后的列名提示 */
  dictionaryGate: z.boolean().default(true),
  /** 字典缓存 TTL（每节点每关系） */
  dictionaryTtlMs: z.number().step(1).min(1000).default(10 * 60_000),
});

interface ToolDeps { db: any; registry: any; maxRows: number; maxContentBytes: number; queryTimeoutMs: number; maxQueryTimeoutMs: number; gate: DictionaryGate; gateEnabled: boolean }

export class ToolInputError extends Error {}

/** The node a call targets: must be bound to the calling agent; default = the agent's only node. */
export async function pickNode(registry: any, exec: any, nodeRef: string | undefined) {
  const agent = await resolvePlatformAgent(registry, exec?.agent);
  if (agent === undefined) throw new ToolInputError('无法确定当前会话所属的平台 agent（会话没有绑定工作区）');
  const nodes = await registry.listNodes({ agentId: agent.id });
  if (nodes.length === 0) throw new ToolInputError(`agent「${agent.name}」还没有绑定任何数据库节点（请在 设置 → OpenDB 里绑定）`);
  if (nodeRef === undefined || nodeRef === '') {
    if (nodes.length === 1) return { agent, node: nodes[0] };
    throw new ToolInputError(`agent「${agent.name}」绑定了多个节点，请用 node 参数指定其一：${nodes.map((n: any) => n.name).join(', ')}`);
  }
  const node = nodes.find((n: any) => n.name === nodeRef || n.id === nodeRef);
  if (node === undefined) throw new ToolInputError(`节点「${nodeRef}」不存在或未绑定到 agent「${agent.name}」；可用节点：${nodes.map((n: any) => n.name).join(', ')}`);
  return { agent, node };
}

function formatResult(node: any, sql: string, r: QueryResult, maxContentBytes: number): string {
  const head = `-- ${node.name} (${node.engine} ${node.host}:${node.port}/${node.dbname}) ${r.ms}ms, ${r.rowCount} rows${r.truncated ? '（已截断到行数上限）' : ''}`;
  return clampText(`${head}\n${renderTable(r.fields, r.rows)}`, maxContentBytes);
}

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { content: { type: 'string', required: true } },
  },
  render: (_args: unknown, value: any) => [{ type: 'text', text: value.content }],
} as const;

const NODE_PARAM = { type: 'string', description: '目标节点名称；agent 只绑定一个节点时可省略。' } as const;

function defineDbNodesTool(deps: ToolDeps) {
  return defineTool({
    name: 'db_nodes',
    description: '列出当前 agent 绑定的数据库节点（名称、引擎、地址、状态）。',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute(_args: unknown, exec: any) {
      const agent = await resolvePlatformAgent(deps.registry, exec?.agent);
      if (agent === undefined) return { content: '无法确定当前会话所属的平台 agent（会话没有绑定工作区）' };
      const nodes = await deps.registry.listNodes({ agentId: agent.id });
      const rows = nodes.map((n: any) => ({ name: n.name, engine: n.engine, address: `${n.host}:${n.port}/${n.dbname}`, status: n.status }));
      return { content: `agent「${agent.name}」绑定节点 ${nodes.length} 个\n${renderTable(['name', 'engine', 'address', 'status'], rows)}` };
    },
  } as any);
}

function defineDbQueryTool(deps: ToolDeps) {
  const gateLine = deps.gateEnabled
    ? '执行前会按目标库的真实数据字典校验 SQL 引用的表/列：有不存在的表/列时不执行，直接返回该关系的真实列与"哪些关系有这一列"（把它当字典用，按它改写后重试）。不确定列名先用 db_describe / db_find_columns 查字典，不要凭 PostgreSQL 的印象猜。'
    : '';
  return defineTool({
    name: 'db_query',
    description: `在当前 agent 绑定的数据库节点上以平台账号执行 SQL（诊断查询、EXPLAIN、SHOW 等）。平台不做语句过滤：能执行什么完全由该节点上平台账号的数据库权限决定，被拒时会原样返回数据库的错误。${gateLine}语句超时默认 ${Math.round(deps.queryTimeoutMs / 1000)}s（可传 timeout_ms 放宽到 ${Math.round(deps.maxQueryTimeoutMs / 1000)}s）；大表整表聚合优先用 pg_class.reltuples / TABLESAMPLE / 累计统计视图。${OG_SCHEMA_HINT}`,
    parameters: {
      sql: { type: 'string', required: true, description: 'SQL 语句（多条以分号分隔时只返回最后一条的结果）。' },
      node: NODE_PARAM,
      max_rows: { type: 'integer', description: `返回行数上限（默认/上限 ${deps.maxRows}）。` },
      timeout_ms: { type: 'integer', description: `本条语句的超时毫秒数（默认 ${deps.queryTimeoutMs}，上限 ${deps.maxQueryTimeoutMs}）。` },
    },
    output: TEXT_OUTPUT,
    async execute(args: any, exec: any) {
      const { node } = await pickNode(deps.registry, exec, args.node);
      const sql = String(args.sql ?? '').trim();
      if (sql === '') throw new ToolInputError('SQL 为空');
      const wanted = Number(args.timeout_ms);
      const timeoutMs = Math.min(Number.isFinite(wanted) && wanted >= 1000 ? Math.floor(wanted) : deps.queryTimeoutMs, deps.maxQueryTimeoutMs);
      // 字典门：引用了不存在的表/列 → 不执行，直接返回字典单（fail-open：解析不了或目录查不到都放行）
      if (deps.gateEnabled) {
        const v = await deps.gate.validate(node, sql);
        if (!v.ok) throw new Error(v.report);
      }
      try {
        const r = await deps.db.query(node, sql, { maxRows: Math.min(Number(args.max_rows ?? deps.maxRows), deps.maxRows), timeoutMs });
        return { content: formatResult(node, sql, r, deps.maxContentBytes) };
      } catch (cause) {
        const err = cause as { code?: string; message?: string };
        // 语句超时：说明是平台的线、值是多少、怎么绕（2026-08-28）
        if (String(err?.code ?? '') === TIMEOUT_CODE && /statement timeout/i.test(String(err?.message ?? ''))) throw new Error(timeoutHint(timeoutMs, deps.maxQueryTimeoutMs));
        // 列/表/函数不存在（字典门没拦到的：方言解析不了、限定名归属不清等）：把引用关系的真实列名附在错误里
        if (!HINT_CODES.has(String(err?.code ?? ''))) throw cause;
        const cache = new Map<string, readonly string[] | undefined>();
        const elsewhere = new Map<string, readonly string[] | undefined>();
        for (const rel of referencedRelations(sql, cteNames(sql))) {
          const cols = await deps.gate.columnsFor(node, rel);
          cache.set(rel, cols);
          if (cols === undefined) {
            const table = rel.includes('.') ? rel.split('.', 2)[1] : rel;
            try { elsewhere.set(rel, await deps.gate.sameNameIn(node, table)); } catch { elsewhere.set(rel, undefined); }
          }
        }
        const hint = buildHint(sql, err, (rel) => cache.get(rel), (rel) => elsewhere.get(rel));
        throw new Error(`${String(err?.message ?? cause)}${hint}`);
      }
    },
  } as any);
}

function defineDbDescribeTool(deps: ToolDeps) {
  return defineTool({
    name: 'db_describe',
    description: '查数据字典：某张表/视图的真实列与类型（schema 可省，按 pg_catalog / public / dbe_perf / snapshot 顺序找；找不到时给出同名关系所在的 schema 与名字相近的关系）。写 SQL 前不确定列名就先查它，不要猜。',
    parameters: {
      relation: { type: 'string', required: true, description: '表/视图名，可带 schema，如 pg_stat_activity、dbe_perf.wait_events、snapshot.snap_summary_statement。' },
      node: NODE_PARAM,
    },
    output: TEXT_OUTPUT,
    async execute(args: any, exec: any) {
      const { node } = await pickNode(deps.registry, exec, args.node);
      const ref = String(args.relation ?? '').trim().replace(/^"|"$/g, '');
      if (ref === '') throw new ToolInputError('relation 为空');
      const d = await deps.gate.describe(node, ref);
      if (d.info !== undefined) return { content: clampText(`-- ${node.name} 数据字典\n${formatRelInfo(d.info)}`, deps.maxContentBytes) };
      const lines = [`关系 ${ref} 在 ${node.name} 上不存在（或无权访问）`];
      if (d.elsewhere.length > 0) lines.push(`同名关系在 schema：${d.elsewhere.join(' / ')}（写全名，如 ${d.elsewhere[0]}.${ref.includes('.') ? ref.split('.', 2)[1] : ref}）`);
      if (d.similar.length > 0) lines.push(`名字相近的关系：${d.similar.join(', ')}`);
      lines.push('也可用 db_find_columns 按列名反查它在哪张视图里。');
      return { content: lines.join('\n') };
    },
  } as any);
}

function defineDbFindColumnsTool(deps: ToolDeps) {
  return defineTool({
    name: 'db_find_columns',
    description: '按列名关键词反查哪些表/视图有这一列（如 wait_event → pg_thread_wait_status / dbe_perf.thread_wait_status …）。想找某个指标却不知道它在哪张视图时用它，比猜列名快。',
    parameters: {
      keyword: { type: 'string', required: true, description: '列名关键词（子串匹配，不区分大小写），如 wait_event、spill、blks_hit。' },
      node: NODE_PARAM,
    },
    output: TEXT_OUTPUT,
    async execute(args: any, exec: any) {
      const { node } = await pickNode(deps.registry, exec, args.node);
      const kw = String(args.keyword ?? '').trim();
      if (kw === '') throw new ToolInputError('keyword 为空');
      const hits = await deps.gate.findColumns(node, kw);
      if (hits.length === 0) return { content: `${node.name} 上没有列名含 "${kw}" 的表/视图（已排除系统内部 schema）。换个关键词，或用 db_describe 看某张视图的全部列。` };
      const byRel = new Map<string, string[]>();
      for (const h of hits) byRel.set(h.rel, [...(byRel.get(h.rel) ?? []), `${h.column} ${h.type}`]);
      return { content: clampText(`-- ${node.name} 列名含 "${kw}" 的关系（${byRel.size} 个）\n${[...byRel.entries()].map(([rel, cols]) => `${rel}: ${cols.join(', ')}`).join('\n')}`, deps.maxContentBytes) };
    },
  } as any);
}

function defineDbOverviewTool(deps: ToolDeps) {
  return defineTool({
    name: 'db_overview',
    description: '获取节点健康总览：版本、会话、Top SQL、等待事件、锁、库大小、复制状态（按引擎方言取自监控视图）。',
    parameters: { node: NODE_PARAM },
    output: TEXT_OUTPUT,
    async execute(args: any, exec: any) {
      const { node } = await pickNode(deps.registry, exec, args.node);
      const sections = await deps.db.overview(node);
      const parts: string[] = [`# ${node.name} (${node.engine} ${node.host}:${node.port}/${node.dbname}) 健康总览`];
      for (const s of sections) {
        if ('error' in s) parts.push(`## ${s.title}\n[查询失败] ${s.error}`);
        else parts.push(`## ${s.title}\n${renderTable(s.result.fields, s.result.rows)}`);
      }
      return { content: clampText(parts.join('\n\n'), deps.maxContentBytes) };
    },
  } as any);
}

/**
 * Read-only database diagnostics tools for Runtime pods (design §8 tool-db).
 * Registered wherever a tools registry exists; scoping: a call may only touch
 * nodes bound to the platform agent the session belongs to.
 */
export function apply(ctx: Context, config: { maxRows?: number; maxContentBytes?: number; queryTimeoutMs?: number; maxQueryTimeoutMs?: number; dictionaryGate?: boolean; dictionaryTtlMs?: number } = {}): void {
  const anyCtx = ctx as any;
  anyCtx.inject(['tools'], (c: any) => {
    const db = anyCtx.opendbDb;
    const deps: ToolDeps = {
      db,
      registry: anyCtx.opendbRegistry,
      maxRows: config.maxRows ?? 200,
      maxContentBytes: config.maxContentBytes ?? 20000,
      queryTimeoutMs: config.queryTimeoutMs ?? 60000,
      maxQueryTimeoutMs: config.maxQueryTimeoutMs ?? 120000,
      gate: new DictionaryGate((node, sql, opts) => db.query(node, sql, opts), { ttlMs: config.dictionaryTtlMs ?? 10 * 60_000 }),
      gateEnabled: config.dictionaryGate ?? true,
    };
    c.effect(() => c.tools.register(defineDbNodesTool(deps)), 'tool-db.db_nodes');
    c.effect(() => c.tools.register(defineDbQueryTool(deps)), 'tool-db.db_query');
    c.effect(() => c.tools.register(defineDbDescribeTool(deps)), 'tool-db.db_describe');
    c.effect(() => c.tools.register(defineDbFindColumnsTool(deps)), 'tool-db.db_find_columns');
    c.effect(() => c.tools.register(defineDbOverviewTool(deps)), 'tool-db.db_overview');
  });
}
