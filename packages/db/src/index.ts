import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import pg from 'pg';
import type { DbNodeRecord } from '@opendb-dsh/registry';
import { POSTGRESQL_DIALECT, type Dialect, type DialectQuery } from './dialect.ts';

export { POSTGRESQL_DIALECT, BASELINE_METRICS, BASELINE_DICTIONARY, type Dialect, type DialectQuery } from './dialect.ts';

export interface DbCredential { username?: string; password?: string }
export interface QueryOptions { maxRows?: number; timeoutMs?: number }
export interface QueryResult { rows: Record<string, unknown>[]; fields: string[]; rowCount: number; truncated: boolean; ms: number }
export type OverviewSection = { key: string; title: string } & ({ result: QueryResult } | { error: string });

declare module '@deepseek-ai/cordis' {
  interface Context { opendbDb: DbService }
}

/** Parse OPENDB_DB_CREDENTIALS: `{ "<node name>": { "username": "...", "password": "..." } }`. */
export function parseCredentials(json: string): Map<string, DbCredential> {
  const out = new Map<string, DbCredential>();
  if (json.trim() === '') return out;
  let raw: unknown;
  try { raw = JSON.parse(json); } catch (cause) { throw new Error(`OPENDB_DB_CREDENTIALS is not valid JSON: ${String(cause)}`); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('OPENDB_DB_CREDENTIALS must be a JSON object keyed by node name');
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'object' || value === null) throw new Error(`OPENDB_DB_CREDENTIALS["${name}"] must be an object`);
    const v = value as Record<string, unknown>;
    out.set(name, {
      username: typeof v.username === 'string' ? v.username : undefined,
      password: typeof v.password === 'string' ? v.password : undefined,
    });
  }
  return out;
}

/**
 * ctx.opendbDb — the `db` seam (design §8): per-node connection pools to managed database
 * nodes plus an engine-dialect registry. What the platform may do on a node is decided by
 * the node itself — the grants / role settings of the platform account (user 2026-08-27:
 * 权限放在数据库里控制，平台插件不做控制). The former plugin-side controls (SQL gate in
 * tool-db, startup-packet `default_transaction_read_only=on`) are gone on purpose.
 * Credentials come from env/Secret, never from the registry tables (003_registry.sql decision).
 */
export default class DbService extends Service {
  static Config = z.object({
    credentialsJson: z.string().default(''),
    statementTimeoutMs: z.number().step(1).min(1000).default(15000),
    connectTimeoutMs: z.number().step(1).min(1000).default(8000),
    maxRows: z.number().step(1).min(1).default(200),
    poolSizePerNode: z.number().step(1).min(1).default(2),
  });
  static inject = ['opendbRegistry'];

  private readonly registry: any;
  private readonly credentials: Map<string, DbCredential>;
  private readonly dialects = new Map<string, Dialect>();
  private readonly pools = new Map<string, pg.Pool>();
  private readonly cfg: { statementTimeoutMs: number; connectTimeoutMs: number; maxRows: number; poolSizePerNode: number };

  constructor(ctx: Context, config: { credentialsJson?: string; statementTimeoutMs?: number; connectTimeoutMs?: number; maxRows?: number; poolSizePerNode?: number } = {}) {
    super(ctx, 'opendbDb');
    this.registry = (ctx as any).opendbRegistry;
    this.credentials = parseCredentials(config.credentialsJson ?? '');
    this.cfg = {
      statementTimeoutMs: config.statementTimeoutMs ?? 15000,
      connectTimeoutMs: config.connectTimeoutMs ?? 8000,
      maxRows: config.maxRows ?? 200,
      poolSizePerNode: config.poolSizePerNode ?? 2,
    };
    this.dialects.set(POSTGRESQL_DIALECT.engine, POSTGRESQL_DIALECT);
    ctx.effect(() => () => this.closeAll(), 'opendbDb.pools');
  }

  /** Register (or override) an engine dialect; returns the disposer for ctx.effect. */
  registerDialect(dialect: Dialect): () => void {
    const previous = this.dialects.get(dialect.engine);
    this.dialects.set(dialect.engine, dialect);
    return () => {
      if (previous !== undefined) this.dialects.set(dialect.engine, previous);
      else this.dialects.delete(dialect.engine);
    };
  }

  /** Dialect for an engine; unknown engines fall back to the PostgreSQL baseline. */
  dialect(engine: string): Dialect {
    return this.dialects.get(engine) ?? POSTGRESQL_DIALECT;
  }

  /** Resolve a node by registry id or (tenant-unique) name. */
  async resolveNode(ref: string): Promise<DbNodeRecord | undefined> {
    const nodes: DbNodeRecord[] = await this.registry.listNodes();
    return nodes.find((n) => n.id === ref) ?? nodes.find((n) => n.name === ref);
  }

  /**
   * Run a statement on a node. Rows beyond maxRows are dropped and flagged. Multi-statement
   * text is passed through as-is (the node decides whether it may run); the result shown is
   * the last statement's, the way psql does it.
   */
  async query(node: DbNodeRecord, sql: string, options: QueryOptions = {}): Promise<QueryResult> {
    const maxRows = options.maxRows ?? this.cfg.maxRows;   // callers (tool-db) clamp model-facing requests themselves; collector needs larger scans
    const pool = this.poolFor(node);
    const started = Date.now();
    // 语句超时：连接池默认 statementTimeoutMs（采集器等用）；调用方可按语句放宽/收紧（db_query 默认 60s，user 2026-08-28）
    const timeoutMs = options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) ? Math.max(1000, Math.floor(options.timeoutMs)) : undefined;
    const raw = timeoutMs === undefined || timeoutMs === this.cfg.statementTimeoutMs ? await pool.query(sql) : await this.queryWithTimeout(pool, sql, timeoutMs);
    const result = lastResult(raw);
    const ms = Date.now() - started;
    const all = (result.rows ?? []) as Record<string, unknown>[];
    const rows = all.length > maxRows ? all.slice(0, maxRows) : all;
    return {
      rows,
      fields: result.fields?.map((f) => f.name) ?? [],
      rowCount: all.length,
      truncated: all.length > maxRows,
      ms,
    };
  }

  /** Run the node's dialect overview set; each section fails independently. */
  async overview(node: DbNodeRecord): Promise<OverviewSection[]> {
    const sections: OverviewSection[] = [];
    for (const q of this.dialect(node.engine).overview) {
      try {
        sections.push({ key: q.key, title: q.title, result: await this.query(node, q.sql, { maxRows: 50 }) });
      } catch (cause) {
        sections.push({ key: q.key, title: q.title, error: String((cause as Error).message ?? cause) });
      }
    }
    return sections;
  }

  /** Cheap health probe. */
  async ping(node: DbNodeRecord): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const r = await this.query(node, 'SELECT version()', { maxRows: 1 });
      return { ok: true, version: String(r.rows[0]?.version ?? '') };
    } catch (cause) {
      return { ok: false, error: String((cause as Error).message ?? cause) };
    }
  }

  /** 借一条连接改 statement_timeout 跑这一条，跑完改回池默认再归还（取消/超时后连接仍可用；致命错误则销毁） */
  private async queryWithTimeout(pool: pg.Pool, sql: string, timeoutMs: number): Promise<pg.QueryResult | pg.QueryResult[]> {
    const c = await pool.connect();
    let broken = false;
    try {
      await c.query(`SET statement_timeout = ${timeoutMs}`);
      return await c.query(sql);
    } catch (cause) {
      const code = (cause as { code?: string }).code ?? '';
      broken = code !== '' && !code.startsWith('57') && !code.startsWith('42') && !code.startsWith('22') && !code.startsWith('25');   // 非语句级错误：连接可能已坏
      throw cause;
    } finally {
      if (broken) c.release(true);
      else {
        try { await c.query(`SET statement_timeout = ${this.cfg.statementTimeoutMs}`); c.release(); } catch { c.release(true); }
      }
    }
  }

  private poolFor(node: DbNodeRecord): pg.Pool {
    const existing = this.pools.get(node.id);
    if (existing !== undefined) return existing;
    // 精确名优先；'*' 为缺省凭据（W6 规模场景：950 节点共用平台只读账号，不必逐节点登记）
    const cred = this.credentials.get(node.name) ?? this.credentials.get('*') ?? {};
    const pool = new pg.Pool({
      host: node.host,
      port: node.port,
      database: node.dbname,
      user: cred.username ?? node.username ?? 'opendb_ro',
      password: cred.password,
      max: this.cfg.poolSizePerNode,
      connectionTimeoutMillis: this.cfg.connectTimeoutMs,
      idleTimeoutMillis: 60_000,
      statement_timeout: this.cfg.statementTimeoutMs,
      allowExitOnIdle: true,
    });
    pool.on('error', (cause) => {
      process.stderr.write(`[opendb-db] idle client error on ${node.name}: ${String(cause)}\n`);
    });
    this.pools.set(node.id, pool);
    return pool;
  }

  private async closeAll(): Promise<void> {
    await Promise.allSettled([...this.pools.values()].map((p) => p.end()));
    this.pools.clear();
  }
}
export { DbService };

/** node-pg returns an array of results for multi-statement simple queries; surface the last one (psql semantics). */
function lastResult(r: pg.QueryResult | pg.QueryResult[]): pg.QueryResult {
  if (!Array.isArray(r)) return r;
  if (r.length === 0) return { rows: [], fields: [], rowCount: 0, command: '', oid: 0 } as unknown as pg.QueryResult;
  return r[r.length - 1];
}
