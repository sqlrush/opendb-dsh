import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPACITY_TASK_TYPE } from '../src/index.ts';

test('configSchema 默认值：每日 02:00、Top 20、观测窗 7 天', () => {
  const cfg = CAPACITY_TASK_TYPE.configSchema({});
  assert.equal(cfg.node, '');
  assert.equal(cfg.topN, 20);
  assert.equal(cfg.growthWindowDays, 7);
  assert.equal(CAPACITY_TASK_TYPE.defaultCron, '0 2 * * *');
  assert.equal(CAPACITY_TASK_TYPE.key, 'capacity');
});

test('reportSchema：缺 det 拒收；只装解读字段', () => {
  assert.throws(() => CAPACITY_TASK_TYPE.reportSchema({ scope: 'capacity', node: 'og5' }));
  const ok = CAPACITY_TASK_TYPE.reportSchema({ det: { worst: 'warn' }, situation: '58 GB，几乎不涨', findings: [{ rule: 'CAP_STATS_NEVER', note: 'x' }], priorities: [{ p: 'P1', action: 'a' }] }) as any;
  assert.equal(ok.det.counts.ok, 0);
  assert.equal(ok.findings[0].object, '');
});

test('buildPrompt：锚定 capacity_collect、诚实守卫（首采/无磁盘）、参数透传', async () => {
  const ctx = { nodesOf: async () => [{ id: '1', name: 'og5', engine: 'opengauss', host: 'h', port: 1, dbname: 'postgres', status: 'online' }] } as any;
  const task = { id: 't', tenantId: 'default', agentId: 'a', type: 'capacity', name: 'cap', config: CAPACITY_TASK_TYPE.configSchema({ topN: 30, growthWindowDays: 14, focus: '看 statement_history' }), enabled: true, requiresApproval: false, timeoutMs: 0 } as any;
  const prompt = await CAPACITY_TASK_TYPE.buildPrompt(task, {} as any, ctx);
  assert.match(prompt, /capacity_collect（node 传 "og5"，topN 传 30，growthWindowDays 传 14）/);
  assert.match(prompt, /firstRun=true/);
  assert.match(prompt, /disk 缺失/);
  assert.match(prompt, /逐字/);
  assert.match(prompt, /看 statement_history/);
});
