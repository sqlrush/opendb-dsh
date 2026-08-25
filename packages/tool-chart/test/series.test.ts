import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAsc, rate, ratioDelta, divDelta, divPoint, align, downsample, stats, type Pt } from '../src/series.ts';
import { resolveMetric, compute } from '../src/catalog.ts';

const T0 = 1_700_000_000_000;
const pt = (i: number, v: number): Pt => [T0 + i * 60_000, v];

test('toAsc：新→旧输入转为旧→新，丢非有限值', () => {
  const rows = [{ time: new Date(T0 + 120_000), value: 3 }, { time: new Date(T0), value: 1 }, { time: new Date(T0 + 60_000), value: Number.NaN }];
  assert.deepEqual(toAsc(rows), [[T0, 1], [T0 + 120_000, 3]]);
});

test('rate：累计计数器差分为每秒；计数器重置（负增量）与 Δt≤0 的点丢弃', () => {
  const pts: Pt[] = [pt(0, 0), pt(1, 6000), pt(2, 12000), pt(3, 100), pt(4, 6100)];
  const r = rate(pts);
  assert.deepEqual(r.map((p) => p[1]), [100, 100, 100]);   // 6000/60s = 100/s；第 3 点重置被跳过
  assert.equal(r[0][0], pt(1, 0)[0]);                        // 时间取区间右端
});

test('ratioDelta：Δa/(Δa+Δb)，两者都无增量的窗口跳过', () => {
  const hit: Pt[] = [pt(0, 0), pt(1, 90), pt(2, 90), pt(3, 180)];
  const read: Pt[] = [pt(0, 0), pt(1, 10), pt(2, 10), pt(3, 30)];
  const r = ratioDelta(hit, read);
  assert.equal(r.length, 2);
  assert.equal(r[0][1], 0.9);
  assert.equal(Math.round(r[1][1] * 100) / 100, 0.82);
});

test('divDelta / divPoint', () => {
  const elapse: Pt[] = [pt(0, 0), pt(1, 2_000_000)];   // µs
  const calls: Pt[] = [pt(0, 0), pt(1, 1000)];
  assert.deepEqual(divDelta(elapse, calls).map((p) => p[1]), [2000]);   // 2000µs/次
  const load: Pt[] = [pt(0, 9)]; const cpus: Pt[] = [pt(0, 18)];
  assert.deepEqual(divPoint(load, cpus).map((p) => p[1]), [0.5]);
});

test('align：容差内取最近点，超容差丢弃', () => {
  const a: Pt[] = [pt(0, 1), pt(1, 2)];
  const b: Pt[] = [[T0 + 5_000, 10], [T0 + 60_000 + 40_000, 20]];   // 第二点偏 40s > 30s 容差
  const al = align(a, b);
  assert.deepEqual(al, [[T0, 1, 10]]);
});

test('downsample：超过上限时按桶均值压缩，尖峰保留', () => {
  const pts: Pt[] = Array.from({ length: 1000 }, (_, i) => pt(i, i === 500 ? 1000 : 10));
  const d = downsample(pts, 120);
  assert.ok(d.length <= 120 + 60 && d.length < 1000, `压缩后 ${d.length} 点`);
  assert.equal(Math.max(...d.map((p) => p[1])), 1000);   // 尖峰没被抹平
  assert.equal(downsample(pts.slice(0, 50), 120).length, 50);   // 够少原样返回
});

test('stats：min/max/avg/last/n 与峰值时间', () => {
  const s = stats([pt(0, 1), pt(1, 5), pt(2, 3)]);
  assert.deepEqual([s.min, s.max, s.avg, s.last, s.n], [1, 5, 3, 3, 3]);
  assert.equal(s.maxAt, pt(1, 0)[0]);
});

test('catalog：别名解析、原始键回退、compute 按 kind 计算并缩放', () => {
  assert.equal(resolveMetric('TPS').key, 'tps');
  assert.equal(resolveMetric('连接占用率').key, 'connections');
  assert.equal(resolveMetric('缓存命中率').unit, 'ratio');
  const raw = resolveMetric('db.size_bytes.postgres');
  assert.equal(raw.kind, 'gauge'); assert.equal(raw.unit, 'bytes');
  // 原始键反查：模型传 db.connections_used_ratio 也要命中语义定义（带阈值映射与人读标签）
  const viaRaw = resolveMetric('db.connections_used_ratio');
  assert.equal(viaRaw.key, 'connections'); assert.equal(viaRaw.threshold?.group, 'connRatio');
  assert.equal(resolveMetric('db.sessions.active').key, 'active_sessions');
  const def = resolveMetric('avg_latency_ms');
  const out = compute(def, { 'db.stmt_elapse_us': [pt(0, 0), pt(1, 2_000_000)], 'db.stmt_calls': [pt(0, 0), pt(1, 1000)] });
  assert.deepEqual(out.map((p) => p[1]), [2]);   // 2000µs → 2ms
});
