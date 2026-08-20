import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { createPool } from '@opendb-dsh/session-persistence-pg';

declare module '@deepseek-ai/cordis' {
  interface Context { opendbVectorSearch: KnowledgeVectorService }
}

const COLLECTION = 'opendb_knowledge';

/** Qdrant point id 要求 UUID/uint64——chunk id 经 md5 变形成 UUID 字面量（稳定映射）。 */
export function chunkPointId(chunkId: string): string {
  const h = createHash('md5').update(chunkId).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * ctx.opendbVectorSearch — 知识向量检索加速层（P3 knowledge-vector；G3 复议后 user 拍板落地）：
 * PG opendb_knowledge_chunks 仍是唯一真相；本服务水位增量同步向量到 Qdrant，
 * 检索时 knowledge-pg 优先调这里（ready 才用），任何故障回退 pgvector——正确性零风险。
 * 同步含删除对账：周期比对 chunk id 集合，Qdrant 侧多出的点删除（文档重灌/删除场景）。
 */
export default class KnowledgeVectorService extends Service {
  static Config = z.object({
    connectionString: z.string().required(),
    qdrantUrl: z.string().default(''),
    syncMs: z.number().default(60_000),
  });

  private readonly pool: pg.Pool;
  private readonly base: string;
  ready = false;

  constructor(ctx: Context, config: { connectionString: string; qdrantUrl?: string; syncMs?: number }) {
    super(ctx, 'opendbVectorSearch');
    this.pool = createPool(config.connectionString);
    this.base = (config.qdrantUrl ?? '').replace(/\/$/, '');
    const syncMs = config.syncMs ?? 60_000;

    let timer: NodeJS.Timeout | undefined;
    ctx.effect(() => {
      const loop = async () => {
        try { await this.sync(); } catch (cause) {
          this.ready = false;
          process.stderr.write(`[knowledge-vector] sync failed: ${String((cause as Error).message ?? cause)}\n`);
        }
        timer = setTimeout(loop, syncMs);
      };
      if (this.base !== '') void loop();
      return () => {
        if (timer !== undefined) clearTimeout(timer);
        void this.pool.end();
      };
    }, 'knowledge-vector.sync');
  }

  private async q(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok && res.status !== 404) throw new Error(`qdrant ${method} ${path} → ${res.status}`);
    return res.json().catch(() => ({}));
  }

  /** 全量对账同步：PG chunk（embedding 非空）↔ Qdrant point。量级百千级，全量 diff 简单可靠。 */
  private async sync(): Promise<void> {
    await this.q('PUT', `/collections/${COLLECTION}`, { vectors: { size: 1024, distance: 'Cosine' } }).catch(() => { /* exists */ });
    const rows = await this.pool.query(
      `SELECT c.id, c.doc_id, c.embedding::text AS vec, d.agent_id
       FROM opendb_knowledge_chunks c JOIN opendb_knowledge_docs d ON d.id = c.doc_id
       WHERE c.embedding IS NOT NULL`);
    const pgIds = new Set(rows.rows.map((r) => chunkPointId(r.id)));
    // 上行：upsert 全部（幂等；百级量直接批推）
    if (rows.rowCount! > 0) {
      const points = rows.rows.map((r) => ({
        id: chunkPointId(r.id),
        vector: JSON.parse(r.vec),
        payload: { chunk_id: r.id, doc_id: r.doc_id, agent_id: r.agent_id ?? null },
      }));
      for (let i = 0; i < points.length; i += 100) {
        await this.q('PUT', `/collections/${COLLECTION}/points?wait=true`, { points: points.slice(i, i + 100) });
      }
    }
    // 下行删除对账：Qdrant 里 PG 已没有的点清掉
    const scroll = await this.q('POST', `/collections/${COLLECTION}/points/scroll`, { limit: 10000, with_payload: false, with_vector: false });
    const stale = (scroll.result?.points ?? []).map((p: any) => String(p.id)).filter((id: string) => !pgIds.has(id));
    if (stale.length > 0) {
      await this.q('POST', `/collections/${COLLECTION}/points/delete?wait=true`, { points: stale });
    }
    this.ready = true;
  }

  /** 向量检索：返回 chunk_id + score（内容由调用方回 PG 取——真相只有一份）。 */
  async search(vector: number[], topK: number, agentId?: string): Promise<{ chunkId: string; score: number }[]> {
    if (!this.ready) throw new Error('knowledge-vector not ready');
    const filter = {
      should: [
        { is_null: { key: 'agent_id' } },
        ...(agentId !== undefined ? [{ match: { key: 'agent_id', value: agentId } } as any] : []),
      ],
    };
    const r = await this.q('POST', `/collections/${COLLECTION}/points/search`, {
      vector, limit: topK, filter, with_payload: true,
    });
    return (r.result ?? []).map((hit: any) => ({ chunkId: String(hit.payload?.chunk_id ?? ''), score: Number(hit.score) }));
  }
}

export { KnowledgeVectorService };
