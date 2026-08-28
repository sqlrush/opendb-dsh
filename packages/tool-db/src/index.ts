import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { QueryResult } from '@opendb-dsh/db';
import { resolvePlatformAgent } from './agent.ts';
import { renderTable, clampText } from './render.ts';
import { buildHint, cteNames, referencedRelations, HINT_CODES, OG_SCHEMA_HINT, TIMEOUT_CODE, timeoutHint } from './schema-hint.ts';

export { resolvePlatformAgent } from './agent.ts';
export { renderTable, clampText, cell } from './render.ts';

export const name = 'tool-db';
export const inject = ['opendbDb', 'opendbRegistry'];
export const Config = z.object({
  maxRows: z.number().step(1).min(1).default(200),
  maxContentBytes: z.number().step(1).min(1024).default(20000),
  /** db_query 的语句超时（user 2026-08-28：15s 撞上 3,355 万行整表聚合，放到 60s；采集器仍用 db seam 的 15s） */
  queryTimeoutMs: z.number().step(1).min(1000).default(60000),
  /** 模型可传 timeout_ms 放宽到的上限 */
  maxQueryTimeoutMs: z.number().step(1).min(1000).default(120000),
});

interface ToolDeps { db: any; registry: any; maxRows: number; maxContentBytes: number; queryTimeoutMs: number; maxQueryTimeoutMs: number }

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
  return defineTool({
    name: 'db_query',
    description: `在当前 agent 绑定的数据库节点上以平台账号执行 SQL（诊断查询、EXPLAIN、SHOW 等）。平台不做语句过滤：能执行什么完全由该节点上平台账号的数据库权限决定，被拒时会原样返回数据库的错误。语句超时默认 ${Math.round(deps.queryTimeoutMs / 1000)}s（可传 timeout_ms 放宽到 ${Math.round(deps.maxQueryTimeoutMs / 1000)}s）；大表整表聚合优先用 pg_class.reltuples / TABLESAMPLE / 累计统计视图。${OG_SCHEMA_HINT}`,
    parameters: {
      sql: { type: 'string', required: true, description: 'SQL 语句（多条以分号分隔时只返回最后一条的结果）。' },
      node: { type: 'string', description: '目标节点名称；agent 只绑定一个节点时可省略。' },
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
      try {
        const r = await deps.db.query(node, sql, { maxRows: Math.min(Number(args.max_rows ?? deps.maxRows), deps.maxRows), timeoutMs });
        return { content: formatResult(node, sql, r, deps.maxContentBytes) };
      } catch (cause) {
        const err = cause as { code?: string; message?: string };
        // 语句超时：说明是平台的线、值是多少、怎么绕（2026-08-28）
        if (String(err?.code ?? '') === TIMEOUT_CODE && /statement timeout/i.test(String(err?.message ?? ''))) throw new Error(timeoutHint(timeoutMs, deps.maxQueryTimeoutMs));
        // 列/表/函数不存在：把 SQL 引用的关系的真实列名查出来附在错误里，模型一次改对（2026-08-26 event_name 事故）
        if (!HINT_CODES.has(String(err?.code ?? ''))) throw cause;
        const cache = new Map<string, readonly string[] | undefined>();
        const lookup = async (rel: string): Promise<readonly string[] | undefined> => {
          const [schema, table] = rel.includes('.') ? rel.split('.', 2) : ['', rel];
          try {
            const q = schema !== ''
              ? await deps.db.query(node, `SELECT column_name FROM information_schema.columns WHERE table_schema = '${schema.replace(/'/g, "''")}' AND table_name = '${table.replace(/'/g, "''")}' ORDER BY ordinal_position`, { maxRows: 200 })
              : await deps.db.query(node, `SELECT column_name FROM information_schema.columns WHERE table_name = '${table.replace(/'/g, "''")}' AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY ordinal_position`, { maxRows: 200 });
            return q.rows.length > 0 ? q.rows.map((row: any) => String(row.column_name)) : undefined;
          } catch { return undefined; }
        };
        // 表不存在时再找同名表在哪个 schema（模型常把 snapshot.snapshot 写成 dbe_perf.snapshot）
        const elsewhere = new Map<string, readonly string[] | undefined>();
        const whereElse = async (rel: string): Promise<readonly string[] | undefined> => {
          const table = (rel.includes('.') ? rel.split('.', 2)[1] : rel).replace(/'/g, "''");
          try {
            // 排除 openGauss 内部 schema（db4ai 里也有一张 snapshot，指过去只会误导）
            const q = await deps.db.query(node, `SELECT table_schema FROM information_schema.tables WHERE table_name = '${table}' AND table_schema NOT IN ('pg_catalog','information_schema','db4ai','dbe_pldeveloper','cstore','pg_toast') ORDER BY table_schema`, { maxRows: 8 });
            return q.rows.length > 0 ? q.rows.map((row: any) => String(row.table_schema)) : undefined;
          } catch { return undefined; }
        };
        // buildHint 是同步的：先把所有引用关系的列查好再拼
        for (const rel of referencedRelations(sql, cteNames(sql))) {
          const cols = await lookup(rel);
          cache.set(rel, cols);
          if (cols === undefined) elsewhere.set(rel, await whereElse(rel));
        }
        const hint = buildHint(sql, err, (rel) => cache.get(rel), (rel) => elsewhere.get(rel));
        throw new Error(`${String(err?.message ?? cause)}${hint}`);
      }
    },
  } as any);
}

function defineDbOverviewTool(deps: ToolDeps) {
  return defineTool({
    name: 'db_overview',
    description: '获取节点健康总览：版本、会话、Top SQL、等待事件、锁、库大小、复制状态（按引擎方言取自监控视图）。',
    parameters: {
      node: { type: 'string', description: '目标节点名称；agent 只绑定一个节点时可省略。' },
    },
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
export function apply(ctx: Context, config: { maxRows?: number; maxContentBytes?: number; queryTimeoutMs?: number; maxQueryTimeoutMs?: number } = {}): void {
  const anyCtx = ctx as any;
  anyCtx.inject(['tools'], (c: any) => {
    const deps: ToolDeps = {
      db: anyCtx.opendbDb,
      registry: anyCtx.opendbRegistry,
      maxRows: config.maxRows ?? 200,
      maxContentBytes: config.maxContentBytes ?? 20000,
      queryTimeoutMs: config.queryTimeoutMs ?? 60000,
      maxQueryTimeoutMs: config.maxQueryTimeoutMs ?? 120000,
    };
    c.effect(() => c.tools.register(defineDbNodesTool(deps)), 'tool-db.db_nodes');
    c.effect(() => c.tools.register(defineDbQueryTool(deps)), 'tool-db.db_query');
    c.effect(() => c.tools.register(defineDbOverviewTool(deps)), 'tool-db.db_overview');
  });
}
