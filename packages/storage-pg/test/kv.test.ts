import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '@opendb-dsh/session-persistence-pg';
import { PgStorageBackend } from '../src/index.ts';

const PG_URL = process.env.PG_URL;
let backend: PgStorageBackend;
const desc = { name: 'unit_test', version: 2, tables: ['items'], hasGlobal: true };

before(async () => {
  if (!PG_URL) return;
  const p = createPool(PG_URL);
  await p.query('DROP TABLE IF EXISTS dsh_kv_records, dsh_kv_units').catch(() => {});
  await p.end();
  backend = new PgStorageBackend(createPool(PG_URL));
});
after(async () => { await backend?.close(); });

test('open a fresh unit → empty shape; put/load round-trip; global null sentinel', { skip: !PG_URL }, async () => {
  const unit = await backend.kv.open(desc);
  assert.deepEqual(await unit.loadAll(), { tables: { items: {} }, global: null });
  await unit.putRecord('items', 'a/b c', { n: 1 });
  await unit.setGlobal({ initialized: true });
  const all = await unit.loadAll();
  assert.deepEqual(all.tables.items, { 'a/b c': { n: 1 } });
  assert.deepEqual(all.global, { initialized: true });
  await unit.deleteRecord('items', 'a/b c');
  assert.deepEqual((await unit.loadAll()).tables.items, {});
  await unit.close();
});

test('same unit cannot be opened twice; version mismatch rejects; closed unit rejects', { skip: !PG_URL }, async () => {
  const unit = await backend.kv.open(desc);
  await assert.rejects(() => backend.kv.open(desc), /already open/);
  await unit.close();
  await assert.rejects(() => backend.kv.open({ ...desc, version: 3 }), (e: any) => e.code === 'version-mismatch');
  const again = await backend.kv.open(desc);
  await again.close();
  await assert.rejects(() => again.loadAll(), (e: any) => e.code === 'closed');
});

test('data survives a second backend instance (host restart)', { skip: !PG_URL }, async () => {
  const u1 = await backend.kv.open(desc);
  await u1.putRecord('items', 'k', 'v');
  await u1.close();
  const b2 = new PgStorageBackend(createPool(PG_URL!));
  const u2 = await b2.kv.open(desc);
  assert.deepEqual((await u2.loadAll()).tables.items, { k: 'v' });
  await u2.close(); await b2.close();
});
