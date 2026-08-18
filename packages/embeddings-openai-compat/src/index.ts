import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';

declare module '@deepseek-ai/cordis' {
  interface Context { opendbEmbeddings: EmbeddingsService }
}

export interface EmbedResponseLike { data?: { index?: number; embedding?: unknown }[] }

/** Parse an OpenAI-compatible /v1/embeddings response into row-ordered vectors (pure, unit-tested). */
export function parseEmbeddings(body: EmbedResponseLike, expectCount: number, expectDims: number): number[][] {
  const rows = body.data;
  if (!Array.isArray(rows) || rows.length !== expectCount) {
    throw new Error(`embeddings 响应条数不符：期望 ${expectCount}，实际 ${Array.isArray(rows) ? rows.length : 'none'}`);
  }
  const out: number[][] = new Array(expectCount);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const idx = typeof row.index === 'number' ? row.index : i;
    const vec = row.embedding;
    if (!Array.isArray(vec) || vec.length !== expectDims || !vec.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw new Error(`embeddings 第 ${idx} 条向量非法（期望 ${expectDims} 维数值数组）`);
    }
    out[idx] = vec as number[];
  }
  for (let i = 0; i < expectCount; i += 1) {
    if (out[i] === undefined) throw new Error('embeddings 响应 index 不连续');   // 注意稀疏数组的 some 会跳过空槽
  }
  return out;
}

/**
 * ctx.opendbEmbeddings — the embeddings seam (design §8.3): OpenAI-compatible
 * /v1/embeddings client. MVP provider = in-cluster Ollama + bge-m3 (1024 dims,
 * user-approved); swapping to any hosted service is a baseUrl/model change.
 */
export default class EmbeddingsService extends Service {
  static Config = z.object({
    baseUrl: z.string().default(''),
    model: z.string().default(''),
    dims: z.number().step(1).min(8).default(1024),
    timeoutMs: z.number().step(1).min(1000).default(30_000),
    maxBatch: z.number().step(1).min(1).default(16),
  });

  readonly dims: number;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxBatch: number;

  constructor(ctx: Context, config: { baseUrl?: string; model?: string; dims?: number; timeoutMs?: number; maxBatch?: number } = {}) {
    super(ctx, 'opendbEmbeddings');
    this.baseUrl = ((config.baseUrl ?? '') !== '' ? config.baseUrl! : process.env.OPENDB_EMBEDDINGS_URL ?? '').replace(/\/+$/, '');
    this.model = (config.model ?? '') !== '' ? config.model! : process.env.OPENDB_EMBEDDINGS_MODEL ?? 'bge-m3';
    this.dims = config.dims ?? 1024;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxBatch = config.maxBatch ?? 16;
    if (this.baseUrl === '') {
      process.stderr.write('[embeddings] OPENDB_EMBEDDINGS_URL 未配置，embed() 将失败（memory 会回退纯文本检索）\n');
    }
  }

  /** Whether the service is configured (callers may skip embedding entirely when false). */
  get available(): boolean {
    return this.baseUrl !== '';
  }

  /** Embed texts (row order preserved). Throws on any failure — callers decide the fallback. */
  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (this.baseUrl === '') throw new Error('embeddings 服务未配置（OPENDB_EMBEDDINGS_URL）');
    const out: number[][] = [];
    for (let at = 0; at < texts.length; at += this.maxBatch) {
      const batch = texts.slice(at, at + this.maxBatch);
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: batch }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      out.push(...parseEmbeddings(await res.json() as EmbedResponseLike, batch.length, this.dims));
    }
    return out;
  }
}
export { EmbeddingsService };
