/** Pure row→point/object mapping for one scrape round (unit-testable). */
import type { MetricPoint } from '@opendb-dsh/metrics-timescale';
import type { DictObject } from '@opendb-dsh/dictionary-pg';

export interface MetricRowLike { metric?: unknown; value?: unknown }
export interface DictRowLike { kind?: unknown; sch?: unknown; name?: unknown; signature?: unknown }

/** Keep only well-formed (metric, finite numeric value) rows; never throws on dirty data. */
export function rowsToPoints(nodeId: string, rows: readonly MetricRowLike[], time: Date): MetricPoint[] {
  const points: MetricPoint[] = [];
  for (const row of rows) {
    const metric = typeof row.metric === 'string' ? row.metric.trim() : '';
    const value = Number(row.value);
    if (metric === '' || !Number.isFinite(value)) continue;
    points.push({ time, nodeId, metric, value });
  }
  return points;
}

/** Keep only well-formed dictionary rows. */
export function rowsToDictObjects(rows: readonly DictRowLike[]): DictObject[] {
  const objects: DictObject[] = [];
  for (const row of rows) {
    if (typeof row.kind !== 'string' || typeof row.sch !== 'string' || typeof row.name !== 'string') continue;
    objects.push({ kind: row.kind, sch: row.sch, name: row.name, signature: typeof row.signature === 'string' ? row.signature : '' });
  }
  return objects;
}
