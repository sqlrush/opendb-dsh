import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import { emitAgentEvent } from '@deepseek-ai/dsh-agent';
import type pg from 'pg';
import { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';
import { ProxyAgent } from './proxy-agent.ts';
import { ensureThread } from './queue.ts';
import { trace } from './debug.ts';

export { ProxyAgent } from './proxy-agent.ts';
export { QueueInbox, projectQueue, queueFrameItems } from './queue-inbox.ts';
export {
  ensureThread, enqueue, interrupt, threadStatus, pendingQueue, openRows, removePending, replacePending,
  settleDurable, unreportedFailures, markReported, reapStaleThread,
} from './queue.ts';
export { mirrorOnce, bridgeQuestionsOnce } from './tailer.ts';

export interface DispatchConfig { connectionString: string; runtimeClass: string; tailMs: number; staleMs: number }

/**
 * Replaces `dsh-agent-loop` in the Host process: an AgentFactory whose agents are
 * ProxyAgents (design §9). Only `createAgent`/`resume` are required by AgentFactory.
 */
export default class DispatchAgentLoop extends Service {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'userQuestions'];
  static Config = z.object({
    connectionString: z.string().required(),
    runtimeClass: z.string().default('default'),
    tailMs: z.number().default(400),
    // 与 runtime-worker.staleMs 对齐：Host 自己也回收心跳过期的 running 线程（Runtime 全挂时没人跑 markStale）
    // 2026-08-27：30s 太急——OrbStack 节点抖动/PG 短暂不可达 10–30s 就把还活着的轮次重投给第二个 pod（同一轮跑两遍）。
    // 现在 Runtime 心跳自带所有权栅栏（被回收的 pod 会自行取消），90s 换更少的误回收；真死的 pod 90s 内也会被接管。
    staleMs: z.number().default(90000),
  });

  private readonly pool: pg.Pool;
  private readonly ready: Promise<void>;
  private readonly live = new Set<ProxyAgent>();
  /** Our own plugin ctx + injected services, captured at construction: calls arriving via ctx.agents.create() are re-traced to the caller's ctx. */
  private readonly loopCtx: any;
  private readonly svc: { sessions: any; agents: any; sessionPersistence: any };

  private readonly config: DispatchConfig;

  constructor(ctx: Context, config: DispatchConfig) {
    super(ctx, 'agentLoop');
    this.config = config;
    const c = ctx as any;
    this.loopCtx = c;
    this.svc = { sessions: c.sessions, agents: c.agents, sessionPersistence: c.sessionPersistence };
    const anyCtx = ctx as any;
    this.pool = createPool(config.connectionString);
    this.ready = runMigrations(this.pool);
    trace('DispatchAgentLoop constructed');
    ctx.effect(() => { trace('setFactory'); return anyCtx.agents.setFactory(this); }, 'dispatch.setFactory()');
    this.ready.catch(() => {});
    ctx.effect(() => async () => {
      for (const a of this.live) a.stopTail();
      this.live.clear();
      await this.ready.catch(() => {});
      await this.pool.end();
    }, 'dispatch.pool');
    ctx.get('systemPrompt' as any)?.variable?.('cwd', (c: any) => c.agent?.session?.header?.cwd);   // optional service → ctx.get
  }

  async createAgent(ownerCtx: any, options: any) {
    trace(`createAgent ${String(options.sessionId)}`);
    await this.ready;
    const session = this.svc.sessions.prepare(options.sessionId, { meta: { ...options.meta }, seed: options.seed ?? [], seedSource: 'construction' });
    await this.svc.sessionPersistence.create(session.header);          // header first: Runtime resumes an empty session
    await ensureThread(this.pool, session.id, this.config.runtimeClass);
    return this.publish(ownerCtx, session, options, 'startup');
  }

  async resume(ownerCtx: any, options: any) {
    trace(`resume ${String(options.resumeSessionId)}`);
    await this.ready;
    const preparation = await this.svc.sessionPersistence.prepare(options.resumeSessionId, options.signal);
    try {
      await ensureThread(this.pool, options.resumeSessionId, this.config.runtimeClass);
      return await this.publish(ownerCtx, preparation.session, options, 'resume');
    } finally {
      preparation[Symbol.dispose]();
    }
  }

  private async publish(ownerCtx: any, session: any, options: any, source: 'startup' | 'resume') {
    const agent = new ProxyAgent(this.loopCtx, session, options.agentOptions ?? {}, {
      pool: this.pool, tailMs: this.config.tailMs, staleMs: this.config.staleMs, persistence: this.svc.sessionPersistence,
    });
    const commit = await options.setup?.(agent.ctx);
    const detachSession = agent.ctx.sessions.enter(session);
    const detachAgent = this.svc.agents.enter(agent, ownerCtx?.agent);
    agent.ctx.sessions.announce(session);
    this.svc.agents.announce(agent);
    commit?.commit?.();
    emitAgentEvent(this.loopCtx, agent as any, 'agent/session-start' as any, { source } as any);
    this.live.add(agent);
    if (source === 'resume') agent.startTail();     // a Runtime may already be executing this session
    return {
      agent,
      dispose: async () => { agent.stopTail(); this.live.delete(agent); detachAgent(); detachSession(); },
    };
  }
}

export { DispatchAgentLoop };
