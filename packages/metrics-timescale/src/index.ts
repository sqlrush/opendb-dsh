import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import type pg from 'pg';
import { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';

export interface MetricPoint { time?: Date; tenantId?: string; nodeId: string; metric: string; value: number }
export interface MetricRow { time: Date; nodeId: string; metric: string; value: number }

declare module '@deepseek-ai/cordis' {
  interface Context { opendbMetrics: MetricsService }
}

/** Batched multi-row INSERT (immutable input; caller keeps ownership of points). */
export function buildInsert(points: readonly MetricPoint[]): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const tuples = points.map((p) => {
    values.push(p.time ?? new Date(), p.tenantId ?? 'default', p.nodeId, p.metric, p.value);
    const base = values.length - 5;
    return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`;
  });
  return { text: `INSERT INTO opendb_metrics (time, tenant_id, node_id, metric, value) VALUES ${tuples.join(',')}`, values };
}

/**
 * ctx.opendbMetrics — time-series storage for managed-node metrics (design §5 记忆分层:
 * TimescaleDB). Runs on the platform PG; on startup it tries to convert opendb_metrics
 * into a hypertable (single statements — timescaledb refuses to run inside the migration's
 * implicit multi-statement transaction) and silently stays on a plain table without the
 * extension, so dev environments on vanilla PostgreSQL keep working.
 */
export default class MetricsService extends Service {
  static Config = z.object({
    connectionString: z.string().required(),
    retentionDays: z.number().step(1).min(1).default(30),
  });
  readonly pool: pg.Pool;
  private readonly ready: Promise<void>;
  private readonly retentionDays: number;
  hypertable = false;

  constructor(ctx: Context, config: { connectionString: string; retentionDays?: number }) {
    super(ctx, 'opendbMetrics');
    this.pool = createPool(config.connectionString);
    this.retentionDays = config.retentionDays ?? 30;
    this.ready = this.setup();
    this.ready.catch(() => { /* surfaced on first call */ });
    ctx.effect(() => async () => { await this.ready.catch(() => {}); await this.pool.end(); }, 'opendbMetrics.pool');
  }

  private async setup(): Promise<void> {
    await runMigrations(this.pool);
    try {
      await this.pool.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
      await this.pool.query("SELECT create_hypertable('opendb_metrics', 'time', if_not_exists => true, migrate_data => true)");
      this.hypertable = true;
    } catch (cause) {
      process.stderr.write(`[opendb-metrics] timescaledb unavailable, staying on plain table: ${String((cause as Error).message)}\n`);
    }
  }

  async record(points: readonly MetricPoint[]): Promise<void> {
    if (points.length === 0) return;
    await this.ready;
    const { text, values } = buildInsert(points);
    await this.pool.query(text, values);
  }

  /** Latest value per metric for a node (tool/UI display). */
  async latest(nodeId: string, metricPrefix = ''): Promise<MetricRow[]> {
    await this.ready;
    const r = await this.pool.query(
      `SELECT DISTINCT ON (metric) time, node_id, metric, value FROM opendb_metrics
       WHERE node_id = $1 AND metric LIKE $2 || '%' ORDER BY metric, time DESC`,
      [nodeId, metricPrefix],
    );
    return r.rows.map((row) => ({ time: row.time, nodeId: row.node_id, metric: row.metric, value: Number(row.value) }));
  }

  /**
   * 舰队聚合（W6 规模巡检）：一次 SQL 汇总一批节点最近 5 分钟的最新指标——
   * 每指标 min/avg/max、按指标取值 Top-N 节点、采集覆盖数。950 节点也只是一次查询。
   */
  async fleetOverview(nodeIds: string[], topMetrics: string[], topN = 15): Promise<{
    covered: number;
    agg: { metric: string; n: number; avg: number; max: number; min: number }[];
    top: { nodeId: string; metric: string; value: number }[];
    coveredIds: string[];
  }> {
    await this.ready;
    const agg = await this.pool.query(
      `WITH latest AS (
         SELECT DISTINCT ON (node_id, metric) node_id, metric, value FROM opendb_metrics
          WHERE node_id = ANY($1) AND time > now() - interval '5 minutes'
          ORDER BY node_id, metric, time DESC)
       SELECT metric, count(*) AS n, avg(value) AS avg, max(value) AS max, min(value) AS min
         FROM latest GROUP BY metric ORDER BY metric`,
      [nodeIds],
    );
    const top = await this.pool.query(
      `WITH latest AS (
         SELECT DISTINCT ON (node_id, metric) node_id, metric, value FROM opendb_metrics
          WHERE node_id = ANY($1) AND metric = ANY($2) AND time > now() - interval '5 minutes'
          ORDER BY node_id, metric, time DESC)
       SELECT node_id, metric, value FROM latest WHERE value > 0 ORDER BY value DESC LIMIT $3`,
      [nodeIds, topMetrics, topN],
    );
    const covered = await this.pool.query(
      `SELECT DISTINCT node_id FROM opendb_metrics
        WHERE node_id = ANY($1) AND time > now() - interval '5 minutes'`,
      [nodeIds],
    );
    return {
      covered: covered.rowCount ?? 0,
      coveredIds: covered.rows.map((r) => r.node_id),
      agg: agg.rows.map((r) => ({ metric: r.metric, n: Number(r.n), avg: Number(r.avg), max: Number(r.max), min: Number(r.min) })),
      top: top.rows.map((r) => ({ nodeId: r.node_id, metric: r.metric, value: Number(r.value) })),
    };
  }

  /** Raw recent points for one metric (newest first, capped). */
  async recent(nodeId: string, metric: string, minutes = 60, limit = 500): Promise<MetricRow[]> {
    await this.ready;
    const r = await this.pool.query(
      `SELECT time, node_id, metric, value FROM opendb_metrics
       WHERE node_id = $1 AND metric = $2 AND time > now() - ($3 || ' minutes')::interval
       ORDER BY time DESC LIMIT $4`,
      [nodeId, metric, String(Math.max(1, minutes)), limit],
    );
    return r.rows.map((row) => ({ time: row.time, nodeId: row.node_id, metric: row.metric, value: Number(row.value) }));
  }

  /** Drop points older than the retention window (called by the collector's housekeeping). */
  async prune(): Promise<number> {
    await this.ready;
    const r = await this.pool.query(`DELETE FROM opendb_metrics WHERE time < now() - ($1 || ' days')::interval`, [String(this.retentionDays)]);
    return r.rowCount ?? 0;
  }
}
export { MetricsService };
