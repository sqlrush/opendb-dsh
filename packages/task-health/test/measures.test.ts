import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichDim } from '../src/measures.ts';
import { THRESHOLDS, type DimResult } from '../src/collectors.ts';

const dim = (d: string, evidence: Record<string, unknown>, findings: DimResult['findings'] = []): DimResult => ({ dim: d, title: d, ok: true, findings, evidence });

test('connections: ratio is judged against the effective tiers and explained; states become a pie', () => {
  const { measures, charts } = enrichDim(dim('connections', { used: 85, max: 100, ratio: 0.85, states: { active: 5, idle: 80 } }), THRESHOLDS);
  const ratio = measures.find((m) => m.key === 'connRatio');
  assert.ok(ratio);
  assert.equal(ratio.level, 'warn', '0.85 >= warn 0.8 and < critical 0.9');
  assert.equal(ratio.rule?.cmp, '>=');
  assert.deepEqual(ratio.rule?.tiers, { warn: 0.8, critical: 0.9 });
  assert.match(ratio.why, /85% >= 80%/);
  assert.match(ratio.why, /告警/);
  assert.ok(charts.some((c) => c.kind === 'gauge' && c.key === 'conn_ratio'));
  const pie = charts.find((c) => c.key === 'conn_states');
  assert.deepEqual(pie?.items, [{ name: 'active', value: 5 }, { name: 'idle', value: 80 }]);
});

test('cache hit uses the "<" direction: 0.999 ok, 0.98 notice, 0.90 warn', () => {
  const at = (v: number) => enrichDim(dim('overview', { cacheHitRatio: v, dbBytes: [] }), THRESHOLDS).measures.find((m) => m.key === 'cacheHit')!.level;
  assert.equal(at(0.999), 'ok');
  assert.equal(at(0.98), 'notice');
  assert.equal(at(0.9), 'warn');
});

test('platform overrides change the ladder text and the verdict', () => {
  const T = { ...THRESHOLDS, connRatio: { warn: 0.6, critical: 0.7 } };
  const m = enrichDim(dim('connections', { used: 65, max: 100, ratio: 0.65 }), T).measures.find((x) => x.key === 'connRatio')!;
  assert.equal(m.level, 'warn');
  assert.match(m.why, /60%/);
});

test('waits: top share + pie of the top events; os: load per core and iowait judged', () => {
  const w = enrichDim(dim('waits', { top: [{ event: 'WALFlushWait', totalWait: 60 }, { event: 'DataFileRead', totalWait: 40 }] }), THRESHOLDS);
  const share = w.measures.find((m) => m.key === 'waitTopShare')!;
  assert.equal(share.value, 0.6);
  assert.equal(share.level, 'notice', '0.6 >= notice 0.4');
  assert.equal(w.charts[0].kind, 'pie');
  const os = enrichDim(dim('os', { load: 36, cpus: 18, loadPerCore: 2, cpuUsedRatioCumulative: 0.1, iowaitShare: 0.05, memoryBytes: 1 }), THRESHOLDS);
  assert.equal(os.measures.find((m) => m.key === 'loadPerCore')!.level, 'critical');
  assert.equal(os.measures.find((m) => m.key === 'iowaitShare')!.level, 'ok');
});

test('a degraded dimension (collection note) yields no measures; unknown dims are tolerated', () => {
  assert.deepEqual(enrichDim(dim('os', { note: 'os_runtime 不可读' }), THRESHOLDS).measures, []);
  assert.deepEqual(enrichDim(dim('future-dim', {}), THRESHOLDS), { measures: [], charts: [] });
});
