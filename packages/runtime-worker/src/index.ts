import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createServer, type Server } from 'node:http';
import type pg from 'pg';
import { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';
import { claimNext, heartbeat, markStale, pendingInterrupts, release, type Claimed } from './claim.ts';
import { PgUserQuestionProvider } from './questions-provider.ts';

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
}

interface AgentHandleLike {
  agent: {
    followup(message: unknown): void;
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
  static inject = ['agents', 'sessionPersistence', 'userQuestions'];
  static Config = z.object({
    connectionString: z.string().required(),
    runtimeClass: z.string().default('default'),
    podName: z.string().default(process.env.HOSTNAME ?? `runtime-${process.pid}`),
    pollMs: z.number().default(2000),
    heartbeatMs: z.number().default(5000),
    staleMs: z.number().default(30000),
    healthPort: z.number().default(9090),
  });

  private stopping = false;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly pool: pg.Pool;
  private readonly server: Server;
  private ready: Promise<void> = Promise.resolve();

  constructor(ctx: Context, private readonly config: RuntimeWorkerConfig) {
    super(ctx, 'runtimeWorker');
    this.pool = createPool(config.connectionString);
    const anyCtx = ctx as any;
    ctx.effect(() => anyCtx.userQuestions.registerProvider(new PgUserQuestionProvider(this.pool)), 'runtimeWorker.questions');
    this.server = createServer((_req, res) => {
      res.statusCode = this.stopping ? 503 : 200;
      res.end(this.stopping ? 'draining' : 'ok');
    }).listen(config.healthPort);

    let timer: NodeJS.Timeout | undefined;
    ctx.effect(() => {
      const tick = async () => {
        if (this.stopping) return;
        try {
          await markStale(this.pool, this.config.staleMs);
          const claimed = await claimNext(this.pool, this.config.runtimeClass, this.config.podName);
          if (claimed) {
            const p = this.run(claimed).finally(() => this.inFlight.delete(p));
            this.inFlight.add(p);
          }
        } catch (err) {
          anyCtx.logger?.warn?.('runtime-worker tick failed: %s', String(err));
        }
        if (!this.stopping) timer = setTimeout(tick, this.config.pollMs);
      };
      this.ready = runMigrations(this.pool);
      this.ready.then(tick).catch((err) => anyCtx.logger?.error?.('runtime-worker migrations failed: %s', String(err)));
      return async () => {
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
      handle = (await anyCtx.agents.resume({ resumeSessionId: sessionId })) as AgentHandleLike;
      const agent = handle.agent;
      const interruptPoll = setInterval(() => {
        void pendingInterrupts(this.pool, sessionId).then((n) => { if (n > 0) agent.cancel({ kind: 'user' }); });
      }, 1000);
      try {
        agent.followup(createUserMessage({ content: payload.content as any, source: payload.source as any } as any));
        await agent.whenIdle();
      } finally {
        clearInterval(interruptPoll);
      }
      await release(this.pool, sessionId, this.config.podName, 'idle');
    } catch (err) {
      anyCtx.logger?.error?.('runtime-worker run failed for %s: %s', sessionId, String(err));
      await release(this.pool, sessionId, this.config.podName, 'interrupted');
    } finally {
      clearInterval(hb);
      await handle?.dispose().catch(() => {});
    }
  }
}

export { RuntimeWorker };
