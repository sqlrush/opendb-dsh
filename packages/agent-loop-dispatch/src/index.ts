import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import { emitAgentEvent } from '@deepseek-ai/dsh-agent';
import type pg from 'pg';
import { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';
import { ProxyAgent } from './proxy-agent.ts';
import { ensureThread } from './queue.ts';
import { trace } from './debug.ts';

export { ProxyAgent } from './proxy-agent.ts';
export { ensureThread, enqueue, interrupt, threadStatus, pendingQueue } from './queue.ts';
export { mirrorOnce, bridgeQuestionsOnce } from './tailer.ts';

export interface DispatchConfig { connectionString: string; runtimeClass: string; tailMs: number }

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
    const agent = new ProxyAgent(this.loopCtx, session, options.agentOptions ?? {}, this.pool, this.config.tailMs, this.svc.sessionPersistence);
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
