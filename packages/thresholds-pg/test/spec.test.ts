import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOverrides, flatten, specsFrom, validateMonotonic, validateRange, type ThresholdSpec } from '../src/spec.ts';

const DEFAULTS = {
  connRatio: { warn: 0.8, critical: 0.9 },
  cacheHit: { notice: 0.99, warn: 0.95 },
  bloatMinLive: 10000,
} as const;

const META = {
  connRatio: { label: '连接占用', rule: 'CONN_HIGH', cmp: '>=' as const, unit: 'ratio' as const, desc: 'x' },
  cacheHit: { label: '缓存命中率', rule: 'CACHE_LOW', cmp: '<' as const, unit: 'ratio' as const, desc: 'x' },
  bloatMinLive: { label: '膨胀扫描下限', rule: 'BLOAT', cmp: '>=' as const, unit: 'count' as const, desc: 'x' },
};

test('flatten：嵌套常量压成点路径，只收数值叶子', () => {
  assert.deepEqual(flatten(DEFAULTS), { 'connRatio.warn': 0.8, 'connRatio.critical': 0.9, 'cacheHit.notice': 0.99, 'cacheHit.warn': 0.95, bloatMinLive: 10000 });
});

test('applyOverrides：返回新对象、不动 defaults、未知路径忽略', () => {
  const next = applyOverrides(DEFAULTS, { 'connRatio.warn': 0.85, 'nope.x': 1, bloatMinLive: 5000 });
  assert.equal(next.connRatio.warn, 0.85);
  assert.equal(next.connRatio.critical, 0.9);
  assert.equal(next.bloatMinLive, 5000);
  assert.equal(DEFAULTS.connRatio.warn, 0.8);          // 原对象未被改
  assert.notEqual(next, DEFAULTS);
  assert.notEqual(next.connRatio, DEFAULTS.connRatio);  // 深拷贝
});

test('specsFrom：阶梯键带 group/tier，标量键不带；无元数据的键不进目录', () => {
  const specs = specsFrom('health', DEFAULTS, META);
  const warn = specs.find((s) => s.key === 'connRatio.warn');
  assert.ok(warn);
  assert.equal(warn.group, 'connRatio'); assert.equal(warn.tier, 'warn'); assert.equal(warn.label, '连接占用 · warn');
  const scalar = specs.find((s) => s.key === 'bloatMinLive');
  assert.ok(scalar); assert.equal(scalar.group, undefined); assert.equal(scalar.tier, undefined);
  assert.equal(specsFrom('health', DEFAULTS, { connRatio: META.connRatio }).length, 2);
});

test('validateRange：ratio 限 0~1，负数拒绝，非有限值拒绝', () => {
  const ratio = { unit: 'ratio' } as ThresholdSpec;
  assert.equal(validateRange(ratio, 0.5).ok, true);
  assert.equal(validateRange(ratio, 80).ok, false);
  assert.equal(validateRange({ unit: 'ms' } as ThresholdSpec, -1).ok, false);
  assert.equal(validateRange({ unit: 'count' } as ThresholdSpec, Number.NaN).ok, false);
  assert.equal(validateRange({ unit: 'hour' } as ThresholdSpec, 25).ok, false);
});

test('validateMonotonic：>= 阶梯递增、< 阶梯递减，越界拒绝', () => {
  const [, critical] = specsFrom('health', DEFAULTS, META).filter((s) => s.group === 'connRatio');
  // 把 critical 改到比 warn 还低 → 拒
  assert.equal(validateMonotonic(critical, 0.7, [{ tier: 'warn', value: 0.8 }]).ok, false);
  assert.equal(validateMonotonic(critical, 0.95, [{ tier: 'warn', value: 0.8 }]).ok, true);
  const cacheWarn = specsFrom('health', DEFAULTS, META).find((s) => s.key === 'cacheHit.warn')!;
  // cmp='<'：warn 必须 ≤ notice（越小越严重）；把 warn 改到 0.995 > notice 0.99 → 拒
  assert.equal(validateMonotonic(cacheWarn, 0.995, [{ tier: 'notice', value: 0.99 }]).ok, false);
  assert.equal(validateMonotonic(cacheWarn, 0.9, [{ tier: 'notice', value: 0.99 }]).ok, true);
});
