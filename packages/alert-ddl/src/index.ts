import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type pg from 'pg';
import { createPool } from '@opendb-dsh/session-persistence-pg';

export const name = 'alert-ddl';
export const inject = ['opendbDictionary', 'opendbRegistry', 'opendbTasks'];
export const Config = z.object({
  connectionString: z.string().required(),
  pollMs: z.number().default(60_000).description('扫描新字典变更的周期'),
  cooldownMs: z.number().default(15 * 60_000).description('同一 agent 两次告警触发的最小间隔（避免变更风暴刷屏）'),
});

interface AlertDdlConfig { connectionString: string; pollMs: number; cooldownMs: number }

/**
 * DDL 变更告警（P2 W1，事件驱动运维）：按时间水位扫描 opendb_dict_changes（collector 每 10 分钟
 * 快照 diff 产出），发现新变更 → 按节点归属的 agent 分组 → 触发该 agent 的 incident 任务
 * （trigger_kind='alert'，经任务引擎正常拾取开会话诊断）。
 * - agent 没有 incident 任务时自动创建一个（enabled、无 cron——纯事件驱动；策略调整在会话里说）。
 * - 冷却窗口内不重复触发；已有 queued/running 的 incident run 也不再叠加。
 * - 水位持久化在 opendb_alert_state（Host 单副本，无并发争用；重启从上次水位继续，不漏不重）。
 */
export function apply(ctx: Context, config: AlertDdlConfig): void {
  const anyCtx = ctx as any;
  const dictionary = anyCtx.opendbDictionary;
  const registry = anyCtx.opendbRegistry;
  const tasks = anyCtx.opendbTasks;
  const pool: pg.Pool = createPool(config.connectionString);

  const ready = pool.query(
    `CREATE TABLE IF NOT EXISTS opendb_alert_state (
       alert_kind text PRIMARY KEY,
       watermark  timestamptz NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`,
  ).then(async () => {
    // 首次安装：水位=现在（存量历史变更不告警，只看今后）
    await pool.query(
      `INSERT INTO opendb_alert_state (alert_kind, watermark) VALUES ('ddl', now()) ON CONFLICT DO NOTHING`,
    );
  });
  ready.catch((cause) => process.stderr.write(`[alert-ddl] init failed: ${String(cause)}\n`));

  const lastFired = new Map<string, number>();   // agentId → epoch ms（进程内冷却；重启后靠 queued 判重兜底）

  async function tick(): Promise<void> {
    await ready;
    const wm = await pool.query(`SELECT watermark FROM opendb_alert_state WHERE alert_kind = 'ddl'`);
    const watermark: Date = wm.rows[0].watermark;
    // dictionary.changes 只有 sinceHours 粒度：取宽窗口再按精确水位过滤（变更量小，客侧过滤足够）
    const sinceHours = Math.max(1, Math.ceil((Date.now() - watermark.getTime()) / 3_600_000) + 1);
    const changes: any[] = await dictionary.changes({ sinceHours, limit: 500 });
    const fresh = changes.filter((c: any) => new Date(c.time).getTime() > watermark.getTime());
    if (fresh.length === 0) return;

    const nodes: any[] = await registry.listNodes({});
    const nodeAgent = new Map<string, string>(nodes.filter((n: any) => n.agentId).map((n: any) => [n.id, n.agentId]));
    const byAgent = new Map<string, any[]>();
    for (const c of fresh) {
      const agentId = nodeAgent.get(c.nodeId);
      if (agentId === undefined) continue;
      (byAgent.get(agentId) ?? byAgent.set(agentId, []).get(agentId))!.push(c);
    }

    const allTasks: any[] = await tasks.listTasks();
    for (const [agentId, agentChanges] of byAgent) {
      const last = lastFired.get(agentId) ?? 0;
      if (Date.now() - last < config.cooldownMs) continue;
      let task = allTasks.find((t: any) => t.agentId === agentId && t.type === 'incident' && t.enabled);
      if (task === undefined) {
        const agent = await registry.getAgent?.(agentId) ?? { name: agentId };
        task = await tasks.createTask({
          agentId, type: 'incident', name: `${agent.name ?? agentId}DDL事故响应`,
          config: { lookbackMinutes: 120, focus: '' }, enabled: true,
        });
        process.stderr.write(`[alert-ddl] bootstrapped incident task for agent ${agentId}\n`);
      }
      // 已在排队/运行的 incident run 不叠加（本次变更会被该会话的 lookback 覆盖）
      const runs: any[] = await tasks.listRuns({ taskId: task.id, limit: 5 });
      if (runs.some((r: any) => r.status === 'queued' || r.status === 'running')) continue;
      await tasks.runNow(task.id, 'alert');
      lastFired.set(agentId, Date.now());
      process.stderr.write(`[alert-ddl] fired incident for agent ${agentId}: ${agentChanges.length} fresh DDL change(s)\n`);
    }

    const maxTime = fresh.reduce((m: number, c: any) => Math.max(m, new Date(c.time).getTime()), watermark.getTime());
    await pool.query(`UPDATE opendb_alert_state SET watermark = $1, updated_at = now() WHERE alert_kind = 'ddl'`, [new Date(maxTime)]);
  }

  let timer: NodeJS.Timeout | undefined;
  ctx.effect(() => {
    const loop = async () => {
      try { await tick(); } catch (cause) {
        process.stderr.write(`[alert-ddl] tick failed: ${String((cause as Error).message ?? cause)}\n`);
      }
      timer = setTimeout(loop, config.pollMs);
    };
    void loop();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      void pool.end();
    };
  }, 'alert-ddl.loop');
}
