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

test('目录结构：五组、规则行非空、markdown 生成', () => {
  const groups = rulesCatalog();
  assert.deepEqual(groups.map((g) => g.plugin), ['health', 'sqlreview', 'wdr', 'ddl', 'capacity']);
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

// ── R1（2026-08-31）：容量组补入目录、结构化级别阶梯、目录与实现的码级对账
import { CAP_T, DDL_T, catalogCodes, codesOf } from '../src/index.ts';
import { CAP_THRESHOLDS } from '@opendb-dsh/task-capacity';
import { DDL_THRESHOLDS } from '@opendb-dsh/task-ddl';

test('目录快照与 task-capacity / task-ddl 实现常量同步', () => {
  assert.deepEqual(CAP_T.diskUsed, CAP_THRESHOLDS.diskUsed);
  assert.deepEqual(CAP_T.daysToFull, CAP_THRESHOLDS.daysToFull);
  assert.equal(CAP_T.minGrowthBytesPerDay, CAP_THRESHOLDS.minGrowthBytesPerDay);
  assert.deepEqual(CAP_T.nonTableShare, CAP_THRESHOLDS.nonTableShare);
  assert.deepEqual(CAP_T.sysTableBloat, CAP_THRESHOLDS.sysTableBloat);
  assert.equal(CAP_T.statsNeverRows, CAP_THRESHOLDS.statsNeverRows);
  assert.deepEqual(CAP_T.deadRatio, CAP_THRESHOLDS.deadRatio);
  assert.equal(CAP_T.walSegFactor, CAP_THRESHOLDS.walSegFactor);
  assert.deepEqual(CAP_T.wdr, CAP_THRESHOLDS.wdr);
  assert.equal(CAP_T.collectGapHours, CAP_THRESHOLDS.collectGapHours);
  assert.equal(CAP_T.logMaxBytes, CAP_THRESHOLDS.logMaxBytes);
  assert.equal(DDL_T.businessHourStart, DDL_THRESHOLDS.businessHourStart);
  assert.equal(DDL_T.businessHourEnd, DDL_THRESHOLDS.businessHourEnd);
  assert.equal(DDL_T.churnCount, DDL_THRESHOLDS.churnCount);
  assert.equal(DDL_T.churnWindowHours, DDL_THRESHOLDS.churnWindowHours);
});

test('五个插件都在目录里；每行都有阶梯与判据来源', () => {
  const groups = rulesCatalog();
  assert.deepEqual(groups.map((g) => g.plugin), ['health', 'sqlreview', 'wdr', 'ddl', 'capacity']);
  for (const g of groups) for (const r of g.rows) {
    assert.ok(r.steps.length > 0, `${r.id} 没有级别阶梯`);
    assert.ok(r.from !== '', `${r.id} 没写判据来源`);
    for (const s of r.steps) assert.ok(['notice', 'warn', 'critical', 'plain'].includes(s.lv), `${r.id} 阶梯级别非法：${s.lv}`);
  }
});

/**
 * 阈值服务里每个 spec 都声明了它属于哪条规则（spec.rule）。目录如果漏登记那条规则，
 * 面板上「⚙ 可调阈值」就会挂不上去——这正是 OS_LOAD_HIGH / 整个容量插件此前的状况。
 */
test('阈值 spec 引用的规则码，目录里都登记过', async () => {
  const { HEALTH_THRESHOLD_SPECS } = await import('@opendb-dsh/task-health');
  const { WDR_THRESHOLD_SPECS } = await import('@opendb-dsh/task-wdr');
  const { DDL_THRESHOLD_SPECS } = await import('@opendb-dsh/task-ddl');
  const { CAP_THRESHOLD_SPECS } = await import('@opendb-dsh/task-capacity');
  const known = catalogCodes();
  for (const s of [...HEALTH_THRESHOLD_SPECS, ...WDR_THRESHOLD_SPECS, ...DDL_THRESHOLD_SPECS, ...CAP_THRESHOLD_SPECS]) {
    assert.ok(known.has(s.rule), `阈值 ${s.plugin}.${s.key} 指向的规则 ${s.rule} 不在目录里`);
  }
});

test('codesOf：合并行给出全部真实码，纪律类条目为空', () => {
  const rows = rulesCatalog().flatMap((g) => g.rows);
  const merged = rows.find((r) => r.id === 'XACT_LONG / XACT_IDLE');
  assert.deepEqual(codesOf(merged!), ['XACT_LONG', 'XACT_IDLE']);
  assert.deepEqual(codesOf(rows.find((r) => r.id === '归因纪律')!), []);
  assert.deepEqual(codesOf(rows.find((r) => r.id === 'CONN_HIGH')!), ['CONN_HIGH']);
});
