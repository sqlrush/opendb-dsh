import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES_TASK_TYPE, rulesCatalog, catalogMarkdown, HEALTH_T, WDR_T } from '../src/index.ts';
import { THRESHOLDS } from '@opendb-dsh/task-health';
import { WDR_THRESHOLDS } from '@opendb-dsh/task-wdr';

test('目录快照与 task-health 实现常量同步（漂移即红）', () => {
  assert.deepEqual(HEALTH_T.connRatio, THRESHOLDS.connRatio);
  assert.deepEqual(HEALTH_T.cacheHit, THRESHOLDS.cacheHit);
  assert.deepEqual(HEALTH_T.xactSec, THRESHOLDS.xactSec);
  assert.deepEqual(HEALTH_T.bloatRatio, THRESHOLDS.bloatRatio);
  assert.deepEqual(HEALTH_T.slowAvgMs, THRESHOLDS.slowAvgMs);
  assert.deepEqual(HEALTH_T.blockedSessions, THRESHOLDS.blockedSessions);
  assert.deepEqual(HEALTH_T.ckptReqShare, THRESHOLDS.ckptReqShare);
  assert.deepEqual(HEALTH_T.lwlockShare, THRESHOLDS.lwlockShare);
  assert.deepEqual(HEALTH_T.activeSessions, THRESHOLDS.activeSessions);
});

test('目录快照与 task-wdr 实现常量同步', () => {
  assert.deepEqual(WDR_T.avgActive, WDR_THRESHOLDS.avgActive);
  assert.deepEqual(WDR_T.tempBytes, WDR_THRESHOLDS.tempBytes);
  assert.deepEqual(WDR_T.cacheHit, WDR_THRESHOLDS.cacheHit);
  assert.deepEqual(WDR_T.ckptReqShare, WDR_THRESHOLDS.ckptReqShare);
  assert.deepEqual(WDR_T.rollbackRatio, WDR_THRESHOLDS.rollbackRatio);
  assert.deepEqual(WDR_T.blkSqlShare, WDR_THRESHOLDS.blkSqlShare);
});

test('目录结构：四组、规则行非空、markdown 生成', () => {
  const groups = rulesCatalog();
  assert.deepEqual(groups.map((g) => g.plugin), ['health', 'sqlreview', 'wdr', 'ddl']);
  for (const g of groups) assert.ok(g.rows.length >= 8, `${g.plugin} 规则行过少`);
  const md = catalogMarkdown();
  assert.match(md, /TBL001/);
  assert.match(md, /WDR_SQL_BLOCKED/);
  assert.match(md, /DDLR05/);
  const only = catalogMarkdown('wdr');
  assert.ok(!only.includes('TBL001') && only.includes('WDR_LOAD_HIGH'));
});

test('TaskType：report optional、prompt 指向 rules_catalog', async () => {
  assert.equal(RULES_TASK_TYPE.report, 'optional');
  const task = { id: 't', tenantId: 'default', agentId: 'a', type: 'rules', name: '规则目录', config: RULES_TASK_TYPE.configSchema({}), enabled: true, requiresApproval: false, timeoutMs: 0 } as any;
  const prompt = await RULES_TASK_TYPE.buildPrompt(task, {} as any, {} as any);
  assert.match(prompt, /rules_catalog/);
  assert.match(prompt, /不要增删改/);
});
