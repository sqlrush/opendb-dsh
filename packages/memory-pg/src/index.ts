import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';

export type MemoryKind = 'episodic' | 'fact' | 'preference' | 'report';
export interface MemoryRecord {
  id: string; agentId: string; kind: MemoryKind; content: string;
  source?: string; createdAt: Date; distance?: number;
}

declare module '@deepseek-ai/cordis' {
  interface Context { opendbMemory: MemoryService }
}

function row(r: any): MemoryRecord {
  return {
    id: r.id, agentId: r.agent_id, kind: r.kind, content: r.content,
    source: r.source ?? undefined, createdAt: r.created_at,
    distance: r.distance !== undefined && r.distance !== null ? Number(r.distance) : undefined,
  };
}

/** pgvector literal: '[0.1,0.2,...]' (values clamped to finite numbers upstream). */
export function toVectorLiteral(vec: readonly number[]): string {
  return `[${vec.join(',')}]`;
}

/**
 * ctx.opendbMemory — agent 记忆（设计 §8.3 MVP）：PG 为真相，pgvector 语义检索。
 * 写入时尽力 embed（失败落 NULL，不阻塞）；检索优先向量余弦，embedding 缺失或
 * embeddings 服务不可用时回退 ILIKE 关键词。source 唯一约束支撑报告入库幂等。
 */
export default class MemoryService extends Service {
  static inject = ['opendbEmbeddings'];
  static Config = z.object({
    connectionString: z.string().required(),
    defaultTenant: z.string().default('default'),
    maxContentBytes: z.number().step(1).min(256).default(8192),
  });

  readonly pool: pg.Pool;
  private readonly ready: Promise<void>;
  private readonly tenant: string;
  private readonly embeddings: any;
  private readonly maxContentBytes: number;

  constructor(ctx: Context, config: { connectionString: string; defaultTenant?: string; maxContentBytes?: number }) {
    super(ctx, 'opendbMemory');
    this.pool = createPool(config.connectionString);
    this.tenant = config.defaultTenant ?? 'default';
    this.embeddings = (ctx as any).opendbEmbeddings;
    this.maxContentBytes = config.maxContentBytes ?? 8192;
    this.ready = runMigrations(this.pool);
    this.ready.catch(() => { /* surfaced on first call */ });
    ctx.effect(() => async () => { await this.ready.catch(() => {}); await this.pool.end(); }, 'opendbMemory.pool');
  }

  /** Write one memory; embed best-effort; source-idempotent (existing source row is updated). */
  async write(input: { agentId: string; kind: MemoryKind; content: string; source?: string }): Promise<MemoryRecord> {
    await this.ready;
    let content = input.content.trim();
    if (Buffer.byteLength(content, 'utf8') > this.maxContentBytes) {
      content = Buffer.from(content, 'utf8').subarray(0, this.maxContentBytes).toString('utf8');
    }
    if (content === '') throw new Error('记忆内容不能为空');
    let embedding: string | null = null;
    if (this.embeddings.available === true) {
      try {
        const [vec] = await this.embeddings.embed([content]);
        embedding = toVectorLiteral(vec);
      } catch (cause) {
        process.stderr.write(`[memory] embed 失败（记忆仍以纯文本落库）：${String((cause as Error).message ?? cause)}\n`);
      }
    }
    const r = await this.pool.query(
      `INSERT INTO opendb_memories (id, tenant_id, agent_id, kind, content, source, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (agent_id, source) WHERE source IS NOT NULL
       DO UPDATE SET content = EXCLUDED.content, kind = EXCLUDED.kind, embedding = EXCLUDED.embedding, created_at = now()
       RETURNING *`,
      [`mem-${randomUUID().slice(0, 8)}`, this.tenant, input.agentId, input.kind, content, input.source ?? null, embedding],
    );
    return row(r.rows[0]);
  }

  /** Semantic search (cosine) with ILIKE keyword fallback. */
  async search(input: { agentId: string; query: string; topK?: number; kind?: MemoryKind }): Promise<MemoryRecord[]> {
    await this.ready;
    const topK = Math.min(input.topK ?? 5, 20);
    const kindCond = input.kind !== undefined ? ' AND kind = $4' : '';
    if (this.embeddings.available === true) {
      try {
        const [vec] = await this.embeddings.embed([input.query]);
        const vals: unknown[] = [input.agentId, toVectorLiteral(vec), topK];
        if (input.kind !== undefined) vals.push(input.kind);
        const r = await this.pool.query(
          `SELECT *, embedding <=> $2::vector AS distance FROM opendb_memories
           WHERE agent_id = $1 AND embedding IS NOT NULL${kindCond}
           ORDER BY embedding <=> $2::vector LIMIT $3`,
          vals,
        );
        if (r.rows.length > 0) return r.rows.map(row);
      } catch (cause) {
        process.stderr.write(`[memory] 向量检索失败，回退关键词：${String((cause as Error).message ?? cause)}\n`);
      }
    }
    const vals: unknown[] = [input.agentId, `%${input.query.slice(0, 100)}%`, topK];
    if (input.kind !== undefined) vals.push(input.kind);
    const r = await this.pool.query(
      `SELECT * FROM opendb_memories WHERE agent_id = $1 AND content ILIKE $2${kindCond}
       ORDER BY created_at DESC LIMIT $3`,
      vals,
    );
    return r.rows.map(row);
  }

  /** Most recent memories for an agent (context injection). */
  async recent(input: { agentId: string; limit?: number; kind?: MemoryKind }): Promise<MemoryRecord[]> {
    await this.ready;
    const limit = Math.min(input.limit ?? 5, 50);
    const vals: unknown[] = [input.agentId, limit];
    const kindCond = input.kind !== undefined ? ' AND kind = $3' : '';
    if (input.kind !== undefined) vals.push(input.kind);
    const r = await this.pool.query(
      `SELECT * FROM opendb_memories WHERE agent_id = $1${kindCond} ORDER BY created_at DESC LIMIT $2`,
      vals,
    );
    return r.rows.map(row);
  }

  /** P2 W3 additive：管理页列表（跨 agent，可按 agent/kind 过滤）。 */
  async list(input: { agentId?: string; kind?: MemoryKind; limit?: number } = {}): Promise<MemoryRecord[]> {
    await this.ready;
    const conds: string[] = ['tenant_id = $1'];
    const vals: unknown[] = [this.tenant];
    if (input.agentId !== undefined) { vals.push(input.agentId); conds.push(`agent_id = $${vals.length}`); }
    if (input.kind !== undefined) { vals.push(input.kind); conds.push(`kind = $${vals.length}`); }
    vals.push(Math.min(input.limit ?? 200, 1000));
    const r = await this.pool.query(
      `SELECT * FROM opendb_memories WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT $${vals.length}`, vals);
    return r.rows.map(row);
  }

  /** P2 W3 additive：管理页删除（记忆修剪是人类监督动作）。 */
  async remove(id: string): Promise<void> {
    await this.ready;
    await this.pool.query('DELETE FROM opendb_memories WHERE id = $1', [id]);
  }

  /** Whether a memory with this source already exists (ingest idempotence check). */
  async hasSource(agentId: string, source: string): Promise<boolean> {
    await this.ready;
    const r = await this.pool.query('SELECT 1 FROM opendb_memories WHERE agent_id = $1 AND source = $2 LIMIT 1', [agentId, source]);
    return r.rows.length > 0;
  }
}
export { MemoryService };
