import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { AttachmentError, AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment';
import { detectImage, validateImageFile } from '@deepseek-ai/dsh-attachment-local';
import { createHash } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import { createS3, getObjectBytes, objectExists, putObject, s3SettingsFromEnv } from './s3.ts';

export { createS3, s3SettingsFromEnv, getObjectBytes, putObject, objectExists } from './s3.ts';

const ID_PATTERN = /^sha256:([a-f0-9]{64})$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
const DEFAULTS = { maxImageBytes: 5 * 1024 * 1024, maxImagesPerMessage: 20, maxMessageImageBytes: 100 * 1024 * 1024, maxImagePixels: 4e7 };

function digest(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex'); }
function displayName(value?: string): string | undefined {
  if (value === undefined) return undefined;
  const clean = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1).replace(CONTROL_CHARS, '').trim().slice(0, 255);
  return clean === '' ? undefined : clean;
}

export interface S3AttachmentConfig {
  endpoint?: string; bucket?: string; accessKey?: string; secretKey?: string; region?: string;
  prefix?: string; maxImageBytes?: number; maxImagesPerMessage?: number; maxMessageImageBytes?: number; maxImagePixels?: number;
}

/**
 * Content-addressed image attachments on S3 (MinIO). Refs stay `sha256:<hex>` (they are persisted
 * in session logs); admission = dsh-attachment-local's validation; storage = PutObject/GetObject.
 */
export default class S3AttachmentStore extends AttachmentStore {
  static Config = z.object({
    endpoint: z.string(), bucket: z.string(), accessKey: z.string(), secretKey: z.string(), region: z.string(),
    prefix: z.string().default('attachments/v1'),
    maxImageBytes: z.number().step(1).min(1).default(DEFAULTS.maxImageBytes),
    maxImagesPerMessage: z.number().step(1).min(1).default(DEFAULTS.maxImagesPerMessage),
    maxMessageImageBytes: z.number().step(1).min(1).default(DEFAULTS.maxMessageImageBytes),
    maxImagePixels: z.number().step(1).min(1).default(DEFAULTS.maxImagePixels),
  });
  readonly imageLimits: any;
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(ctx: Context, config: S3AttachmentConfig = {}) {
    super(ctx);
    const env = s3SettingsFromEnv();
    const settings = {
      endpoint: config.endpoint ?? env?.endpoint, bucket: config.bucket ?? env?.bucket,
      accessKey: config.accessKey ?? env?.accessKey ?? '', secretKey: config.secretKey ?? env?.secretKey ?? '', region: config.region ?? env?.region,
    };
    if (!settings.endpoint || !settings.bucket) throw new Error('attachment-s3: endpoint/bucket required (config or OPENDB_S3_ENDPOINT/OPENDB_S3_BUCKET)');
    this.s3 = createS3(settings as any);
    this.bucket = settings.bucket;
    this.prefix = (config.prefix ?? 'attachments/v1').replace(/\/+$/, '');
    this.imageLimits = Object.freeze({
      maxImageBytes: config.maxImageBytes ?? DEFAULTS.maxImageBytes,
      maxImagesPerMessage: config.maxImagesPerMessage ?? DEFAULTS.maxImagesPerMessage,
      maxMessageImageBytes: config.maxMessageImageBytes ?? DEFAULTS.maxMessageImageBytes,
      maxImagePixels: config.maxImagePixels ?? DEFAULTS.maxImagePixels,
      mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    });
  }

  private key(sha256: string): string { return `${this.prefix}/${sha256.slice(0, 2)}/${sha256}`; }

  async validateImage(input: any): Promise<void> { await validateImageFile(input, this.imageLimits); }

  async saveImage(input: any): Promise<any> {
    if (input.data.byteLength > this.imageLimits.maxImageBytes) throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE');
    if (input.data.byteLength === 0) throw new AttachmentError('Image is empty.', 'INVALID_IMAGE');
    const detected = await detectImage(input.data, this.imageLimits.maxImagePixels);
    if (detected.mediaType !== input.mediaType) throw new AttachmentError('Declared image type does not match its bytes.', 'IMAGE_TYPE_MISMATCH');
    const sha256 = digest(input.data);
    const key = this.key(sha256);
    try {
      if (await objectExists(this.s3, this.bucket, key)) {
        const existing = await getObjectBytes(this.s3, this.bucket, key);
        if (existing === undefined || digest(existing) !== sha256) throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT');
      } else {
        await putObject(this.s3, this.bucket, key, input.data, input.mediaType);
      }
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      throw new AttachmentError('Unable to persist image attachment.', 'ATTACHMENT_WRITE_FAILED', { cause: error } as any);
    }
    const name = displayName(input.name);
    return { attachmentId: AttachmentId(`sha256:${sha256}`), mediaType: detected.mediaType, width: detected.width, height: detected.height, bytes: input.data.byteLength, ...(name !== undefined ? { name } : {}) };
  }

  async readImage(ref: any, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted();
    const match = ID_PATTERN.exec(String(ref.attachmentId));
    if (match?.[1] === undefined) throw new AttachmentError('Attachment reference is invalid.', 'INVALID_ATTACHMENT_REF');
    const sha256 = match[1];
    let data: Uint8Array | undefined;
    try { data = await getObjectBytes(this.s3, this.bucket, this.key(sha256), signal); }
    catch (error) { signal?.throwIfAborted(); throw new AttachmentError('Unable to read image attachment.', 'ATTACHMENT_READ_FAILED', { cause: error } as any); }
    signal?.throwIfAborted();
    if (data === undefined) throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND');
    if (digest(data) !== sha256) throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT');
    const meta = await detectImage(data, this.imageLimits.maxImagePixels);
    signal?.throwIfAborted();
    if (meta.mediaType !== ref.mediaType || data.byteLength !== ref.bytes || meta.width !== ref.width || meta.height !== ref.height) throw new AttachmentError('Stored attachment metadata does not match its reference.', 'ATTACHMENT_CORRUPT');
    return { ref, data };
  }
}
export { S3AttachmentStore };
