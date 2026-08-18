import { defineTool } from '@deepseek-ai/dsh-tools';
import type { S3Client } from '@aws-sdk/client-s3';
import { getObjectBytes } from '@opendb-dsh/attachment-s3';

export const READ_SPILL_TOOL = 'read_spill';

export interface SpillReader { s3: S3Client; bucket: string; prefix: string; maxReadBytes: number }

/** Parse `s3://bucket/key`; only locators inside our bucket/prefix are accepted (storage is not access control, but the tool is scoped). */
export function parseLocator(locator: string, bucket: string, prefix: string): string | undefined {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(locator);
  if (!m || m[1] !== bucket) return undefined;
  const key = m[2];
  if (!key.startsWith(`${prefix}/`) || key.includes('..')) return undefined;
  return key;
}

export async function readSpill(r: SpillReader, locator: string, offset = 0, limit = 200): Promise<{ content: string; totalLines: number; nextOffset?: number; truncated: boolean }> {
  const key = parseLocator(locator, r.bucket, r.prefix);
  if (key === undefined) throw new Error(`read_spill: locator is not a spill object of this deployment: ${locator}`);
  const bytes = await getObjectBytes(r.s3, r.bucket, key);
  if (bytes === undefined) throw new Error(`read_spill: spill object not found: ${locator}`);
  const lines = new TextDecoder().decode(bytes).split('\n');
  const start = Math.max(0, Math.floor(offset));
  const end = Math.min(lines.length, start + Math.max(1, Math.floor(limit)));
  let content = lines.slice(start, end).join('\n');
  let truncated = false;
  if (Buffer.byteLength(content, 'utf8') > r.maxReadBytes) {
    content = Buffer.from(content, 'utf8').subarray(0, r.maxReadBytes).toString('utf8');
    truncated = true;
  }
  const nextOffset = end < lines.length ? end : undefined;
  return { content, totalLines: lines.length, ...(nextOffset !== undefined ? { nextOffset } : {}), truncated };
}

/** Build the model-facing read_spill tool definition. */
export function defineReadSpillTool(r: SpillReader) {
  return defineTool({
    name: READ_SPILL_TOOL,
    description: 'Read a spilled tool result stored in object storage (locator looks like s3://bucket/spill/...). Returns lines [offset, offset+limit); use nextOffset to page.',
    parameters: {
      locator: { type: 'string', required: true, description: 'The s3:// locator given in the spill notice.' },
      offset: { type: 'integer', description: 'Zero-based line offset (default 0).' },
      limit: { type: 'integer', description: 'Max lines to return (default 200).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          content: { type: 'string', required: true },
          totalLines: { type: 'integer', required: true },
          nextOffset: { type: 'integer' },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args: any, value: any) => [{
        type: 'text',
        text: value.content + (value.nextOffset !== undefined ? `\n\n[read_spill: ${value.totalLines} lines total; continue with offset=${value.nextOffset}]` : '') + (value.truncated ? '\n[read_spill: output truncated to size cap; use a smaller limit]' : ''),
      }],
    },
    async execute(args: any) {
      return readSpill(r, args.locator, args.offset ?? 0, args.limit ?? 200);
    },
  } as any);
}
