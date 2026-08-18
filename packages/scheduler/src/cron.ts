/**
 * Minimal 5-field cron (min hour dom mon dow), supporting `*`, lists `,`,
 * ranges `-`, and steps `/`. dow: 0-7 where 0 and 7 are Sunday. Times are UTC.
 * No external deps — small enough to own and unit-test exhaustively.
 */
export interface CronSpec { min: Set<number>; hour: Set<number>; dom: Set<number>; mon: Set<number>; dow: Set<number> }

const FIELDS: { key: keyof CronSpec; min: number; max: number }[] = [
  { key: 'min', min: 0, max: 59 },
  { key: 'hour', min: 0, max: 23 },
  { key: 'dom', min: 1, max: 31 },
  { key: 'mon', min: 1, max: 12 },
  { key: 'dow', min: 0, max: 7 },
];

function parseField(expr: string, lo: number, hi: number, label: string): Set<number> {
  const out = new Set<number>();
  for (const part of expr.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (m === null) throw new Error(`cron 字段 ${label} 不合法: "${part}"`);
    const step = m[2] !== undefined ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`cron 字段 ${label} 步长不合法: "${part}"`);
    let from = lo;
    let to = hi;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number);
      from = a;
      to = b ?? a;
      if (m[2] === undefined && b === undefined) to = a;   // plain number
      else if (b === undefined) to = hi;                   // "N/step" means N..hi
    }
    if (from < lo || to > hi || from > to) throw new Error(`cron 字段 ${label} 超界: "${part}" (允许 ${lo}-${hi})`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron 表达式必须是 5 个字段（分 时 日 月 周），got "${expr}"`);
  const spec = {} as CronSpec;
  for (let i = 0; i < 5; i += 1) {
    const f = FIELDS[i];
    spec[f.key] = parseField(parts[i], f.min, f.max, f.key);
  }
  if (spec.dow.has(7)) spec.dow.add(0);   // 7 == Sunday == 0
  return spec;
}

function matches(spec: CronSpec, d: Date): boolean {
  const domOk = spec.dom.has(d.getUTCDate());
  const dowOk = spec.dow.has(d.getUTCDay());
  // standard cron: if both dom and dow are restricted, either may match
  const domRestricted = spec.dom.size < 31;
  const dowRestricted = spec.dow.size < 8;
  const dayOk = domRestricted && dowRestricted ? (domOk || dowOk) : (domOk && dowOk);
  return spec.min.has(d.getUTCMinutes()) && spec.hour.has(d.getUTCHours()) && spec.mon.has(d.getUTCMonth() + 1) && dayOk;
}

/** First fire time strictly after `after` (UTC minute resolution; scans ≤ 366 days). */
export function nextFire(spec: CronSpec, after: Date): Date | undefined {
  const t = new Date(after);
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    if (matches(spec, t)) return new Date(t);
    t.setUTCMinutes(t.getUTCMinutes() + 1);
  }
  return undefined;
}

/** Whether a schedule with the given cron and last-fire time is due at `now`. */
export function isDue(expr: string, lastFiredAt: Date | undefined, now: Date): boolean {
  const spec = parseCron(expr);
  // never fired: due if any fire slot occurred in the last 10 minutes (avoid replaying history)
  const anchor = lastFiredAt ?? new Date(now.getTime() - 10 * 60_000);
  const next = nextFire(spec, anchor);
  return next !== undefined && next.getTime() <= now.getTime();
}
