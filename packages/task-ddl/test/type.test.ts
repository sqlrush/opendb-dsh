import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DDL_TASK_TYPE, dictToTimeline, auditToTimeline, mergeTimeline, scanDdlRules, timelineStats, worstOf } from '../src/index.ts';

test('configSchema 默认值', () => {
  const cfg = DDL_TASK_TYPE.configSchema({});
  assert.equal(cfg.hours, 168);
  assert.equal(cfg.node, '');
});

test('reportSchema 拒绝缺 timeline/det', () => {
  assert.throws(() => DDL_TASK_TYPE.reportSchema({ scope: 'ddl-trace', node: 'og5' }));
});

test('buildPrompt 锚定纪律 + 归因诚实', async () => {
  const ctx = { nodesOf: async () => [{ id: '1', name: 'og5', engine: 'opengauss', host: 'h', port: 1, dbname: 'postgres', status: 'online' }] } as any;
  const task = { id: 't', tenantId: 'default', agentId: 'a', type: 'ddl', name: 'DDL', config: DDL_TASK_TYPE.configSchema({}), enabled: true, requiresApproval: false, timeoutMs: 0 } as any;
  const prompt = await DDL_TASK_TYPE.buildPrompt(task, {} as any, ctx);
  assert.match(prompt, /ddl_collect/);
  assert.match(prompt, /不要猜测操作者/);
  assert.match(prompt, /逐字/);
});

test('dictToTimeline：洪峰折叠（>30 同刻 → baseline 单条）', () => {
  const t = '2026-08-18T08:16:53.000Z';
  const bulk = Array.from({ length: 50 }, (_, i) => ({ time: t, kind: 'table', sch: 'bench', name: `t${i}`, change: 'added' }));
  const single = [{ time: '2026-08-18T09:00:00.000Z', kind: 'table', sch: 'public', name: 'probe', change: 'removed' }];
  const tl = dictToTimeline([...bulk, ...single] as any);
  assert.equal(tl.length, 2);
  const base = tl.find((e) => e.action === 'baseline');
  assert.equal(base?.count, 50);
  assert.ok(tl.some((e) => e.action === 'removed' && e.object === 'public.probe'));
});

test('mergeTimeline：审计条目±15min 按对象吸附字典条目，补 user/sqlText', () => {
  const dict = dictToTimeline([{ time: '2026-08-18T08:19:46.000Z', kind: 'table', sch: 'public', name: 'w3_dict_probe', change: 'added' }] as any);
  const audit = auditToTimeline([{ time: '2026-08-18T08:12:00.000Z', type: 'ddl_table', result: 'ok', username: 'omm', object_name: 'w3_dict_probe', detail_info: 'CREATE TABLE w3_dict_probe(id int primary key)' }] as any);
  const merged = mergeTimeline(dict, audit);
  assert.equal(merged.length, 1, '应吸附为一条');
  assert.equal(merged[0].user, 'omm');
  assert.deepEqual(merged[0].sources.sort(), ['audit', 'dict']);
  assert.equal(merged[0].action, 'added', '保留字典语义');
});

test('scanDdlRules：DROP/TRUNCATE/业务时段/抖动/幂等', () => {
  const entries = [
    { time: '2026-08-18T03:30:00.000Z', action: 'removed', kind: 'table', object: 'public.gone', user: 'omm', sqlText: 'DROP TABLE public.gone', sources: ['dict', 'audit'] },  // 北京 11:30 业务时段
    { time: '2026-08-18T18:00:00.000Z', action: 'ddl', kind: 'statement', object: 'public.t2', user: '', sqlText: 'TRUNCATE public.t2', sources: ['audit'] },
    { time: '2026-08-18T01:00:00.000Z', action: 'changed', kind: 'table', object: 'public.hot', user: '', sqlText: '', sources: ['dict'] },
    { time: '2026-08-18T02:00:00.000Z', action: 'changed', kind: 'table', object: 'public.hot', user: '', sqlText: '', sources: ['dict'] },
    { time: '2026-08-18T03:00:00.000Z', action: 'changed', kind: 'table', object: 'public.hot', user: '', sqlText: '', sources: ['dict'] },
  ] as any;
  const f = scanDdlRules(entries);
  const rules = f.map((x) => x.rule);
  assert.ok(rules.includes('DDLR01'), 'DROP TABLE');
  assert.ok(rules.includes('DDLR02'), 'TRUNCATE');
  assert.ok(rules.includes('DDLR07'), 'DROP 无 IF EXISTS');
  assert.ok(rules.includes('DDLR04'), '业务时段');
  assert.ok(rules.includes('DDLR05'), '变更抖动');
  assert.equal(worstOf(f), 'warn');
});

test('timelineStats：baseline 不计入实际变更；用户去重', () => {
  const st = timelineStats([
    { time: '', action: 'baseline', kind: 'bulk', object: '', user: '', sqlText: '', sources: ['dict'], count: 300 },
    { time: '', action: 'added', kind: 'table', object: 'a', user: 'omm', sqlText: '', sources: [] },
    { time: '', action: 'removed', kind: 'table', object: 'b', user: 'omm', sqlText: '', sources: [] },
  ] as any);
  assert.equal(st.total, 2);
  assert.equal(st.added, 1);
  assert.equal(st.removed, 1);
  assert.deepEqual(st.users, ['omm']);
});
