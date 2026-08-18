import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill';
import { encodeSegment } from '@deepseek-ai/dsh-spill-local';
import { createHash, randomBytes } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import { createS3, putObject, s3SettingsFromEnv } from '@opendb-dsh/attachment-s3';
import { defineReadSpillTool, readSpill, parseLocator, READ_SPILL_TOOL } from './tool.ts';

export { readSpill, parseLocator, READ_SPILL_TOOL, defineReadSpillTool } from './tool.ts';

export interface S3SpillConfig { endpoint?: string; bucket?: string; accessKey?: string; secretKey?: string; region?: string; prefix?: string; maxReadBytes?: number }

/**
 * Spill store on S3: oversized tool text goes to `s3://<bucket>/<prefix>/<session-hash>/<rand>-<name>`;
 * the model retrieves it with the `read_spill` tool registered by this same plugin (dsh's spill
 * seam has no retrieval API; the local backend relies on `read` over a filesystem path).
 */
export default class S3SpillStore extends SpillStore {
  static Config = z.object({
    endpoint: z.string(), bucket: z.string(), accessKey: z.string(), secretKey: z.string(), region: z.string(),
    prefix: z.string().default('spill'),
    maxReadBytes: z.number().step(1).min(1024).default(20000),
  });
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly maxReadBytes: number;

  constructor(ctx: Context, config: S3SpillConfig = {}) {
    super(ctx);
    const env = s3SettingsFromEnv();
    const settings = { endpoint: config.endpoint ?? env?.endpoint, bucket: config.bucket ?? env?.bucket, accessKey: config.accessKey ?? env?.accessKey ?? '', secretKey: config.secretKey ?? env?.secretKey ?? '', region: config.region ?? env?.region };
    if (!settings.endpoint || !settings.bucket) throw new Error('spill-s3: endpoint/bucket required (config or OPENDB_S3_ENDPOINT/OPENDB_S3_BUCKET)');
    this.s3 = createS3(settings as any);
    this.bucket = settings.bucket;
    this.prefix = (config.prefix ?? 'spill').replace(/\/+$/, '');
    this.maxReadBytes = config.maxReadBytes ?? 20000;
    // register the retrieval tool wherever a tools registry exists (Runtime); Host simply has no consumer
    const anyCtx = ctx as any;
    anyCtx.inject(['tools'], (c: any) => {
      c.effect(() => c.tools.register(defineReadSpillTool({ s3: this.s3, bucket: this.bucket, prefix: this.prefix, maxReadBytes: this.maxReadBytes })), 'spill-s3.read_spill');
    });
  }

  async saveText(input: any): Promise<any> {
    const sessionHash = createHash('sha256').update(String(input.owner.sessionId)).digest('hex').slice(0, 12);
    const key = `${this.prefix}/session-${sessionHash}/${randomBytes(6).toString('hex')}-${encodeSegment(input.suggestedName)}`;
    const bytes = Buffer.byteLength(input.content, 'utf8');
    await putObject(this.s3, this.bucket, key, input.content, 'text/plain; charset=utf-8');
    return {
      locator: SpillLocator(`s3://${this.bucket}/${key}`),
      bytes,
      retrievalHint: `Use the ${READ_SPILL_TOOL} tool with this locator (supports offset/limit lines) to read the full content.`,
    };
  }

  /** Direct read helper (tests / other plugins). */
  read(locator: string, offset?: number, limit?: number) {
    return readSpill({ s3: this.s3, bucket: this.bucket, prefix: this.prefix, maxReadBytes: this.maxReadBytes }, locator, offset, limit);
  }
}
export { S3SpillStore };
