import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THRESHOLDS_TASK_TYPE } from '../src/index.ts';

test('TaskType：key/report/prompt 指向 threshold_list 且禁止在任务里改阈值', async () => {
  assert.equal(THRESHOLDS_TASK_TYPE.key, 'thresholds');
  assert.equal(THRESHOLDS_TASK_TYPE.report, 'optional');
  const task = { id: 't', tenantId: 'default', agentId: 'a', type: 'thresholds', name: '阈值', config: THRESHOLDS_TASK_TYPE.configSchema({}), enabled: true, requiresApproval: false, timeoutMs: 0 } as any;
  const prompt = await THRESHOLDS_TASK_TYPE.buildPrompt(task, {} as any, {} as any);
  assert.match(prompt, /threshold_list/);
  assert.match(prompt, /不要调用 threshold_set/);
});

test('configSchema：plugin 过滤透传', async () => {
  const cfg = THRESHOLDS_TASK_TYPE.configSchema({ plugin: 'health' });
  assert.equal(cfg.plugin, 'health');
  const task = { id: 't', tenantId: 'default', agentId: 'a', type: 'thresholds', name: '阈值', config: cfg, enabled: true, requiresApproval: false, timeoutMs: 0 } as any;
  const prompt = await THRESHOLDS_TASK_TYPE.buildPrompt(task, {} as any, {} as any);
  assert.match(prompt, /plugin 传 "health"/);
});
