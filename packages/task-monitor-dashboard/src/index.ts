import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type pg from 'pg';
import { createPool } from '@opendb-dsh/session-persistence-pg';
import type { TaskType, TaskRecord, TaskBuildContext } from '@opendb-dsh/tasks';

export const name = 'task-monitor-dashboard';
export const inject = ['opendbTasks'];
export const Config = z.object({
  connectionString: z.string().default('').description('快照存储；空 = 本侧不承担存储/RPC（Runtime 侧只挂类型元数据）'),
});

interface MonitorConfig {
  intervalSeconds: number;
  connWarn: number; connCritical: number;
  locksWarn: number; locksCritical: number;
  coverageWarn: number;
}

const SNAPSHOT_METRICS = ['db.connections_used_ratio', 'db.waiting_locks', 'db.sessions.active', 'db.sessions.total'];

/**
 * 常驻监控大盘（P2 W2，runMode:'service' 首个实践）：不走 LLM——任务 enabled 期间引擎在 Host
 * 内常驻运行本实例：每 intervalSeconds 聚合一次舰队指标 → 阈值判定 → 写状态快照（自有表
 * opendb_monitor_snapshots，域数据域内管）。client 半边经 /opendb-monitor 通道读快照渲染实时大盘。
 */
export function makeMonitorTaskType(pool: pg.Pool | undefined): TaskType<MonitorConfig> {
  return {
    key: 'monitor-dashboard',
    title: '常驻监控大盘',
    runMode: 'service',
    report: 'none',
    configSchema: z.object({
      intervalSeconds: z.number().min(15).default(60).description('快照周期（秒）'),
      connWarn: z.number().default(0.7).description('连接使用率 warn 阈值'),
      connCritical: z.number().default(0.9).description('连接使用率 critical 阈值'),
      locksWarn: z.number().default(1).description('等待锁 warn 阈值（任一节点达到即告警）'),
      locksCritical: z.number().default(10).description('等待锁 critical 阈值'),
      coverageWarn: z.number().default(0.95).description('采集覆盖率低于此值 = warn'),
    }),
    reportSchema: z.object({}),
    async buildPrompt(): Promise<string> {
      return 'service 型任务不经会话运行（enabled 即常驻监控，调整阈值请在会话里改任务配置）。';
    },
    async startService(task: TaskRecord<MonitorConfig>, ctx: TaskBuildContext): Promise<() => void> {
      if (pool === undefined) return () => {};   // Runtime 侧无存储：类型元数据仅供 UI/校验
      if (ctx.fleetOverview === undefined) throw new Error('metrics 服务缺失：monitor-dashboard 需要 fleetOverview');
      await pool.query(
        `CREATE TABLE IF NOT EXISTS opendb_monitor_snapshots (
           task_id text NOT NULL,
           time timestamptz NOT NULL DEFAULT now(),
           status text NOT NULL,
           data jsonb NOT NULL,
           PRIMARY KEY (task_id, time)
         )`,
      );
      const c = task.config;
      const sweep = async (): Promise<void> => {
        const nodes = await ctx.nodesOf(task.agentId);
        if (nodes.length === 0) return;
        const ov = await ctx.fleetOverview!(nodes.map((n) => n.id), SNAPSHOT_METRICS, 8);
        const coverage = nodes.length > 0 ? ov.covered / nodes.length : 1;
        const maxOf = (metric: string) => ov.agg.find((a) => a.metric === metric)?.max ?? 0;
        const conn = maxOf('db.connections_used_ratio');
        const locks = maxOf('db.waiting_locks');
        const problems: { item: string; level: 'warn' | 'critical'; detail: string }[] = [];
        if (coverage < c.coverageWarn) problems.push({ item: 'coverage', level: 'warn', detail: `采集覆盖率 ${(coverage * 100).toFixed(1)}%（${ov.covered}/${nodes.length}）` });
        if (conn >= c.connCritical) problems.push({ item: 'connections', level: 'critical', detail: `连接使用率峰值 ${(conn * 100).toFixed(1)}%` });
        else if (conn >= c.connWarn) problems.push({ item: 'connections', level: 'warn', detail: `连接使用率峰值 ${(conn * 100).toFixed(1)}%` });
        if (locks >= c.locksCritical) problems.push({ item: 'locks', level: 'critical', detail: `等待锁峰值 ${locks}` });
        else if (locks >= c.locksWarn) problems.push({ item: 'locks', level: 'warn', detail: `等待锁峰值 ${locks}` });
        const status = problems.some((p) => p.level === 'critical') ? 'critical' : problems.length > 0 ? 'warn' : 'ok';
        const byId = new Map(nodes.map((n) => [n.id, n.name]));
        await pool.query(
          `INSERT INTO opendb_monitor_snapshots (task_id, status, data) VALUES ($1, $2, $3)`,
          [task.id, status, JSON.stringify({
            nodes: nodes.length, covered: ov.covered, coverage,
            agg: ov.agg, problems,
            top: ov.top.map((t) => ({ node: byId.get(t.nodeId) ?? t.nodeId, metric: t.metric, value: t.value })),
            thresholds: { connWarn: c.connWarn, connCritical: c.connCritical, locksWarn: c.locksWarn, locksCritical: c.locksCritical, coverageWarn: c.coverageWarn },
          })],
        );
        await pool.query(`DELETE FROM opendb_monitor_snapshots WHERE task_id = $1 AND time < now() - interval '48 hours'`, [task.id]);
      };
      await sweep().catch((cause) => process.stderr.write(`[monitor-dashboard] first sweep failed: ${String((cause as Error).message ?? cause)}\n`));
      const timer = setInterval(() => {
        void sweep().catch((cause) => process.stderr.write(`[monitor-dashboard] sweep failed: ${String((cause as Error).message ?? cause)}\n`));
      }, Math.max(15, c.intervalSeconds) * 1000);
      return () => clearInterval(timer);
    },
  };
}

export function apply(ctx: Context, config: { connectionString?: string } = {}): void {
  const anyCtx = ctx as any;
  const hasStore = (config.connectionString ?? '') !== '';
  const pool: pg.Pool | undefined = hasStore ? createPool(config.connectionString!) : undefined;
  if (pool !== undefined) ctx.effect(() => () => { void pool.end(); }, 'monitor-dashboard.pool');

  ctx.effect(() => anyCtx.opendbTasks.register(makeMonitorTaskType(pool)), 'monitor-dashboard.type');

  // RPC 半边（Host 才有 connection；function plugin 顶层 inject——服务缺失侧静默不激活）
  anyCtx.inject(['connection'], (c: any) => {
    if (pool === undefined) return;
    c.effect(() => c.connection.rpc.handle('/opendb-monitor', async (endpoint: string, payload: any): Promise<any> => {
      try {
        if (endpoint !== 'snapshot') return { ok: false, error: { code: 'bad-request', message: `unknown endpoint ${endpoint}`, details: {} } };
        const taskId = String(payload?.taskId ?? '');
        const latest = await pool.query(
          `SELECT time, status, data FROM opendb_monitor_snapshots WHERE task_id = $1 ORDER BY time DESC LIMIT 1`, [taskId]);
        const history = await pool.query(
          `SELECT time, status FROM opendb_monitor_snapshots WHERE task_id = $1 AND time > now() - interval '24 hours' ORDER BY time`, [taskId]);
        return {
          ok: true,
          value: {
            latest: latest.rows[0] ?? null,
            history: history.rows.map((r) => ({ time: r.time, status: r.status })),
          },
        };
      } catch (cause) {
        return { ok: false, error: { code: 'internal', message: String((cause as Error).message ?? cause), details: {} } };
      }
    }, { authority: 'trusted-host' }), 'monitor-dashboard.rpc');
  });
}
