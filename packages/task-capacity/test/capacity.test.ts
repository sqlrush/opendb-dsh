import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linearSlope, growthStats, daysToFull, findGaps, judgeCapacity, worstOf, countLevels, withCapThresholds, CAP_THRESHOLDS, CAP_THRESHOLD_SPECS, GIB } from '../src/capacity.ts';
import type { CapInput } from '../src/capacity.ts';

const H = 3600_000; const D = 24 * H;
const now = Date.parse('2026-08-31T02:12:00Z');

test('linearSlope：两点直线 / 单点为 0', () => {
  assert.equal(linearSlope([{ t: 0, bytes: 0 }, { t: D, bytes: GIB }]) * D, GIB);
  assert.equal(linearSlope([{ t: 5, bytes: 9 }]), 0);
});

test('growthStats：平直序列增速 ≈ 0，置信度按跨度与样本数', () => {
  const pts = Array.from({ length: 73 }, (_, i) => ({ t: now - 5 * D + i * H, bytes: 171e9 + (i % 3) * 1e8 }));
  const g = growthStats(pts, now, 7);
  assert.equal(g.points, 73);
  assert.ok(Math.abs(g.bytesPerDay) < 0.05 * GIB, `bytesPerDay=${g.bytesPerDay}`);
  assert.equal(g.confidence, 'high');
  assert.equal(g.resetAt, undefined);
});

test('growthStats：清理悬崖后只用其后的段，并标 resetAt', () => {
  const before = Array.from({ length: 48 }, (_, i) => ({ t: now - 3 * D + i * H, bytes: 171e9 }));
  const after = [{ t: now - 2 * H, bytes: 52e9 }, { t: now - H, bytes: 52.5e9 }, { t: now, bytes: 53e9 }];
  const g = growthStats([...before, ...after], now, 7);
  assert.equal(g.resetAt, now - 2 * H);
  assert.equal(g.points, 3);
  assert.ok(g.bytesPerDay > 0, '悬崖后的段是上升的');
  assert.equal(g.confidence, 'low');
});

test('growthStats：悬崖刚发生（之后只有 1 点）→ 退回悬崖前的段，置信度压为 low', () => {
  const before = Array.from({ length: 58 }, (_, i) => ({ t: now - 4 * D + i * H, bytes: 171e9 + (i % 2) * 1e8 }));
  const g = growthStats([...before, { t: now, bytes: 52e9 }], now, 7);
  assert.equal(g.segment, 'pre-reset');
  assert.equal(g.resetAt, now);
  assert.equal(g.points, 58);
  assert.ok(g.windowHours >= 56, `windowHours=${g.windowHours}`);
  assert.ok(Math.abs(g.bytesPerDay) < 0.2 * GIB);
  assert.equal(g.confidence, 'low');
});

test('growthStats：窗口外的点被剔除；单点无增速', () => {
  const g = growthStats([{ t: now - 30 * D, bytes: 1 }, { t: now, bytes: 2 }], now, 7);
  assert.equal(g.points, 1);
  assert.equal(g.bytesPerDay, 0);
});

test('daysToFull：低于门槛不外推；正常外推四舍五入', () => {
  assert.equal(daysToFull(277 * GIB, 0.03 * GIB, 0.1 * GIB), undefined);
  assert.equal(daysToFull(undefined, 5 * GIB, 0.1 * GIB), undefined);
  assert.equal(daysToFull(100 * GIB, 2 * GIB, 0.1 * GIB), 50);
});

test('findGaps：相邻间隔超过阈值即空窗', () => {
  const gaps = findGaps([{ t: 0, bytes: 1 }, { t: 2 * H, bytes: 1 }, { t: 50 * H, bytes: 1 }], 24);
  assert.deepEqual(gaps, [{ from: 2 * H, to: 50 * H }]);
});

const base = (): CapInput => ({
  disk: undefined,
  dbBytes: 52e9, dataDirBytes: 62e9, nonTableBytes: 28e9,
  growth: { points: 12, windowHours: 73, netBytes: 1e8, bytesPerDay: 0.03 * GIB, confidence: 'high' },
  daysToFull: undefined, gapHours: 41, firstRun: false, filesAvailable: true,
  sysTables: [{ name: 'pg_catalog.statement_history', bytes: 17.1e9, rows: 100_927 }],
  statsNever: { count: 42, maxRows: 33_554_475, top: ['gsbench.fact_sales', 'gsbench.plan_data'] },
  deadTop: [{ name: 'snapshot.snap_class_vital_info', ratio: 0.158, bytes: 1e8, dead: 69_768 }],
  wal: { segments: 528, bytes: 528 * 16 * 1024 * 1024, checkpointSegments: 256, slots: 0, slotsInactive: 0 },
  wdr: { enabled: true, bytes: 1.47e9, count: 192, oldestAgeDays: 8, retentionDays: 8 },
  log: { bytes: 0.6e9, files: 57, hasRetention: false, oldest: 'postgresql-2026-07-31_000000.log' },
});

test('judgeCapacity：og5 实况 → 膨胀 warn、从未 analyze warn、非表占用 notice、空窗 notice，其余 ok', () => {
  const f = judgeCapacity(base());
  const lv = Object.fromEntries(f.map((x) => [x.rule, x.level]));
  assert.equal(lv.CAP_STMT_HISTORY_BLOAT, 'warn');
  assert.equal(lv.CAP_STATS_NEVER, 'warn');
  assert.equal(lv.CAP_NONTABLE_SHARE, 'notice');
  assert.equal(lv.CAP_COLLECT_GAP, 'notice');
  assert.equal(lv.CAP_LOG_RETENTION, 'ok', '0.6 GB 未到 2 GB 门槛');
  assert.equal(lv.CAP_WAL_SIZE, 'ok');
  assert.equal(lv.CAP_WDR_RETENTION, 'ok');
  assert.equal(lv.CAP_DEAD_TUPLES, 'ok', '快照表 < 1 GB 不判');
  assert.equal(lv.CAP_DISK_FREE, 'ok');
  assert.equal(lv.CAP_GROWTH, 'ok');
  assert.equal(worstOf(f), 'warn');
  assert.deepEqual(countLevels(f), { ok: 6, notice: 2, warn: 2, critical: 0 });
  assert.equal(f[0].level, 'warn', '按级别降序');
});

test('judgeCapacity：磁盘 92% → warn；满盘 20 天 → warn；不活跃复制槽 → WAL warn；日志无策略且 3 GB → notice', () => {
  const i = base();
  i.disk = { totalBytes: 100 * GIB, usedBytes: 92 * GIB, availBytes: 8 * GIB };
  i.daysToFull = 20;
  i.wal = { ...i.wal, slots: 1, slotsInactive: 1 };
  i.log = { ...i.log, bytes: 3 * GIB };
  const lv = Object.fromEntries(judgeCapacity(i).map((x) => [x.rule, x.level]));
  assert.equal(lv.CAP_DISK_FREE, 'warn');
  assert.equal(lv.CAP_GROWTH, 'warn');
  assert.equal(lv.CAP_WAL_SIZE, 'warn');
  assert.equal(lv.CAP_LOG_RETENTION, 'notice');
});

test('judgeCapacity：首采不报空窗；死元组 45% 且 2 GB → warn；WDR 超期 → notice', () => {
  const i = base();
  i.firstRun = true; i.gapHours = 0;
  i.deadTop = [{ name: 'app.big', ratio: 0.45, bytes: 2 * GIB, dead: 9e6 }];
  i.wdr = { enabled: true, bytes: 1e9, count: 500, oldestAgeDays: 12, retentionDays: 8 };
  const lv = Object.fromEntries(judgeCapacity(i).map((x) => [x.rule, x.level]));
  assert.equal(lv.CAP_COLLECT_GAP, 'ok');
  assert.equal(lv.CAP_DEAD_TUPLES, 'warn');
  assert.equal(lv.CAP_WDR_RETENTION, 'notice');
});

test('judgeCapacity：文件级不可读（openGauss 非初始账号）→ WAL/日志按参数说明、非表占用注明未计入，均不误报', () => {
  const i = base();
  i.filesAvailable = false; i.wal = { ...i.wal, segments: 0, bytes: 0 }; i.log = { bytes: 0, files: 0, hasRetention: false };
  i.nonTableBytes = 17.2e9; i.dataDirBytes = 52e9;
  const f = judgeCapacity(i);
  const by = Object.fromEntries(f.map((x) => [x.rule, x]));
  assert.equal(by.CAP_WAL_SIZE.level, 'ok');
  assert.match(by.CAP_WAL_SIZE.problem, /需初始账号/);
  assert.match(by.CAP_WAL_SIZE.problem, /估上限 ≈ 12/);
  assert.equal(by.CAP_LOG_RETENTION.level, 'ok');
  assert.match(by.CAP_LOG_RETENTION.problem, /没有最长保留参数/);
  assert.equal(by.CAP_NONTABLE_SHARE.level, 'notice');
  assert.match(by.CAP_NONTABLE_SHARE.problem, /未计入/);
});

test('阈值覆盖：statsNeverRows 提到 1 亿后 og5 不再报 CAP_STATS_NEVER（判定在采集器，这里验证 withCapThresholds 路径与规格数）', () => {
  const T = withCapThresholds({ 'sysTableBloat.minBytes': 32 * GIB });
  assert.equal(T.sysTableBloat.minBytes, 32 * GIB);
  assert.equal(T.statsNeverRows, CAP_THRESHOLDS.statsNeverRows);
  const lv = Object.fromEntries(judgeCapacity(base(), T).map((x) => [x.rule, x.level]));
  assert.equal(lv.CAP_STMT_HISTORY_BLOAT, 'ok', '16 GB < 32 GB 门槛');
  assert.equal(CAP_THRESHOLD_SPECS.length, 18);
  assert.ok(CAP_THRESHOLD_SPECS.every((s) => s.plugin === 'capacity'));
});
