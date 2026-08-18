import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSPECTION_TASK_TYPE } from '../src/index.ts';

const ctx = { nodesOf: async () => [{ id: 'n1', name: 'og5', engine: 'opengauss', host: 'h', port: 5433, dbname: 'postgres', status: 'online' }] } as any;
const task = (config: any) => ({ id: 't1', tenantId: 'default', agentId: 'a1', type: 'inspection', name: '巡检', config: INSPECTION_TASK_TYPE.configSchema(config), enabled: true, requiresApproval: true, timeoutMs: 600000 }) as any;

test('config defaults and report schema', () => {
  const c = INSPECTION_TASK_TYPE.configSchema({});
  assert.deepEqual(c.nodes, []);
  const ok = INSPECTION_TASK_TYPE.reportSchema({ findings: [{ node: 'og5', item: 'locks', level: 'ok' }] }) as any;
  assert.equal(ok.findings[0].detail, '');
  assert.throws(() => INSPECTION_TASK_TYPE.reportSchema({ findings: [{ item: 'x', level: 'ok' }] }));
  assert.throws(() => INSPECTION_TASK_TYPE.reportSchema({}));
});

test('buildPrompt lists bound nodes and focus', async () => {
  const p = await INSPECTION_TASK_TYPE.buildPrompt(task({ focus: '重点看锁' }), {} as any, ctx);
  assert.match(p, /og5（opengauss h:5433/);
  assert.match(p, /重点看锁/);
  assert.match(p, /task_report|findings/);
  const filtered = await INSPECTION_TASK_TYPE.buildPrompt(task({ nodes: ['other'] }), {} as any, ctx);
  assert.match(filtered, /未绑定节点/);
});
