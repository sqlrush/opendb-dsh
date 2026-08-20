import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createPool, runMigrations, rollbackAndRelease } from '@opendb-dsh/session-persistence-pg';

export interface KnowledgeDoc { id: string; agentId?: string; title: string; source?: string; chunks: number; createdAt: Date }
export interface KnowledgeHit { docId: string; title: string; source?: string; seq: number; content: string; distance?: number }

declare module '@deepseek-ai/cordis' {
  interface Context { opendbKnowledge: KnowledgeService }
}

function docRow(r: any): KnowledgeDoc {
  return { id: r.id, agentId: r.agent_id ?? undefined, title: r.title, source: r.source ?? undefined, chunks: r.chunks, createdAt: r.created_at };
}

function toVectorLiteral(vec: number[]): string {
  return `[${vec.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]`;
}

/**
 * 把长文本切块（P2 W3 MVP：按段落聚合到 ~targetLen，超长段落硬切；overlap 承接上下文）。
 * 纯函数便于单测。
 */
export function chunkText(text: string, targetLen = 800, overlap = 100): string[] {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p !== '');
  const chunks: string[] = [];
  let buf = '';
  const flush = () => { if (buf.trim() !== '') { chunks.push(buf.trim()); buf = ''; } };
  for (const p of paragraphs) {
    if (p.length > targetLen * 1.5) {
      flush();
      for (let i = 0; i < p.length; i += targetLen - overlap) chunks.push(p.slice(i, i + targetLen));
      continue;
    }
    if (buf.length + p.length + 2 > targetLen) {
      const tail = buf.slice(-overlap);
      flush();
      buf = tail !== '' ? `${tail}\n\n${p}` : p;
    } else {
      buf = buf === '' ? p : `${buf}\n\n${p}`;
    }
  }
  flush();
  return chunks;
}

/**
 * ctx.opendbKnowledge — 知识库（P2 W3）：文档切块 + pgvector 语义检索。与记忆同构不同域——
 * 知识=外部资料（手册/SOP/架构文档），记忆=平台自身经历。agent_id 空 = 全局知识。
 * source 幂等：同源重灌 = 替换旧文档（事务内删旧插新）。
 */
export default class KnowledgeService extends Service {
  static inject = ['opendbEmbeddings'];
  static Config = z.object({
    connectionString: z.string().required(),
    defaultTenant: z.string().default('default'),
    maxDocBytes: z.number().step(1).min(1024).default(512 * 1024),
  });

  readonly pool: pg.Pool;
  private readonly ready: Promise<void>;
  private readonly tenant: string;
  private readonly embeddings: any;
  private readonly maxDocBytes: number;

  constructor(ctx: Context, config: { connectionString: string; defaultTenant?: string; maxDocBytes?: number }) {
    super(ctx, 'opendbKnowledge');
    this.pool = createPool(config.connectionString);
    this.tenant = config.defaultTenant ?? 'default';
    this.embeddings = (ctx as any).opendbEmbeddings;
    this.maxDocBytes = config.maxDocBytes ?? 512 * 1024;
    this.ready = runMigrations(this.pool);
    this.ready.catch(() => { /* surfaced on first call */ });
    ctx.effect(() => async () => { await this.ready.catch(() => {}); await this.pool.end(); }, 'opendbKnowledge.pool');
  }

  /** 灌入一篇文档：切块 → 尽力批量 embed（失败落 NULL，检索回退 ILIKE）→ 事务替换同源旧版。 */
  async ingest(input: { agentId?: string; title: string; source?: string; text: string }): Promise<KnowledgeDoc> {
    await this.ready;
    const text = input.text.slice(0, this.maxDocBytes);
    const pieces = chunkText(text);
    if (pieces.length === 0) throw new Error('文档内容为空');
    let vectors: (string | null)[] = pieces.map(() => null);
    if (this.embeddings.available === true) {
      try {
        const embedded: number[][] = await this.embeddings.embed(pieces);
        vectors = embedded.map((v) => toVectorLiteral(v));
      } catch (cause) {
        process.stderr.write(`[knowledge] embed 失败（文档仍以纯文本落库）：${String((cause as Error).message ?? cause)}\n`);
      }
    }
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      if (input.source !== undefined && input.source !== '') {
        await c.query(
          `DELETE FROM opendb_knowledge_docs WHERE tenant_id = $1 AND coalesce(agent_id, '') = coalesce($2, '') AND source = $3`,
          [this.tenant, input.agentId ?? null, input.source],
        );
      }
      const docId = `doc-${randomUUID().slice(0, 8)}`;
      const doc = await c.query(
        `INSERT INTO opendb_knowledge_docs (id, tenant_id, agent_id, title, source, chunks)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [docId, this.tenant, input.agentId ?? null, input.title.slice(0, 200), input.source ?? null, pieces.length],
      );
      for (let i = 0; i < pieces.length; i += 1) {
        await c.query(
          `INSERT INTO opendb_knowledge_chunks (id, doc_id, seq, content, embedding) VALUES ($1,$2,$3,$4,$5)`,
          [`chk-${randomUUID().slice(0, 12)}`, docId, i, pieces[i], vectors[i]],
        );
      }
      await c.query('COMMIT');
      c.release();
      return docRow(doc.rows[0]);
    } catch (cause) {
      await rollbackAndRelease(c);
      throw cause;
    }
  }

  /** 语义检索（agent 私有 + 全局知识合并）；向量不可用回退 ILIKE。 */
  async search(input: { agentId?: string; query: string; topK?: number }): Promise<KnowledgeHit[]> {
    await this.ready;
    const topK = Math.min(input.topK ?? 5, 20);
    const scope = `d.tenant_id = $1 AND (d.agent_id IS NULL${input.agentId !== undefined ? ' OR d.agent_id = $4' : ''})`;
    if (this.embeddings.available === true) {
      try {
        const [vec] = await this.embeddings.embed([input.query]);
        // P3 knowledge-vector：Qdrant 加速层优先（ctx.get 安全读可选服务；未装/未就绪/出错都回退 pgvector）
        const vs = (this.ctx as any).get?.('opendbVectorSearch');
        if (vs?.ready === true) {
          try {
            const hits: { chunkId: string; score: number }[] = await vs.search(vec, topK, input.agentId);
            if (hits.length > 0) {
              const r = await this.pool.query(
                `SELECT c.id, c.doc_id, d.title, d.source, c.seq, c.content
                 FROM opendb_knowledge_chunks c JOIN opendb_knowledge_docs d ON d.id = c.doc_id
                 WHERE c.id = ANY($1)`, [hits.map((h) => h.chunkId)]);
              const byId = new Map(r.rows.map((row) => [row.id, row]));
              return hits
                .map((h) => ({ row: byId.get(h.chunkId), score: h.score }))
                .filter((x) => x.row !== undefined)
                .map((x) => ({
                  docId: x.row.doc_id, title: x.row.title, source: x.row.source ?? undefined,
                  seq: x.row.seq, content: x.row.content, distance: 1 - x.score,
                }));
            }
          } catch (cause) {
            process.stderr.write(`[knowledge] qdrant 检索失败，回退 pgvector：${String((cause as Error).message ?? cause)}\n`);
          }
        }
        const vals: unknown[] = [this.tenant, toVectorLiteral(vec), topK];
        if (input.agentId !== undefined) vals.push(input.agentId);
        const r = await this.pool.query(
          `SELECT c.doc_id, d.title, d.source, c.seq, c.content, c.embedding <=> $2::vector AS distance
           FROM opendb_knowledge_chunks c JOIN opendb_knowledge_docs d ON d.id = c.doc_id
           WHERE ${scope} AND c.embedding IS NOT NULL
           ORDER BY c.embedding <=> $2::vector LIMIT $3`,
          vals,
        );
        if (r.rows.length > 0) {
          return r.rows.map((row) => ({ docId: row.doc_id, title: row.title, source: row.source ?? undefined, seq: row.seq, content: row.content, distance: Number(row.distance) }));
        }
      } catch (cause) {
        process.stderr.write(`[knowledge] 向量检索失败，回退关键词：${String((cause as Error).message ?? cause)}\n`);
      }
    }
    const vals: unknown[] = [this.tenant, `%${input.query.slice(0, 100)}%`, topK];
    if (input.agentId !== undefined) vals.push(input.agentId);
    const r = await this.pool.query(
      `SELECT c.doc_id, d.title, d.source, c.seq, c.content
       FROM opendb_knowledge_chunks c JOIN opendb_knowledge_docs d ON d.id = c.doc_id
       WHERE ${scope} AND c.content ILIKE $2 ORDER BY d.created_at DESC, c.seq LIMIT $3`,
      vals,
    );
    return r.rows.map((row) => ({ docId: row.doc_id, title: row.title, source: row.source ?? undefined, seq: row.seq, content: row.content }));
  }

  async listDocs(input: { agentId?: string; limit?: number } = {}): Promise<KnowledgeDoc[]> {
    await this.ready;
    const vals: unknown[] = [this.tenant, Math.min(input.limit ?? 100, 500)];
    const cond = input.agentId !== undefined ? ` AND (agent_id IS NULL OR agent_id = $3)` : '';
    if (input.agentId !== undefined) vals.push(input.agentId);
    const r = await this.pool.query(
      `SELECT * FROM opendb_knowledge_docs WHERE tenant_id = $1${cond} ORDER BY created_at DESC LIMIT $2`, vals);
    return r.rows.map(docRow);
  }

  async removeDoc(id: string): Promise<void> {
    await this.ready;
    await this.pool.query('DELETE FROM opendb_knowledge_docs WHERE id = $1', [id]);   // chunks ON DELETE CASCADE
  }
}
export { KnowledgeService };
