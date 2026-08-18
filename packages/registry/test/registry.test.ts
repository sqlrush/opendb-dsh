import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createPool } from '@opendb-dsh/session-persistence-pg';
import Registry from '../src/index.ts';

const PG_URL = process.env.PG_URL;
const ctx = new Context();
let reg: Registry;

before(async () => {
  if (!PG_URL) return;
  const p = createPool(PG_URL);
  await p.query('DROP TABLE IF EXISTS dsh_db_nodes, dsh_db_groups, dsh_agents, dsh_users, dsh_tenants CASCADE').catch(() => {});
  await p.end();
  await ctx.plugin(Registry, { connectionString: PG_URL });
  reg = (ctx as any).opendbRegistry as Registry;
});
after(async () => { await ctx.root.fiber.dispose(); });

test('agent CRUD + instruction versioning', { skip: !PG_URL }, async () => {
  const a = await reg.createAgent({ name: 'og-agent-1', instructionDoc: '# 巡检要点\n- 关注主备延迟' });
  assert.equal(a.kind, 'domain'); assert.equal(a.instructionVersion, 0);
  const a2 = await reg.setInstructionDoc(a.id, '# v2');
  assert.equal(a2?.instructionVersion, 1);
  const a3 = await reg.updateAgent(a.id, { workspaceId: 'ws-123', preset: 'og-readonly' });
  assert.equal(a3?.workspaceId, 'ws-123');
  assert.equal((await reg.getAgentByWorkspace('ws-123'))?.id, a.id);
  assert.equal((await reg.listAgents()).length, 1);
});

test('node binding to agent', { skip: !PG_URL }, async () => {
  const a = (await reg.listAgents())[0];
  const n = await reg.createNode({ name: 'og5', host: '192.168.128.1', port: 5433, engine: 'opengauss', agentId: a.id });
  assert.equal(n.engine, 'opengauss');
  assert.equal((await reg.listNodes({ agentId: a.id })).length, 1);
  await reg.assignNode(n.id, null);
  assert.equal((await reg.listNodes({ agentId: a.id })).length, 0);
});
