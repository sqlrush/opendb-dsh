import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import type pg from 'pg';
import { createPool, runMigrations, rollbackAndRelease } from '@opendb-dsh/session-persistence-pg';
import { computeDictDiff, definitionBackfills, type DictObject, type DictChange } from './diff.ts';

export { computeDictDiff, definitionBackfills, objectKey, type DictObject, type DictChange } from './diff.ts';

export interface SnapshotResult { added: number; removed: number; modified: number; total: number }
export interface StoredChange extends DictChange { time: Date; nodeId: string }
export interface StoredObject extends DictObject { firstSeen: Date; lastSeen: Date }

declare module '@deepseek-ai/cordis' {
  interface Context { opendbDictionary: DictionaryService }
}

/**
 * ctx.opendbDictionary — data-dictionary snapshots and change history for managed nodes
 * (design §5: 数据字典变化入时序侧). snapshot() runs in one transaction under a per-node
 * advisory xact lock, so overlapping collectors never double-log a change.
 * 2026-08-30（表结构变更追溯 R2）：对象与变更记录同时保存定义原文，供列/索引级 diff。
 */
export default class DictionaryService extends Service {
  static Config = z.object({ connectionString: z.string().required(), defaultTenant: z.string().default('default') });
  readonly pool: pg.Pool;
  private readonly ready: Promise<void>;
  private readonly tenant: string;

  constructor(ctx: Context, config: { connectionString: string; defaultTenant?: string }) {
    super(ctx, 'opendbDictionary');
    this.pool = createPool(config.connectionString);
    this.tenant = config.defaultTenant ?? 'default';
    this.ready = runMigrations(this.pool);
    this.ready.catch(() => { /* surfaced on first call */ });
    ctx.effect(() => async () => { await this.ready.catch(() => {}); await this.pool.end(); }, 'opendbDictionary.pool');
  }

  /** Diff a fresh snapshot against stored state; record changes; upsert objects. */
  async snapshot(nodeId: string, current: readonly DictObject[]): Promise<SnapshotResult> {
    await this.ready;
    const client = await this.pool.connect();
    let released = false;
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('opendb_dict:' || $1))", [nodeId]);
      const storedRes = await client.query('SELECT kind, sch, name, signature, definition FROM opendb_dict_objects WHERE node_id = $1', [nodeId]);
      const stored: DictObject[] = storedRes.rows.map((r) => ({ kind: r.kind, sch: r.sch, name: r.name, signature: r.signature, definition: r.definition ?? undefined }));
      const changes = computeDictDiff(stored, current);
      for (const c of changes) {
        await client.query(
          `INSERT INTO opendb_dict_changes (tenant_id, node_id, kind, sch, name, change, old_signature, new_signature, old_definition, new_definition)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [this.tenant, nodeId, c.kind, c.sch, c.name, c.change, c.oldSignature ?? null, c.newSignature ?? null, c.oldDefinition ?? null, c.newDefinition ?? null],
        );
        if (c.change === 'removed') {
          await client.query('DELETE FROM opendb_dict_objects WHERE node_id = $1 AND kind = $2 AND sch = $3 AND name = $4', [nodeId, c.kind, c.sch, c.name]);
        } else {
          await client.query(
            `INSERT INTO opendb_dict_objects (tenant_id, node_id, kind, sch, name, signature, definition)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (node_id, kind, sch, name) DO UPDATE SET signature = EXCLUDED.signature, definition = EXCLUDED.definition, last_seen = now()`,
            [this.tenant, nodeId, c.kind, c.sch, c.name, c.newSignature ?? '', c.newDefinition ?? null],
          );
        }
      }
      // 升级后首次快照：签名未变但库里还没存定义 → 回填，不记变更
      for (const o of definitionBackfills(stored, current)) {
        await client.query('UPDATE opendb_dict_objects SET definition = $5 WHERE node_id = $1 AND kind = $2 AND sch = $3 AND name = $4', [nodeId, o.kind, o.sch, o.name, o.definition ?? null]);
      }
      // refresh last_seen for unchanged objects too (single statement, cheap)
      await client.query('UPDATE opendb_dict_objects SET last_seen = now() WHERE node_id = $1', [nodeId]);
      await client.query('COMMIT');
      client.release();
      released = true;
      const counts = { added: 0, removed: 0, modified: 0 };
      for (const c of changes) counts[c.change] += 1;
      return { ...counts, total: current.length };
    } catch (cause) {
      if (!released) await rollbackAndRelease(client);
      throw cause;
    }
  }

  /** Recent dictionary changes (newest first), with definitions when recorded. */
  async changes(filter: { nodeId?: string; sinceHours?: number; limit?: number } = {}): Promise<StoredChange[]> {
    await this.ready;
    const since = String(Math.max(1, filter.sinceHours ?? 24));
    const limit = Math.min(filter.limit ?? 100, 2000);
    const cols = 'time, node_id, kind, sch, name, change, old_signature, new_signature, old_definition, new_definition';
    const r = filter.nodeId !== undefined
      ? await this.pool.query(
          `SELECT ${cols} FROM opendb_dict_changes WHERE node_id = $1 AND time > now() - ($2 || ' hours')::interval ORDER BY time DESC LIMIT $3`,
          [filter.nodeId, since, limit])
      : await this.pool.query(
          `SELECT ${cols} FROM opendb_dict_changes WHERE time > now() - ($1 || ' hours')::interval ORDER BY time DESC LIMIT $2`,
          [since, limit]);
    return r.rows.map((row) => ({
      time: row.time, nodeId: row.node_id, kind: row.kind, sch: row.sch, name: row.name,
      change: row.change, oldSignature: row.old_signature ?? undefined, newSignature: row.new_signature ?? undefined,
      oldDefinition: row.old_definition ?? undefined, newDefinition: row.new_definition ?? undefined,
    }));
  }

  /** Current objects of a node (optionally one schema), with definitions when known. */
  async objects(nodeId: string, filter: { sch?: string; kinds?: readonly string[] } = {}): Promise<StoredObject[]> {
    await this.ready;
    const conds = ['node_id = $1']; const params: unknown[] = [nodeId];
    if (filter.sch !== undefined) { params.push(filter.sch); conds.push(`sch = $${params.length}`); }
    if (filter.kinds !== undefined && filter.kinds.length > 0) { params.push([...filter.kinds]); conds.push(`kind = ANY($${params.length}::text[])`); }
    const r = await this.pool.query(`SELECT kind, sch, name, signature, definition, first_seen, last_seen FROM opendb_dict_objects WHERE ${conds.join(' AND ')} ORDER BY sch, kind, name`, params);
    return r.rows.map((row) => ({ kind: row.kind, sch: row.sch, name: row.name, signature: row.signature, definition: row.definition ?? undefined, firstSeen: row.first_seen, lastSeen: row.last_seen }));
  }
}
export { DictionaryService };
