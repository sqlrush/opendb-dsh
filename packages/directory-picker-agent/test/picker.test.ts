import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { createPool } from '@opendb-dsh/session-persistence-pg';
import Registry from '@opendb-dsh/registry';
import AgentDirectoryPicker from '../src/index.ts';

const PG_URL = process.env.PG_URL;
const ctx = new Context();
const root = mkdtempSync(join(tmpdir(), 'opendb-agents-'));
let picker: AgentDirectoryPicker;

before(async () => {
  if (!PG_URL) return;
  const p = createPool(PG_URL);
  // 同 registry.test：迁移有台账后只 DROP 表不会被重建，整 schema 重建取"全新库"语义（2026-08-29）
  await p.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO PUBLIC').catch(() => {});
  await p.end();
  await ctx.plugin(Registry, { connectionString: PG_URL });
  await ctx.plugin(AgentDirectoryPicker, { agentsRoot: root });
  picker = (ctx as any).directoryPicker as AgentDirectoryPicker;
});
after(async () => { await ctx.root.fiber.dispose(); });

test('createDirectory creates a registry agent and a real directory; list shows it', { skip: !PG_URL }, async () => {
  const cap = picker.capability();
  assert.equal(cap.kind, 'browse');
  const path = await cap.createDirectory(root, 'og-prod');
  assert.equal(path, join(root, 'og-prod'));
  assert.ok((await stat(path)).isDirectory());
  const listing = await cap.list();
  assert.deepEqual(listing.entries.map((e: any) => e.name), ['og-prod']);
  const reg = (ctx as any).opendbRegistry as Registry;
  assert.equal((await reg.listAgents())[0].name, 'og-prod');
  await assert.rejects(() => cap.createDirectory(root, 'og-prod'), (e: any) => e.code === 'directory-exists');
});
