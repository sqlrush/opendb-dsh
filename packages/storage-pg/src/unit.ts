import { StorageError } from '@deepseek-ai/dsh-storage';
import type pg from 'pg';

export interface KvUnitDescriptor { readonly name: string; readonly version: number; readonly tables: readonly string[]; readonly hasGlobal: boolean }

/**
 * One open kv unit on PostgreSQL. The dsh contract only requires each call to be atomic and
 * durable when it resolves (the domain layer serialises writes per domain); a single
 * INSERT … ON CONFLICT per call satisfies that.
 */
export class PgKvUnit {
  private closed = false;
  constructor(private readonly pool: pg.Pool, private readonly descriptor: KvUnitDescriptor, private readonly onClose: () => void) {}

  private assertOpen() { if (this.closed) throw new StorageError('closed', `unit '${this.descriptor.name}' is closed`); }
  private assertTable(table: string) {
    if (!this.descriptor.tables.includes(table)) throw new Error(`unit '${this.descriptor.name}' has no table '${table}'`);
  }

  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen();
    const tables: Record<string, Record<string, unknown>> = {};
    for (const t of this.descriptor.tables) tables[t] = {};
    const rows = await this.pool.query<{ tbl: string; key: string; value: unknown }>('SELECT tbl, key, value FROM dsh_kv_records WHERE unit = $1', [this.descriptor.name]);
    for (const r of rows.rows) {
      if (tables[r.tbl] === undefined) throw new StorageError('malformed-medium', `unit '${this.descriptor.name}' has records for undeclared table '${r.tbl}'`);
      tables[r.tbl][r.key] = r.value;
    }
    const g = await this.pool.query<{ global: unknown }>('SELECT global FROM dsh_kv_units WHERE unit = $1', [this.descriptor.name]);
    return { tables, global: g.rows[0]?.global ?? null };
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen(); this.assertTable(table);
    await this.pool.query(
      `INSERT INTO dsh_kv_records (unit, tbl, key, value) VALUES ($1, $2, $3, $4)
       ON CONFLICT (unit, tbl, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [this.descriptor.name, table, key, JSON.stringify(value)],
    );
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen(); this.assertTable(table);
    await this.pool.query('DELETE FROM dsh_kv_records WHERE unit = $1 AND tbl = $2 AND key = $3', [this.descriptor.name, table, key]);
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen();
    if (!this.descriptor.hasGlobal) throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`);
    await this.pool.query('UPDATE dsh_kv_units SET global = $2, updated_at = now() WHERE unit = $1', [this.descriptor.name, JSON.stringify(value)]);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }
}
