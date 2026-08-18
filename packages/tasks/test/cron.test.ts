import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, nextFire, isDue } from '../src/cron.ts';

const at = (s: string) => new Date(s);

test('parse: stars, lists, ranges, steps, dow 7→0', () => {
  const every = parseCron('* * * * *');
  assert.equal(every.min.size, 60);
  const s = parseCron('0,30 8-10 * * 1-5');
  assert.deepEqual([...s.min], [0, 30]);
  assert.deepEqual([...s.hour], [8, 9, 10]);
  const step = parseCron('*/15 * * * *');
  assert.deepEqual([...step.min], [0, 15, 30, 45]);
  const sun = parseCron('0 0 * * 7');
  assert.equal(sun.dow.has(0), true);
  assert.throws(() => parseCron('60 * * * *'), /超界/);
  assert.throws(() => parseCron('* * * *'), /5 个字段/);
  assert.throws(() => parseCron('a * * * *'), /不合法/);
});

test('nextFire: minute steps and daily schedule', () => {
  const spec = parseCron('*/15 * * * *');
  assert.equal(nextFire(spec, at('2026-08-18T08:00:00Z'))?.toISOString(), '2026-08-18T08:15:00.000Z');
  assert.equal(nextFire(spec, at('2026-08-18T08:59:10Z'))?.toISOString(), '2026-08-18T09:00:00.000Z');
  const daily = parseCron('0 8 * * *');
  assert.equal(nextFire(daily, at('2026-08-18T09:00:00Z'))?.toISOString(), '2026-08-19T08:00:00.000Z');
});

test('nextFire: dom/dow either-match semantics', () => {
  // the 1st of the month OR every Monday
  const spec = parseCron('0 0 1 * 1');
  assert.equal(nextFire(spec, at('2026-08-18T00:00:00Z'))?.toISOString(), '2026-08-24T00:00:00.000Z'); // Mon
  assert.equal(nextFire(spec, at('2026-08-29T00:00:00Z'))?.toISOString(), '2026-08-31T00:00:00.000Z'); // Mon before the 1st
});

test('isDue: never-fired anchors to 10min lookback; fired waits for next slot', () => {
  const now = at('2026-08-18T08:20:30Z');
  assert.equal(isDue('* * * * *', undefined, now), true);
  assert.equal(isDue('0 8 * * *', undefined, now), false);          // 08:00 was >10min ago
  assert.equal(isDue('15 8 * * *', undefined, now), true);          // 08:15 within lookback
  assert.equal(isDue('*/5 * * * *', at('2026-08-18T08:20:00Z'), now), false);
  assert.equal(isDue('*/5 * * * *', at('2026-08-18T08:15:00Z'), now), true);
});

test('tzOffsetMinutes: 0 8 * * * with +480 fires at 00:00 UTC (08:00 Beijing)', () => {
  const daily8 = parseCron('0 8 * * *');
  assert.equal(nextFire(daily8, at('2026-08-18T22:00:00Z'), 480)?.toISOString(), '2026-08-19T00:00:00.000Z');
  assert.equal(isDue('0 8 * * *', undefined, at('2026-08-19T00:05:00Z'), 480), true);
  assert.equal(isDue('0 8 * * *', undefined, at('2026-08-19T08:05:00Z'), 480), false);
});
