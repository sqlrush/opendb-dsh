import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLREVIEW_TASK_TYPE, textRules, worstRuleLevel, annotatePlan, topCost, shortKey } from '../src/index.ts';

test('configSchema 默认值：三榜（总耗时/执行次数/平均耗时）、Top 5', () => {
  const cfg = SQLREVIEW_TASK_TYPE.configSchema({});
  assert.equal(cfg.node, '');
  assert.equal(cfg.topN, 5);
  assert.deepEqual(cfg.dimensions, ['elapsed', 'calls', 'avg']);
  assert.deepEqual(cfg.sqls, []);
  assert.equal(SQLREVIEW_TASK_TYPE.title, 'Top SQL 报表');
});

test('reportSchema：只装叙述——缺 det/sqlItems 拒绝，数字类字段不再要求', () => {
  assert.throws(() => SQLREVIEW_TASK_TYPE.reportSchema({ scope: 'sql-set' }));
  const ok = SQLREVIEW_TASK_TYPE.reportSchema({
    scope: 'sql-set',
    det: { worst: 'warn', counts: { ok: 0, notice: 1, warn: 1, critical: 0 } },
    sqlItems: [{ key: 'ab12', verify: 'no-gain' }],
  }) as any;
  assert.equal(ok.sqlItems[0].optimizedSql, '');
  assert.equal(ok.sqlItems[0].detail, '');
  assert.deepEqual(ok.priorities, []);
});

test('buildPrompt 把配置的维度与 topN 写成工具参数（用户按会话定榜单）', async () => {
  const ctx = { nodesOf: async () => [{ id: '1', name: 'og5', engine: 'opengauss', host: 'h', port: 1, dbname: 'postgres', status: 'online' }] } as any;
  const cfg = SQLREVIEW_TASK_TYPE.configSchema({ dimensions: ['执行次数', 'elapsed'], topN: 10 });
  const task = { id: 't', tenantId: 'default', agentId: 'a', type: 'sqlreview', name: 'x', config: cfg, enabled: true, requiresApproval: false, timeoutMs: 0 } as any;
  const prompt = await SQLREVIEW_TASK_TYPE.buildPrompt(task, {} as any, ctx);
  assert.match(prompt, /榜单维度 = 执行次数、总耗时（各 Top 10）/);
  assert.match(prompt, /dimensions 传 \["calls","elapsed"\]/);
  assert.match(prompt, /topN 传 10/);
  assert.match(prompt, /不必复述这些数字/);
});

test('buildPrompt 写明锚定纪律与验证阶梯', async () => {
  const ctx = { nodesOf: async () => [{ id: '1', name: 'og5', engine: 'opengauss', host: 'h', port: 1, dbname: 'postgres', status: 'online' }] } as any;
  const task = { id: 't', tenantId: 'default', agentId: 'a', type: 'sqlreview', name: 'SQL 审核', config: SQLREVIEW_TASK_TYPE.configSchema({}), enabled: true, requiresApproval: false, timeoutMs: 0 } as any;
  const prompt = await SQLREVIEW_TASK_TYPE.buildPrompt(task, {} as any, ctx);
  assert.match(prompt, /sqlreview_collect/);
  assert.match(prompt, /explain-verified/);
  assert.match(prompt, /estimated/);
  assert.match(prompt, /EXPLAIN ANALYZE/);
  assert.match(prompt, /逐字/);
});

test('文本规则：DML001/DQL001/DQL002/DQL003', () => {
  const f = textRules([
    { key: 'a', text: 'UPDATE order_log SET status = 1' },
    { key: 'b', text: "SELECT * FROM t WHERE note LIKE '%退款%'" },
    { key: 'c', text: 'SELECT id FROM t WHERE id NOT IN (SELECT ref FROM u)' },
    { key: 'd', text: 'UPDATE t SET a = 1 WHERE id = 2' },
  ]);
  assert.ok(f.some((x) => x.rule === 'DML001' && x.level === 'critical' && x.object === 'a'));
  assert.ok(f.some((x) => x.rule === 'DQL001' && x.object === 'b'));
  assert.ok(f.some((x) => x.rule === 'DQL002' && x.level === 'warn' && x.object === 'b'));
  assert.ok(f.some((x) => x.rule === 'DQL003' && x.object === 'c'));
  assert.ok(!f.some((x) => x.object === 'd'), '带 WHERE 的 UPDATE 不应命中 DML001');
  assert.equal(worstRuleLevel(f), 'critical');
});

test('计划标注：Seq Scan 大行数升级 warn + 顶层 cost 提取', () => {
  const plan = [
    'Limit  (cost=124381.20..124381.70 rows=200 width=44)',
    '  ->  Seq Scan on orders o  (cost=0.00..42381.20 rows=4810000 width=20)',
    '  ->  Seq Scan on small_t  (cost=0.00..12.10 rows=210 width=8)',
  ];
  assert.equal(topCost(plan), 124381.7);
  const f = annotatePlan(plan);
  assert.equal(f.filter((x) => x.code === 'PLAN_SEQSCAN').length, 2);
  assert.equal(f.find((x) => x.detail.includes('orders'))?.level, 'warn');
  assert.equal(f.find((x) => x.detail.includes('small_t'))?.level, 'notice');
});

test('shortKey 稳定且区分', () => {
  assert.equal(shortKey('SELECT 1'), shortKey('SELECT 1'));
  assert.notEqual(shortKey('SELECT 1'), shortKey('SELECT 2'));
});
