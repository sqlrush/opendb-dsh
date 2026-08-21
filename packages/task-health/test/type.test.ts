import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEALTH_TASK_TYPE } from '../src/index.ts';
import { worstOf, THRESHOLDS, COLLECTORS } from '../src/collectors.ts';
import { analyzeCluster, summarize, type NodeHealth } from '../src/collect.ts';

test('configSchema 默认值与规范化', () => {
  const cfg = HEALTH_TASK_TYPE.configSchema({});
  assert.deepEqual(cfg.nodes, []);
  assert.deepEqual(cfg.dims, []);
  assert.equal(cfg.focus, '');
});

test('reportSchema 拒绝缺 det/findings 的报告', () => {
  assert.throws(() => HEALTH_TASK_TYPE.reportSchema({ scope: 'instance' }));
  const ok = HEALTH_TASK_TYPE.reportSchema({
    scope: 'instance',
    det: { worst: 'warn', counts: { ok: 0, notice: 1, warn: 1, critical: 0 }, byNode: [{ node: 'og5', worst: 'warn' }] },
    findings: [{ node: 'og5', item: '长事务', level: 'warn' }],
  }) as any;
  assert.equal(ok.det.worst, 'warn');
  assert.equal(ok.findings[0].code, '');
});

test('buildPrompt 写明锚定纪律与 data 结构', async () => {
  const ctx = { nodesOf: async () => [{ id: '1', name: 'og5', engine: 'opengauss', host: 'h', port: 1, dbname: 'postgres', status: 'online' }] } as any;
  const task = { id: 't', tenantId: 'default', agentId: 'a', type: 'health', name: 'og5 健康检查', config: HEALTH_TASK_TYPE.configSchema({}), enabled: true, requiresApproval: true, timeoutMs: 0 } as any;
  const prompt = await HEALTH_TASK_TYPE.buildPrompt(task, {} as any, ctx);
  assert.match(prompt, /health_collect/);
  assert.match(prompt, /逐字复制/);
  assert.match(prompt, /det\.worst 的映射/);
  assert.match(prompt, /data 结构/);
});

test('worstOf 取最差；12 个采集器齐备', () => {
  assert.equal(worstOf(['ok', 'notice', 'critical', 'warn']), 'critical');
  assert.equal(worstOf([]), 'ok');
  assert.equal(COLLECTORS.length, 12);
  assert.ok(THRESHOLDS.connRatio.critical > THRESHOLDS.connRatio.warn);
});

function nodeHealth(node: string, partial: Partial<NodeHealth>): NodeHealth {
  return { node, worst: 'ok', dims: [], findings: [], collectionNotes: [], settings: {}, ...partial };
}

test('analyzeCluster：共性聚类 + 配置漂移 + 最差上浮', () => {
  const mk = (node: string, level: 'warn' | 'ok', workMem: string): NodeHealth => nodeHealth(node, {
    worst: level,
    findings: level === 'warn' ? [{ dim: 'overview', code: 'CACHE_LOW', level: 'warn', metric: 'cache_hit_ratio', value: 0.93, threshold: '<0.95', evidence: '', detail: `${node} 命中率低` }] : [],
    settings: { work_mem: workMem, max_connections: '1000' },
  });
  const nodes = [mk('n1', 'warn', '64MB'), mk('n2', 'warn', '64MB'), mk('n3', 'ok', '4MB')];
  const cf = analyzeCluster(nodes);
  const common = cf.find((f) => f.code === 'COMMON_CACHE_LOW');
  assert.ok(common !== undefined, '2/3 命中同 code 应聚成共性');
  assert.deepEqual(common?.nodes, ['n1', 'n2']);
  const drift = cf.find((f) => f.code === 'SET_DRIFT' && f.item.includes('work_mem'));
  assert.ok(drift !== undefined, 'work_mem 漂移应被检出');
  assert.deepEqual(drift?.nodes, ['n3']);
  const worst = cf.find((f) => f.code === 'WORST_INSTANCE');
  assert.ok(worst !== undefined);
  assert.equal(analyzeCluster([nodes[0]]).length, 0, '单节点不做集群分析');
});

test('summarize：scope 判定与 counts', () => {
  const one = summarize([nodeHealth('og5', { worst: 'warn', findings: [{ dim: 'xact', code: 'XACT_LONG', level: 'warn', metric: 'xact_age_sec', value: 2000, threshold: '>=1800s', evidence: '', detail: '' }] })]);
  assert.equal(one.scope, 'instance');
  assert.equal(one.worst, 'warn');
  assert.equal(one.counts.warn, 1);
  const two = summarize([nodeHealth('a', {}), nodeHealth('b', {})]);
  assert.equal(two.scope, 'cluster');
  assert.equal(two.worst, 'ok');
});
