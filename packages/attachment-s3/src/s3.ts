import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';

export interface S3Settings { endpoint: string; bucket: string; accessKey: string; secretKey: string; region?: string }

/** Path-style S3 client suitable for MinIO / any S3-compatible endpoint. */
export function createS3(s: S3Settings): S3Client {
  const cfg: S3ClientConfig = {
    endpoint: s.endpoint,
    region: s.region ?? 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: s.accessKey, secretAccessKey: s.secretKey },
  };
  return new S3Client(cfg);
}

/** Read env-provided settings (the chart injects OPENDB_S3_*). */
export function s3SettingsFromEnv(env = process.env): S3Settings | undefined {
  if (!env.OPENDB_S3_ENDPOINT || !env.OPENDB_S3_BUCKET) return undefined;
  return { endpoint: env.OPENDB_S3_ENDPOINT, bucket: env.OPENDB_S3_BUCKET, accessKey: env.OPENDB_S3_ACCESS_KEY ?? '', secretKey: env.OPENDB_S3_SECRET_KEY ?? '', region: env.OPENDB_S3_REGION };
}

export async function objectExists(s3: S3Client, bucket: string, key: string): Promise<boolean> {
  try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; }
  catch (err: any) { if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return false; throw err; }
}

export async function putObject(s3: S3Client, bucket: string, key: string, body: Uint8Array | string, contentType?: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

export async function getObjectBytes(s3: S3Client, bucket: string, key: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
    const bytes = await r.Body?.transformToByteArray();
    return bytes ?? new Uint8Array();
  } catch (err: any) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NoSuchKey') return undefined;
    throw err;
  }
}
