import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';
import { isDue } from './cron.ts';

export { parseCron, nextFire, isDue } from './cron.ts';

export interface ScheduleRecord {
  id: string; tenantId: string; agentId: string; name: string; cron: string; prompt: string;
  enabled: boolean; lastFiredAt?: Date; lastSessionId?: string;
}

declare module '@deepseek-ai/cordis' {
  interface Context { opendbScheduler: SchedulerService }
}

function row(r: any): ScheduleRecord {
  return {
    id: r.id, tenantId: r.tenant_id, agentId: r.agent_id, name: r.name, cron: r.cron, prompt: r.prompt,
    enabled: r.enabled, lastFiredAt: r.last_fired_at ?? undefined, lastSessionId: r.last_session_id ?? undefined,
  };
}

/**
 * ctx.opendbScheduler — cron schedules that open a fresh session for an agent and queue a
 * prompt at fire time (design §8 scheduler：cron → thread_queue). Runs inside the Host pod
 * and fires through the Host's own /api (session.create + session.prompt mode=queue), so a
 * scheduled run is indistinguishable from a user-initiated one downstream. A compare-and-swap
 * on last_fired_at makes firing idempotent across accidental double-schedulers.
 */
export default class SchedulerService extends Service {
  static inject = ['opendbRegistry'];
  static Config = z.object({
    connectionString: z.string().required(),
    baseUrl: z.string().default(''),
    tickMs: z.number().step(1).min(5000).default(30_000),
    defaultTenant: z.string().default('default'),
  });

  readonly pool: pg.Pool;
  private readonly registry: any;
  private readonly baseUrl: string;
  private readonly tenant: string;
  private readonly ready: Promise<void>;
  private ticking = false;

  constructor(ctx: Context, config: { connectionString: string; baseUrl?: string; tickMs?: number; defaultTenant?: string }) {
    super(ctx, 'opendbScheduler');
    this.registry = (ctx as any).opendbRegistry;
    this.pool = createPool(config.connectionString);
    this.baseUrl = (config.baseUrl ?? '') !== '' ? config.baseUrl! : `http://127.0.0.1:${process.env.OPENDB_HOST_PORT ?? '3080'}`;
    this.tenant = config.defaultTenant ?? 'default';
    this.ready = runMigrations(this.pool);
    this.ready.catch(() => { /* surfaced on first call */ });
    const tickMs = config.tickMs ?? 30_000;
    ctx.effect(() => {
      const timer = setInterval(() => { void this.tick(); }, tickMs);
      return () => clearInterval(timer);
    }, 'opendbScheduler.loop');
    ctx.effect(() => async () => { await this.ready.catch(() => {}); await this.pool.end(); }, 'opendbScheduler.pool');
  }

  // ---------------- CRUD (UI/W4 task plugins build on these)
  async create(input: { agentId: string; name: string; cron: string; prompt: string; enabled?: boolean }): Promise<ScheduleRecord> {
    await this.ready;
    isDue(input.cron, new Date(), new Date());   // validates the expression, throws early on bad cron
    const id = `sched-${randomUUID().slice(0, 8)}`;
    const r = await this.pool.query(
      `INSERT INTO dsh_schedules (id, tenant_id, agent_id, name, cron, prompt, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, this.tenant, input.agentId, input.name, input.cron, input.prompt, input.enabled ?? true],
    );
    return row(r.rows[0]);
  }
  async list(): Promise<ScheduleRecord[]> {
    await this.ready;
    const r = await this.pool.query('SELECT * FROM dsh_schedules WHERE tenant_id = $1 ORDER BY created_at', [this.tenant]);
    return r.rows.map(row);
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.ready;
    await this.pool.query('UPDATE dsh_schedules SET enabled = $2, updated_at = now() WHERE id = $1', [id, enabled]);
  }
  async remove(id: string): Promise<void> {
    await this.ready;
    await this.pool.query('DELETE FROM dsh_schedules WHERE id = $1', [id]);
  }

  // ---------------- firing
  /** One scheduler pass; exposed for tests and manual triggering. */
  async tick(now = new Date()): Promise<number> {
    if (this.ticking) return 0;   // re-entrancy guard: a slow fire must not stack ticks
    this.ticking = true;
    let fired = 0;
    try {
      await this.ready;
      const r = await this.pool.query('SELECT * FROM dsh_schedules WHERE tenant_id = $1 AND enabled', [this.tenant]);
      for (const raw of r.rows) {
        const s = row(raw);
        try {
          if (!isDue(s.cron, s.lastFiredAt, now)) continue;
          const claimed = await this.pool.query(
            `UPDATE dsh_schedules SET last_fired_at = $3, updated_at = now()
             WHERE id = $1 AND coalesce(last_fired_at, 'epoch'::timestamptz) = coalesce($2, 'epoch'::timestamptz)
             RETURNING id`,
            [s.id, s.lastFiredAt ?? null, now],
          );
          if (claimed.rowCount === 0) continue;   // another scheduler instance won the CAS
          const sessionId = await this.fire(s);
          await this.pool.query('UPDATE dsh_schedules SET last_session_id = $2 WHERE id = $1', [s.id, sessionId]);
          fired += 1;
          process.stderr.write(`[scheduler] fired "${s.name}" → ${sessionId}\n`);
        } catch (cause) {
          process.stderr.write(`[scheduler] "${s.name}" failed: ${String((cause as Error).message ?? cause)}\n`);
        }
      }
    } catch (cause) {
      process.stderr.write(`[scheduler] tick failed: ${String((cause as Error).message ?? cause)}\n`);
    } finally {
      this.ticking = false;
    }
    return fired;
  }

  /** Open a fresh session in the agent's workspace and queue the prompt (Host self /api). */
  private async fire(s: ScheduleRecord): Promise<string> {
    const agent = await this.registry.getAgent(s.agentId);
    if (agent === undefined) throw new Error(`agent ${s.agentId} 不存在`);
    const workspaces = await this.api('workspace.list', {});
    const ws = (workspaces.items ?? []).find((w: any) => typeof w.path === 'string' && new RegExp(`/agents/${agent.name}/?$`).test(w.path));
    if (ws === undefined) throw new Error(`agent「${agent.name}」没有对应工作区（先在控制台打开过一次即可创建）`);
    const created = await this.api('session.create', { workspaceId: ws.workspaceId });
    const sessionId = created.sessionId;
    if (typeof sessionId !== 'string') throw new Error('session.create 未返回 sessionId');
    await this.api('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: `【定时任务：${s.name}】\n${s.prompt}` }],
    });
    return sessionId;
  }

  private async api(method: string, payload: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: this.baseUrl },
      body: JSON.stringify({ type: 'client-request', rpcId: `sched-${randomUUID().slice(0, 8)}`, method, payload }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`${method} → HTTP ${res.status}`);
    const body = await res.json() as any;
    const result = body.result ?? body;
    if (result.ok === false) throw new Error(`${method} → ${result.error?.message ?? 'request failed'}`);
    return result.value ?? result;
  }
}
export { SchedulerService };
