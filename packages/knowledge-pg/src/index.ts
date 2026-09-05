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

/** 向量补齐任务的 leader advisory-lock key（host+runtime 都装本服务，只一个实例真正跑补齐）。 */
const KB_BACKFILL_LOCK = 7_204_211_034;

/** kg_query 起点模糊匹配：打分下限、起点上限、参与打分的节点上限（2026-09-05 演示实测短词「核心库锁等待」查不到长实体后加）。 */
const KG_SEED_MIN_SCORE = 0.45;
const KG_SEED_LIMIT = 6;
const KG_SEED_SCAN_LIMIT = 5000;
const KG_BIGRAM_CAP = 0.85;
/** knowledge_search 命中段附带的相邻段上限（防长文档把上下文撑爆；工具侧另有 18000 字截断）。 */
const KB_NEIGHBOR_MAX = 6;

/** 实体名归一：小写、去空白与标点，让「P1 事故」「p1事故」「BATCH_EOD_*」这类写法差异不影响匹配。 */
function normalizeEntity(s: string): string {
  return s.toLowerCase().replace(/[\s\/·()（）_\-+*,.，。、:：;；「」【】[\]"'“”]/g, '');
}

function bigrams(s: string): Set<string> {
  return new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
}

/**
 * 起点实体打分（纯函数便于单测）：精确 1.0 → 任一方向包含 0.9 → 查询词的字二元组被实体名覆盖的比例（封顶 0.85）。
 * 用字二元组而不用 pg_trgm：trigram 在本库 locale 下对中文打分为 0（实测），二元组不依赖扩展与 locale。
 */
export function entityMatchScore(query: string, name: string): number {
  const q = normalizeEntity(query);
  const n = normalizeEntity(name);
  if (q === '' || n === '') return 0;
  if (q === n) return 1;
  if (n.includes(q) || q.includes(n)) return 0.9;
  const qb = bigrams(q);
  if (qb.size === 0) return 0;
  const nb = bigrams(n);
  const shared = [...qb].filter((b) => nb.has(b)).length;
  return (shared / qb.size) * KG_BIGRAM_CAP;
}

export interface KgHop { src: string; rel: string; dst: string; source: string }
export interface KgQueryResult { paths: { hops: KgHop[] }[]; nodes: number; matched: { name: string; score: number }[] }
/** 会话导入确认时按编号改候选边（用户说"第 15 条改名为核心库锁等待"）；只填要改的字段。 */
export interface StagingEdit { number: number; src?: string; rel?: string; dst?: string }

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

  private backfillClient: pg.PoolClient | undefined;

  constructor(ctx: Context, config: { connectionString: string; defaultTenant?: string; maxDocBytes?: number }) {
    super(ctx, 'opendbKnowledge');
    this.pool = createPool(config.connectionString);
    this.tenant = config.defaultTenant ?? 'default';
    this.embeddings = (ctx as any).opendbEmbeddings;
    this.maxDocBytes = config.maxDocBytes ?? 512 * 1024;
    this.ready = runMigrations(this.pool);
    this.ready.catch(() => { /* surfaced on first call */ });
    ctx.effect(() => async () => { await this.ready.catch(() => {}); await this.pool.end(); }, 'opendbKnowledge.pool');

    // 向量补齐后台任务（P3，2026-09-02）：ingest 时 embed 失败会落 NULL 且无补齐 → 检索永久退化成 ILIKE
    // （og5 实测 6/7 切块缺向量）。这里周期性扫 NULL 补齐。host+runtime 都装本服务，用 advisory lock 选主，只一个实例跑。
    // bge-m3 在 CPU 上 5-6s/次，每轮只补一小批，别拖垮嵌入服务。
    if (this.embeddings?.available === true) {
      const timer = setInterval(() => { void this.backfillEmbeddings(8).catch(() => {}); }, 45_000);
      ctx.effect(() => () => { clearInterval(timer); if (this.backfillClient !== undefined) { try { this.backfillClient.release(); } catch { /* closing */ } } }, 'opendbKnowledge.backfill');
    }
  }

  private async backfillLeader(): Promise<boolean> {
    if (this.backfillClient !== undefined) {
      try { await this.backfillClient.query('SELECT 1'); return true; }
      catch { try { this.backfillClient.release(true as any); } catch { /* gone */ } this.backfillClient = undefined; }
    }
    const c = await this.pool.connect();
    try {
      const r = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [KB_BACKFILL_LOCK]);
      if (r.rows[0].ok === true) { this.backfillClient = c; return true; }
      c.release(); return false;
    } catch (cause) { c.release(true as any); throw cause; }
  }

  /**
   * 补齐缺失向量：扫 opendb_knowledge_chunks 与 opendb_memories 里 embedding IS NULL 的行，批量 embed 后 UPDATE。
   * 返回本轮补齐条数（大盘"向量缺失"会随之下降）。只在持有 leader 锁的实例上真正执行。
   */
  async backfillEmbeddings(limit = 8): Promise<{ chunks: number; memories: number }> {
    await this.ready;
    if (this.embeddings?.available !== true) return { chunks: 0, memories: 0 };
    if (!(await this.backfillLeader())) return { chunks: 0, memories: 0 };
    const out = { chunks: 0, memories: 0 };
    for (const tbl of ['opendb_knowledge_chunks', 'opendb_memories'] as const) {
      const rows = (await this.pool.query(
        `SELECT id, content FROM ${tbl} WHERE embedding IS NULL AND content <> '' ORDER BY id LIMIT $1`, [limit],
      )).rows as { id: string; content: string }[];
      if (rows.length === 0) continue;
      let vecs: number[][];
      try { vecs = await this.embeddings.embed(rows.map((r) => r.content)); }
      catch { continue; }   // 嵌入服务临时不可用：下一轮再试，不阻塞
      for (let i = 0; i < rows.length; i += 1) {
        if (vecs[i] === undefined) continue;
        await this.pool.query(`UPDATE ${tbl} SET embedding = $1::vector WHERE id = $2`, [toVectorLiteral(vecs[i]), rows[i].id]);
        if (tbl === 'opendb_knowledge_chunks') out.chunks += 1; else out.memories += 1;
      }
    }
    return out;
  }

  /** 灌入一篇文档：切块 → 尽力批量 embed（失败落 NULL，检索回退 ILIKE）→ 事务替换同源旧版。 */
  async ingest(input: { agentId?: string; title: string; source?: string; text: string; materialKind?: string; engine?: string; env?: string }): Promise<KnowledgeDoc> {
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
        `INSERT INTO opendb_knowledge_docs (id, tenant_id, agent_id, title, source, chunks, material_kind, engine, env)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [docId, this.tenant, input.agentId ?? null, input.title.slice(0, 200), input.source ?? null, pieces.length,
          input.materialKind ?? null, input.engine ?? null, input.env ?? null],
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

  /** 关键词命中（ILIKE）：补向量召不回的精确 token（错误码 / 对象名 / 条款号）。 */
  private async keywordHits(query: string, topK: number, agentId?: string): Promise<KnowledgeHit[]> {
    const scope = `d.tenant_id = $1 AND (d.agent_id IS NULL${agentId !== undefined ? ' OR d.agent_id = $4' : ''})`;
    const vals: unknown[] = [this.tenant, `%${query.slice(0, 100)}%`, topK];
    if (agentId !== undefined) vals.push(agentId);
    const r = await this.pool.query(
      `SELECT c.doc_id, d.title, d.source, c.seq, c.content
       FROM opendb_knowledge_chunks c JOIN opendb_knowledge_docs d ON d.id = c.doc_id
       WHERE ${scope} AND c.content ILIKE $2 ORDER BY d.created_at DESC, c.seq LIMIT $3`, vals);
    return r.rows.map((row) => ({ docId: row.doc_id, title: row.title, source: row.source ?? undefined, seq: row.seq, content: row.content }));
  }

  /**
   * 混合检索（P3）：向量语义召回 + 关键词精确命中，合并去重。
   * 向量给"意思相近"（说法不同也能召回），关键词补"精确 token"（ORA-01555、core_acct、条款号这类纯向量易漏的）。
   * 向量不可用时退化为纯关键词。合并顺序：向量命中在前，关键词独有的补在后，按 topK 截断。
   */
  /**
   * 命中段的相邻段（同文档 seq±1）：规范常被切块切在条款/表格中间——2026-09-05 用户实测只命中第 2 段，
   * 模型把「BATCH_EOD 绝对不能杀」误读成「三板斧后可杀」。带上相邻段后小文档等于整篇带上，条款不再被切断。
   */
  private async neighborChunks(hits: KnowledgeHit[]): Promise<KnowledgeHit[]> {
    if (hits.length === 0) return [];
    const docIds = [...new Set(hits.map((h) => h.docId))];
    const r = await this.pool.query(
      `SELECT c.doc_id, d.title, d.source, c.seq, c.content
         FROM opendb_knowledge_chunks c JOIN opendb_knowledge_docs d ON d.id = c.doc_id
        WHERE c.doc_id = ANY($1) ORDER BY c.doc_id, c.seq`, [docIds]);
    const have = new Set(hits.map((h) => `${h.docId}:${h.seq}`));
    const wanted = new Set(hits.flatMap((h) => [`${h.docId}:${h.seq - 1}`, `${h.docId}:${h.seq + 1}`]));
    return r.rows
      .filter((row) => { const k = `${row.doc_id}:${row.seq}`; return wanted.has(k) && !have.has(k); })
      .map((row) => ({ docId: row.doc_id, title: row.title, source: row.source ?? undefined, seq: row.seq, content: row.content }))
      .slice(0, KB_NEIGHBOR_MAX);
  }

  async search(input: { agentId?: string; query: string; topK?: number }): Promise<KnowledgeHit[]> {
    await this.ready;
    const topK = Math.min(input.topK ?? 5, 20);
    const scope = `d.tenant_id = $1 AND (d.agent_id IS NULL${input.agentId !== undefined ? ' OR d.agent_id = $4' : ''})`;
    const vecHits: KnowledgeHit[] = [];
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
              vecHits.push(...hits
                .map((h) => ({ row: byId.get(h.chunkId), score: h.score }))
                .filter((x) => x.row !== undefined)
                .map((x) => ({
                  docId: x.row.doc_id, title: x.row.title, source: x.row.source ?? undefined,
                  seq: x.row.seq, content: x.row.content, distance: 1 - x.score,
                })));
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
        if (vecHits.length === 0 && r.rows.length > 0) {
          vecHits.push(...r.rows.map((row) => ({ docId: row.doc_id, title: row.title, source: row.source ?? undefined, seq: row.seq, content: row.content, distance: Number(row.distance) })));
        }
      } catch (cause) {
        process.stderr.write(`[knowledge] 向量检索失败，回退关键词：${String((cause as Error).message ?? cause)}\n`);
      }
    }
    // 混合合并：向量命中在前，关键词独有的补在后（去重 key = doc_id:seq）
    const kw = await this.keywordHits(input.query, topK, input.agentId).catch(() => [] as KnowledgeHit[]);
    const seen = new Set(vecHits.map((h) => `${h.docId}:${h.seq}`));
    const merged = [...vecHits];
    for (const h of kw) { const k = `${h.docId}:${h.seq}`; if (!seen.has(k)) { seen.add(k); merged.push(h); } }
    // 命中段之后附带同文档相邻段（相关度排序不变，只是补全被切断的条款上下文）
    const primary = merged.slice(0, topK);
    const neighbors = await this.neighborChunks(primary).catch(() => [] as KnowledgeHit[]);
    return [...primary, ...neighbors];
  }

  /**
   * kg_query 的起点匹配（2026-09-05 演示实测：短词「核心库锁等待」查不到导入时模型起名的长实体
   * 「核心账务库在线锁等待/阻塞事件」）：全量节点在应用侧按 entityMatchScore 三档打分，低于下限不算起点。
   * 节点到十万级再改成 SQL 侧预筛（首字/二元组倒排）。
   */
  private async kgSeeds(q: string): Promise<{ id: string; name: string; score: number }[]> {
    const r = await this.pool.query(`SELECT id, name FROM opendb_kg_nodes WHERE tenant_id = $1 LIMIT $2`, [this.tenant, KG_SEED_SCAN_LIMIT]);
    return r.rows
      .map((row) => ({ id: String(row.id), name: String(row.name), score: entityMatchScore(q, String(row.name)) }))
      .filter((s) => s.score >= KG_SEED_MIN_SCORE)
      .sort((a, b) => b.score - a.score || a.name.length - b.name.length)
      .slice(0, KG_SEED_LIMIT);
  }

  /**
   * 强类型知识图谱查询（P3）：从匹配到的起点实体出发做多跳（默认 2 跳），沿 confidence=1.0 且在生效期内的边，
   * 返回可追溯路径。这是"客户专属关系"的确定性推理入口——现象→根因→处置、对象→约束条款 这类。
   * 起点第一跳同时取入边与出边（"什么约束 X"和"X 处置为什么"都要能查），之后只沿出边走；
   * matched 回显起点实体，让模型知道实际按什么在查。
   */
  async kgQuery(entity: string, maxHops = 2): Promise<KgQueryResult> {
    await this.ready;
    const hops = Math.max(1, Math.min(maxHops, 4));
    const q = entity.trim();
    const seeds = q === '' ? [] : await this.kgSeeds(q);
    if (seeds.length === 0) return { paths: [], nodes: 0, matched: [] };
    const r = await this.pool.query(
      `WITH RECURSIVE walk(src_id, dst_id, rel_type, src_name, dst_name, source_locator, depth, path) AS (
         SELECT e.src_id, e.dst_id, e.rel_type, sn.name, dn.name, e.source_locator, 1, ARRAY[e.src_id, e.dst_id]
           FROM opendb_kg_edges e
           JOIN opendb_kg_nodes sn ON sn.id = e.src_id
           JOIN opendb_kg_nodes dn ON dn.id = e.dst_id
          WHERE e.tenant_id = $1 AND e.confidence >= 1.0
            AND now() BETWEEN coalesce(e.valid_from, '-infinity') AND coalesce(e.valid_to, 'infinity')
            AND (e.src_id = ANY($2::text[]) OR e.dst_id = ANY($2::text[]))
         UNION ALL
         SELECT e.src_id, e.dst_id, e.rel_type, sn.name, dn.name, e.source_locator, w.depth + 1, w.path || e.dst_id
           FROM walk w
           JOIN opendb_kg_edges e ON e.src_id = w.dst_id AND e.tenant_id = $1 AND e.confidence >= 1.0
           JOIN opendb_kg_nodes sn ON sn.id = e.src_id
           JOIN opendb_kg_nodes dn ON dn.id = e.dst_id
          WHERE w.depth < $3 AND NOT e.dst_id = ANY(w.path))
       SELECT DISTINCT ON (src_id, dst_id, rel_type) src_name, rel_type, dst_name, source_locator, depth
         FROM walk ORDER BY src_id, dst_id, rel_type, depth LIMIT 100`,
      [this.tenant, seeds.map((s) => s.id), hops]);
    // 简化：把每条边当一条单跳路径返回（多跳链前端/模型可自行串联），按跳数排序；nodes = 涉及实体数
    const rows = [...r.rows].sort((a, b) => Number(a.depth) - Number(b.depth));
    const paths = rows.map((row) => ({ hops: [{ src: String(row.src_name), rel: String(row.rel_type), dst: String(row.dst_name), source: String(row.source_locator ?? '') }] }));
    const nodes = new Set(rows.flatMap((row) => [String(row.src_name), String(row.dst_name)])).size;
    return { paths, nodes, matched: seeds.map((s) => ({ name: s.name, score: s.score })) };
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

  // ── 导入工具（P2）：模型提议 → staging → 人审 → commit 进强类型图 ──────────────
  /** 建导入批次：先跑向量线（确定性 ingest），再登记图候选边到 staging（人审前不进图）。 */
  async createImport(input: {
    filename?: string; materialKind?: string; engine?: string; env?: string;
    title: string; source?: string; text: string; sessionId?: string;
    edges?: { src: string; rel: string; dst: string; srcKind?: string; dstKind?: string; locator?: string; confidence?: number }[];
  }): Promise<{ importId: string; vectorChunks: number; edgeCandidates: number }> {
    await this.ready;
    const doc = await this.ingest({ title: input.title, source: input.source, text: input.text, materialKind: input.materialKind, engine: input.engine, env: input.env });
    const importId = `imp-${randomUUID().slice(0, 8)}`;
    const edges = input.edges ?? [];
    await this.pool.query(
      `INSERT INTO opendb_kb_imports (id, tenant_id, filename, material_kind, engine, env, status, vector_chunks, edge_candidates, session_id)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9)`,
      [importId, this.tenant, input.filename ?? input.title, input.materialKind ?? null, input.engine ?? null, input.env ?? null, doc.chunks, edges.length, input.sessionId ?? null],
    );
    for (const e of edges) {
      await this.pool.query(
        `INSERT INTO opendb_kb_edge_staging (id, import_id, src_name, rel_type, dst_name, src_kind, dst_kind, source_locator, confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [`stg-${randomUUID().slice(0, 10)}`, importId, String(e.src), String(e.rel), String(e.dst), e.srcKind ?? null, e.dstKind ?? null, e.locator ?? null, Number(e.confidence ?? 0.7)],
      );
    }
    return { importId, vectorChunks: doc.chunks, edgeCandidates: edges.length };
  }

  /** 往已有批次追加候选边（模型 kb_extract 用；向量线已由 createImport/imports-create 确定性完成）。 */
  async stageEdges(importId: string, edges: { src: string; rel: string; dst: string; srcKind?: string; dstKind?: string; locator?: string; confidence?: number }[]): Promise<{ added: number }> {
    await this.ready;
    const exists = await this.pool.query(`SELECT 1 FROM opendb_kb_imports WHERE id = $1`, [importId]);
    if (exists.rowCount === 0) throw new Error(`导入批次 ${importId} 不存在`);
    let added = 0;
    for (const e of edges) {
      if (!e.src || !e.rel || !e.dst) continue;
      await this.pool.query(
        `INSERT INTO opendb_kb_edge_staging (id, import_id, src_name, rel_type, dst_name, src_kind, dst_kind, source_locator, confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [`stg-${randomUUID().slice(0, 10)}`, importId, String(e.src), String(e.rel), String(e.dst), e.srcKind ?? null, e.dstKind ?? null, e.locator ?? null, Number(e.confidence ?? 0.7)]);
      added += 1;
    }
    if (added > 0) await this.pool.query(`UPDATE opendb_kb_imports SET edge_candidates = edge_candidates + $2 WHERE id = $1`, [importId, added]);
    return { added };
  }

  /** 按插入顺序取某批次的候选边（会话导入用它给候选编号，供用户按编号剔除）。 */
  async stagingOrdered(importId: string): Promise<{ id: string; src_name: string; rel_type: string; dst_name: string; confidence: number; source_locator: string | null }[]> {
    await this.ready;
    const r = await this.pool.query(
      `SELECT id, src_name, rel_type, dst_name, confidence, source_locator
         FROM opendb_kb_edge_staging WHERE import_id = $1 ORDER BY created_at, id`, [importId]);
    return r.rows;
  }

  /**
   * 会话导入的"确认入库"：把用户按编号剔除的候选标 reject，按编号改名/修正的先改再纳入，
   * 其余（= 用户确认保留的）写进强类型图。编号都是 1 基，对应 stagingOrdered 的顺序（会话里展示给用户的那个顺序）。
   */
  async commitWithReject(importId: string, rejectNumbers: number[] = [], edits: StagingEdit[] = []): Promise<{ edges: number; rejected: number; edited: number; total: number }> {
    await this.ready;
    const rows = await this.stagingOrdered(importId);
    const rej = new Set(rejectNumbers.map((n) => Math.trunc(n)));
    let rejected = 0;
    let edited = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const n = i + 1;
      if (rej.has(n)) { await this.decideStaging(rows[i].id, 'reject'); rejected += 1; continue; }
      const edit = edits.find((e) => Math.trunc(e.number) === n);
      if (edit !== undefined) { await this.decideStaging(rows[i].id, 'accept', edit); edited += 1; }
    }
    const r = await this.commitImport(importId);
    return { edges: r.edges, rejected, edited, total: rows.length };
  }

  async listImports(limit = 50): Promise<unknown[]> {
    await this.ready;
    const r = await this.pool.query(
      `SELECT i.*, (SELECT count(*) FROM opendb_kb_edge_staging s WHERE s.import_id = i.id AND s.decision = 'pending') pending
         FROM opendb_kb_imports i WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`, [this.tenant, limit]);
    return r.rows;
  }

  async listStaging(importId?: string): Promise<unknown[]> {
    await this.ready;
    const vals: unknown[] = importId !== undefined ? [importId] : [];
    const cond = importId !== undefined ? 'WHERE s.import_id = $1' : "WHERE s.decision = 'pending'";
    const r = await this.pool.query(
      `SELECT s.*, i.material_kind, i.filename FROM opendb_kb_edge_staging s JOIN opendb_kb_imports i ON i.id = s.import_id
        ${cond} ORDER BY s.confidence DESC`, vals);
    return r.rows;
  }

  /** 人审一条候选边：accept / reject（可带 edit 覆盖 src/rel/dst）。 */
  async decideStaging(id: string, decision: 'accept' | 'reject', edit?: { src?: string; rel?: string; dst?: string }): Promise<void> {
    await this.ready;
    if (edit !== undefined && (edit.src || edit.rel || edit.dst)) {
      await this.pool.query(
        `UPDATE opendb_kb_edge_staging SET decision = $2,
           src_name = coalesce($3, src_name), rel_type = coalesce($4, rel_type), dst_name = coalesce($5, dst_name)
         WHERE id = $1`, [id, decision, edit.src ?? null, edit.rel ?? null, edit.dst ?? null]);
    } else {
      await this.pool.query(`UPDATE opendb_kb_edge_staging SET decision = $2 WHERE id = $1`, [id, decision]);
    }
  }

  /** 归一取/建节点：按 canonical 唯一（同名合并）。 */
  private async upsertNode(c: pg.PoolClient, kind: string, name: string): Promise<string> {
    const canonical = name.trim().toLowerCase();
    const found = await c.query(`SELECT id FROM opendb_kg_nodes WHERE tenant_id = $1 AND canonical = $2`, [this.tenant, canonical]);
    if (found.rows[0] !== undefined) return String(found.rows[0].id);
    const id = `kgn-${randomUUID().slice(0, 10)}`;
    await c.query(`INSERT INTO opendb_kg_nodes (id, tenant_id, kind, name, canonical) VALUES ($1,$2,$3,$4,$5)`,
      [id, this.tenant, kind, name.trim(), canonical]);
    return id;
  }

  /**
   * 确认入库：把该批次所有「未否决」的候选边写进强类型图（confidence=1.0），标记批次 committed。
   * 语义：人审默认纳入、点「否决」剔除——点了「确认入库」即人工确认（human-in-the-loop），
   * 只有明确 reject 的不入图。这样审一批规范只需否决个别错的，不必逐条点采纳。
   */
  async commitImport(importId: string): Promise<{ edges: number }> {
    await this.ready;
    const accepted = (await this.pool.query(
      `SELECT * FROM opendb_kb_edge_staging WHERE import_id = $1 AND decision <> 'reject'`, [importId])).rows;
    const c = await this.pool.connect();
    let edges = 0;
    try {
      await c.query('BEGIN');
      const imp = (await c.query(`SELECT material_kind FROM opendb_kb_imports WHERE id = $1`, [importId])).rows[0];
      for (const e of accepted) {
        const src = await this.upsertNode(c, String(e.src_kind ?? 'object'), String(e.src_name));
        const dst = await this.upsertNode(c, String(e.dst_kind ?? 'object'), String(e.dst_name));
        await c.query(
          `INSERT INTO opendb_kg_edges (id, tenant_id, src_id, dst_id, rel_type, source_kind, source_id, source_locator, confidence)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1.0)`,
          [`kge-${randomUUID().slice(0, 10)}`, this.tenant, src, dst, String(e.rel_type), imp?.material_kind ?? 'import', importId, e.source_locator ?? null]);
        edges += 1;
      }
      await c.query(`UPDATE opendb_kb_imports SET status = 'committed' WHERE id = $1`, [importId]);
      await c.query('COMMIT');
      c.release();
    } catch (cause) { await rollbackAndRelease(c); throw cause; }
    return { edges };
  }

  /**
   * 知识库大盘（P1，只读聚合三库）：记忆 / 向量 / 图。共用同一 PG pool（同库），一次并发查完。
   * 只读、纯统计；任一子查询失败不拖垮整页（catch → 该块给空值，前端如实降级）。
   */
  async dashboard(): Promise<unknown> {
    await this.ready;
    const t = [this.tenant];
    const q = <T = any>(sql: string, vals: unknown[] = t): Promise<T[]> =>
      this.pool.query(sql, vals).then((r) => r.rows as T[]).catch(() => [] as T[]);

    const [mem, memKind, vecTot, vecDocs, vecSrc, graph, graphKind, updated, kg] = await Promise.all([
      // 记忆：总量 / 向量覆盖 / agent 数 / 时间跨度
      q(`SELECT count(*) total, count(*) FILTER (WHERE embedding IS NOT NULL) vec,
                count(DISTINCT agent_id) agents, min(created_at) oldest, max(created_at) newest,
                count(*) FILTER (WHERE created_at > now() - interval '24 hours') last24
           FROM opendb_memories WHERE tenant_id = $1`),
      q(`SELECT kind, count(*) n FROM opendb_memories WHERE tenant_id = $1 GROUP BY 1`),
      // 向量：切块总量与向量覆盖
      q(`SELECT count(*) chunks, count(*) FILTER (WHERE c.embedding IS NOT NULL) vec
           FROM opendb_knowledge_chunks c JOIN opendb_knowledge_docs d ON d.id = c.doc_id
          WHERE d.tenant_id = $1`),
      q(`SELECT count(*) docs FROM opendb_knowledge_docs WHERE tenant_id = $1`),
      // 向量：按来源前缀粗分类（source 形如 sop-* / task:* …）
      q(`SELECT coalesce(split_part(source, ':', 1), '未标注') src, count(*) n
           FROM opendb_knowledge_docs WHERE tenant_id = $1 GROUP BY 1 ORDER BY 2 DESC`),
      // 图：边 / 实体 / 关联记忆（表无 tenant 列，且 SQL 无占位符 → 必须传空参数数组，
      //   否则 pg 报「bind message supplies 1 parameters, but requires 0」被 catch 吞成 0）
      q(`SELECT count(*) edges, count(DISTINCT entity) entities, count(DISTINCT memory_id) linked
           FROM opendb_memory_entities`, []),
      q(`SELECT kind, count(DISTINCT entity) n FROM opendb_memory_entities GROUP BY 1`, []),
      // 全局最近更新时间（三库取最大）
      q(`SELECT greatest(
                 (SELECT max(created_at) FROM opendb_memories WHERE tenant_id = $1),
                 (SELECT max(created_at) FROM opendb_knowledge_docs WHERE tenant_id = $1)) ts`),
      // 强类型图（P2 commit 后）：kg 边/节点 + 人审队列待确认数
      q(`SELECT (SELECT count(*) FROM opendb_kg_edges WHERE tenant_id = $1) kg_edges,
                (SELECT count(*) FROM opendb_kg_nodes WHERE tenant_id = $1) kg_nodes,
                (SELECT count(*) FROM opendb_kb_edge_staging s JOIN opendb_kb_imports i ON i.id = s.import_id
                   WHERE i.tenant_id = $1 AND s.decision = 'pending') pending`),
    ]);

    const n = (v: unknown): number => Number(v ?? 0);
    const m0 = mem[0] ?? {}; const v0 = vecTot[0] ?? {}; const g0 = graph[0] ?? {};
    return {
      memory: {
        total: n(m0.total), withVec: n(m0.vec), agents: n(m0.agents),
        oldest: m0.oldest ?? null, newest: m0.newest ?? null, last24: n(m0.last24),
        byKind: memKind.map((r) => ({ kind: String(r.kind), n: n(r.n) })).sort((a, b) => b.n - a.n),
      },
      vector: {
        docs: n((vecDocs[0] ?? {}).docs), chunks: n(v0.chunks), withVec: n(v0.vec),
        bySource: vecSrc.map((r) => ({ source: String(r.src), n: n(r.n) })),
      },
      graph: {
        edges: n(g0.edges), entities: n(g0.entities), linkedMemories: n(g0.linked),
        byKind: graphKind.map((r) => ({ kind: String(r.kind), n: n(r.n) })),
        typed: false,   // opendb_memory_entities 均为共现边
        // 强类型图（导入 commit 后）：kg 边/节点 + 人审待确认队列
        kgEdges: n((kg[0] ?? {}).kg_edges), kgNodes: n((kg[0] ?? {}).kg_nodes), pendingReview: n((kg[0] ?? {}).pending),
      },
      updatedAt: (updated[0] ?? {}).ts ?? null,
    };
  }
}
export { KnowledgeService };
