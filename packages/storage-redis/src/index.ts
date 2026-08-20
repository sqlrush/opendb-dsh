import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { StorageError, UNIT_NAME_RE, storageBackendServiceKey } from '@deepseek-ai/dsh-storage';
import Redis from 'ioredis';

export const BACKEND_NAME = 'redis';

export interface KvUnitDescriptor { readonly name: string; readonly version: number; readonly tables: readonly string[]; readonly hasGlobal: boolean }

/**
 * dsh StorageBackend（kv facet）的 Redis 实现（P3 storage-redis）：
 * 数据模型——每表一个 hash `kv:{unit}:t:{tbl}`（field=key, value=json），
 * global 存 `kv:{unit}:__global__`，unit 版本存 `kv:{unit}:__version__`。
 * 持久化依赖 Redis AOF（chart 里 appendonly yes）。
 * 路由策略：只承载可重建/低敏 domain（session_projcache 投影缓存、message_feedback 评分）；
 * workspace（sessionIds 真相）保持 pg——正确性金贵（2026-08-19 裁剪事故）。
 */
class RedisKvUnit {
  private closed = false;
  constructor(
    private readonly redis: Redis,
    private readonly descriptor: KvUnitDescriptor,
    private readonly onClose: () => void,
  ) {}

  private assertOpen(): void { if (this.closed) throw new StorageError('closed', `unit '${this.descriptor.name}' is closed`); }
  private assertTable(table: string): void {
    if (!this.descriptor.tables.includes(table)) throw new Error(`unit '${this.descriptor.name}' has no table '${table}'`);
  }
  private tblKey(table: string): string { return `kv:${this.descriptor.name}:t:${table}`; }

  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen();
    const tables: Record<string, Record<string, unknown>> = {};
    for (const t of this.descriptor.tables) {
      const raw = await this.redis.hgetall(this.tblKey(t));
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) out[k] = JSON.parse(v);
      tables[t] = out;
    }
    const g = await this.redis.get(`kv:${this.descriptor.name}:__global__`);
    return { tables, global: g === null ? null : JSON.parse(g) };
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen(); this.assertTable(table);
    await this.redis.hset(this.tblKey(table), key, JSON.stringify(value));
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen(); this.assertTable(table);
    await this.redis.hdel(this.tblKey(table), key);
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen();
    if (!this.descriptor.hasGlobal) throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`);
    await this.redis.set(`kv:${this.descriptor.name}:__global__`, JSON.stringify(value));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }
}

class RedisStorageBackend {
  private readonly open = new Map<string, RedisKvUnit>();
  private closed = false;
  constructor(private readonly redis: Redis) {}

  readonly kv = {
    open: async (descriptor: KvUnitDescriptor): Promise<RedisKvUnit> => {
      if (this.closed) throw new StorageError('closed', 'redis backend is closed');
      if (!UNIT_NAME_RE.test(descriptor.name)) throw new StorageError('malformed-medium', `invalid unit name '${descriptor.name}'`);
      for (const t of descriptor.tables) {
        if (!UNIT_NAME_RE.test(t)) throw new StorageError('malformed-medium', `invalid table name '${t}' in unit '${descriptor.name}'`);
      }
      if (this.open.has(descriptor.name)) throw new Error(`unit '${descriptor.name}' is already open; a unit has exactly one live handle`);
      const vKey = `kv:${descriptor.name}:__version__`;
      const existing = await this.redis.get(vKey);
      if (existing === null) {
        await this.redis.set(vKey, String(descriptor.version));
      } else if (Number(existing) !== descriptor.version) {
        throw new StorageError('version-mismatch', `unit '${descriptor.name}' is at version ${existing}, expected ${descriptor.version}`);
      }
      const unit = new RedisKvUnit(this.redis, descriptor, () => this.open.delete(descriptor.name));
      this.open.set(descriptor.name, unit);
      return unit;
    },
  };

  async close(): Promise<void> {
    this.closed = true;
    for (const unit of [...this.open.values()]) await unit.close();
    this.redis.disconnect();
  }
}

export const name = 'storage-redis';
export const inject = ['storage'];
export const Config = z.object({ url: z.string().required().description('redis://host:port/db') });

/** Register the `redis` backend on the storage hub（与 storage-pg 同法）。 */
export function apply(ctx: Context, config: { url: string }): void {
  const redis = new Redis(config.url, { lazyConnect: false, maxRetriesPerRequest: 3, enableOfflineQueue: true });
  redis.on('error', (err) => process.stderr.write(`[storage-redis] ${String(err.message)}\n`));
  const backend = new RedisStorageBackend(redis);
  const anyCtx = ctx as any;
  ctx.effect(() => {
    const unregister = anyCtx.storage.backend.register(BACKEND_NAME, backend);
    return async () => { unregister(); await backend.close(); };
  }, 'storage-redis.register');
  anyCtx.provide(storageBackendServiceKey(BACKEND_NAME), backend);
}
