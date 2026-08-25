import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createServer, type Server } from 'node:http';
import type pg from 'pg';
import { createPool, runMigrations, migrationFailures } from '@opendb-dsh/session-persistence-pg';
import { claimNext, heartbeat, markStale, pendingInterrupts, release, type Claimed } from './claim.ts';
import { PgUserQuestionProvider } from './questions-provider.ts';

/** 「拒绝认领」日志节流（每分钟一条），避免中毒期间每 2s 刷一行 */
let lastRefuseLog = 0;

/** pg DatabaseError 的关键字段一并打出来——2026-08-25 只打 String(err) 时，"deadlock detected" 六个字查了两小时 */
function describeError(err: unknown): string {
  const e = err as { message?: string; code?: string; detail?: string; hint?: string; where?: string; stack?: string };
  const parts = [String(e?.message ?? err)];
  if (e?.code) parts.push(`code=${e.code}`);
  if (e?.detail) parts.push(`detail=${e.detail}`);
  if (e?.hint) parts.push(`hint=${e.hint}`);
  if (e?.where) parts.push(`where=${String(e.where).slice(0, 200)}`);
  const stack = typeof e?.stack === 'string' ? e.stack.split('\n').slice(1, 4).map((s) => s.trim()).join(' <- ') : '';
  if (stack !== '') parts.push(`at ${stack}`);
  return parts.join(' | ');
}

export { claimNext, heartbeat, markStale, pendingInterrupts, release } from './claim.ts';
export { PgUserQuestionProvider } from './questions-provider.ts';

export interface RuntimeWorkerConfig {
  connectionString: string;
  runtimeClass: string;
  podName: string;
  pollMs: number;
  heartbeatMs: number;
  staleMs: number;
  healthPort: number;
  maxConcurrent: number;
}

interface AgentHandleLike {
  agent: {
    followup(message: unknown): void;
    session: { events: ReadonlyArray<{ type: string }> };
    whenIdle(): Promise<void>;
    cancel(cause: unknown, options?: unknown): void;
  };
  dispose(): Promise<void>;
}

/**
 * Runtime pod worker (design §9): sweep the PG queue for this runtime class, claim a turn,
 * resume the session with the REAL dsh agent loop, deliver the queued user message,
 * wait for idle, release. Heartbeats while running; marks stale threads; drains on dispose.
 */
export default class RuntimeWorker extends Service {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'userQuestions', 'opendbNotify'];   // notify：P3 即时唤醒（构造器读服务必须列 inject——W4 教训）
  static Config = z.object({
    connectionString: z.string().required(),
    runtimeClass: z.string().default('default'),
    podName: z.string().default(process.env.HOSTNAME ?? `runtime-${process.pid}`),
    pollMs: z.number().default(2000),
    heartbeatMs: z.number().default(5000),
    staleMs: z.number().default(30000),
    healthPort: z.number().default(9090),
    // 每 pod 并发 turn 上限：不设限会把整个队列瞬间吸干，队列深度归零 → KEDA 扩缩信号失真（W6 实测）
    maxConcurrent: z.number().default(2),
  });

  private stopping = false;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly pool: pg.Pool;
  private readonly server: Server;
  private ready: Promise<void> = Promise.resolve();

  private readonly config: RuntimeWorkerConfig;

  constructor(ctx: Context, config: RuntimeWorkerConfig) {
    super(ctx, 'runtimeWorker');
    this.config = config;
    this.pool = createPool(config.connectionString);
    const anyCtx = ctx as any;
    ctx.effect(() => anyCtx.userQuestions.registerProvider(new PgUserQuestionProvider(this.pool)), 'runtimeWorker.questions');
    this.server = createServer((_req, res) => {
      // 迁移失败 = 本进程某个 PG 服务的 ready 永久 rejected（2026-08-25 中毒 pod 事故）：
      // 回 503 让 livenessProbe 重启本 pod；readiness 单独摘端点拦不住自拉式认领
      res.statusCode = this.stopping || migrationFailures() > 0 ? 503 : 200;
      res.end(this.stopping ? 'draining' : 'ok');
    }).listen(config.healthPort);

    let timer: NodeJS.Timeout | undefined;
    ctx.effect(() => {
      const tick = async () => {
        if (this.stopping) return;
        try {
          await markStale(this.pool, this.config.staleMs);
          if (this.inFlight.size < this.config.maxConcurrent) {
            // 本进程有 PG 服务迁移失败时绝不认领：认领了也必失败，还会把用户消息吞掉
            //（队列行已 admitted 不再重投）。tick 照常跑（markStale 清扫不停），等 livenessProbe 重启本 pod
            if (migrationFailures() > 0) {
              if (Date.now() - lastRefuseLog > 60_000) {
                lastRefuseLog = Date.now();
                process.stderr.write(`[runtime-worker] refusing to claim: ${migrationFailures()} migration failure(s) in this process; health=503, awaiting restart\n`);
              }
            } else {
              const claimed = await claimNext(this.pool, this.config.runtimeClass, this.config.podName);
              if (claimed) {
                const p = this.run(claimed).finally(() => this.inFlight.delete(p));
                this.inFlight.add(p);
              }
            }
          }
        } catch (err) {
          process.stderr.write(`[runtime-worker] tick failed: ${String(err)}\n`);
        }
        if (!this.stopping) timer = setTimeout(tick, this.config.pollMs);
      };
      // P3 LISTEN/NOTIFY 即时唤醒：入队信号一到就把下一次 poll 提前到现在（200ms 节流；2s poll 保底）
      let lastKick = 0;
      const unsubscribe = anyCtx.opendbNotify !== undefined
        ? anyCtx.opendbNotify.subscribe('opendb_thread_wake', () => {
            const now = Date.now();
            if (now - lastKick < 200 || this.stopping) return;
            lastKick = now;
            if (timer !== undefined) clearTimeout(timer);
            void this.ready.then(tick).catch(() => {});
          })
        : undefined;
      this.ready = runMigrations(this.pool);
      this.ready.then(tick).catch((err) => process.stderr.write(`[runtime-worker] migrations failed: ${String(err)}\n`));
      return async () => {
        unsubscribe?.();
        // drain: stop claiming, wait for in-flight turns, then close resources
        this.stopping = true;
        if (timer) clearTimeout(timer);
        await Promise.allSettled([...this.inFlight]);
        this.server.close();
        await this.ready.catch(() => {});
        await this.pool.end();
      };
    }, 'runtimeWorker.loop');
  }

  private async run(claimed: Claimed): Promise<void> {
    const anyCtx = this.ctx as any;
    const { sessionId, payload } = claimed;
    const hb = setInterval(() => void heartbeat(this.pool, sessionId, this.config.podName), this.config.heartbeatMs);
    let handle: AgentHandleLike | undefined;
    try {
      const fallback = anyCtx.get('agentDefaultModel')?.currentSelection?.() ?? {};
      const agentOptions = payload.agentOptions?.provider && payload.agentOptions?.model ? payload.agentOptions : { provider: fallback.provider, model: fallback.model };
      handle = (await anyCtx.agents.resume({ resumeSessionId: sessionId, agentOptions })) as AgentHandleLike;
      process.stderr.write(`[runtime-worker] claimed ${sessionId} (queue ${claimed.queueId}) on ${this.config.podName}\n`);
      const agent = handle.agent;
      const interruptPoll = setInterval(() => {
        void pendingInterrupts(this.pool, sessionId).then((n) => { if (n > 0) agent.cancel({ kind: 'user' }); });
      }, 1000);
      try {
        agent.followup(createUserMessage({ content: payload.content as any, source: payload.source as any } as any));
        await agent.whenIdle();
        // dsh appends turn/end after the (async) agent/turn-stopping hooks, which can be after status→idle: wait for the log to close the turn
        const t0 = Date.now();
        while (!turnClosed(agent.session.events) && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 50));
        if (!turnClosed(agent.session.events)) process.stderr.write(`[runtime-worker] WARN turn still open after 60s for ${sessionId}; releasing anyway\n`);
        await (anyCtx.sessions?.flush?.(agent.session) ?? Promise.resolve());   // durability checkpoint: the last write-behind batch (turn/end) reaches PG before release
      } finally {
        clearInterval(interruptPoll);
      }
      await release(this.pool, sessionId, this.config.podName, 'idle');
      process.stderr.write(`[runtime-worker] released ${sessionId} idle\n`);
    } catch (err) {
      process.stderr.write(`[runtime-worker] run failed for ${sessionId}: ${describeError(err)}\n`);
      await release(this.pool, sessionId, this.config.podName, 'interrupted');
    } finally {
      clearInterval(hb);
      await handle?.dispose().catch(() => {});
    }
  }
}

export { RuntimeWorker };

/** True when the last opened turn in the log has been closed by a turn/end. */
export function turnClosed(events: ReadonlyArray<{ type: string }>): boolean {
  let open = false;
  for (const e of events) {
    if (e.type === 'turn/start') open = true;
    else if (e.type === 'turn/end') open = false;
  }
  return !open;
}
