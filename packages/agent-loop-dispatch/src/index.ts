import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import { emitAgentEvent } from '@deepseek-ai/dsh-agent';
import type pg from 'pg';
import { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';
import { ProxyAgent } from './proxy-agent.ts';
import { ensureThread } from './queue.ts';

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

  private readonly config: DispatchConfig;

  constructor(ctx: Context, config: DispatchConfig) {
    super(ctx, 'agentLoop');
    this.config = config;
    const anyCtx = ctx as any;
    this.pool = createPool(config.connectionString);
    this.ready = runMigrations(this.pool);
    ctx.effect(() => anyCtx.agents.setFactory(this), 'dispatch.setFactory()');
    this.ready.catch(() => {});
    ctx.effect(() => async () => { await this.ready.catch(() => {}); await this.pool.end(); }, 'dispatch.pool');
    anyCtx.systemPrompt?.variable?.('cwd', (c: any) => c.agent?.session?.header?.cwd);
  }

  async createAgent(ownerCtx: any, options: any) {
    await this.ready;
    const anyCtx = this.ctx as any;
    const session = anyCtx.sessions.prepare(options.sessionId, { meta: { ...options.meta }, seed: options.seed ?? [], seedSource: 'construction' });
    await anyCtx.sessionPersistence.create(session.header);          // header first: Runtime resumes an empty session
    await ensureThread(this.pool, session.id, this.config.runtimeClass);
    return this.publish(ownerCtx, session, options, 'startup');
  }

  async resume(ownerCtx: any, options: any) {
    await this.ready;
    const anyCtx = this.ctx as any;
    const preparation = await anyCtx.sessionPersistence.prepare(options.resumeSessionId, options.signal);
    try {
      await ensureThread(this.pool, options.resumeSessionId, this.config.runtimeClass);
      return await this.publish(ownerCtx, preparation.session, options, 'resume');
    } finally {
      preparation[Symbol.dispose]();
    }
  }

  private async publish(ownerCtx: any, session: any, options: any, source: 'startup' | 'resume') {
    const anyCtx = this.ctx as any;
    const agent = new ProxyAgent(this.ctx, session, options.agentOptions ?? {}, this.pool, this.config.tailMs, anyCtx.sessionPersistence);
    const commit = await options.setup?.(agent.ctx);
    const detachSession = agent.ctx.sessions.enter(session);
    const detachAgent = anyCtx.agents.enter(agent, ownerCtx?.agent);
    agent.ctx.sessions.announce(session);
    anyCtx.agents.announce(agent);
    commit?.commit?.();
    emitAgentEvent(this.ctx, agent as any, 'agent/session-start' as any, { source } as any);
    if (source === 'resume') agent.startTail();     // a Runtime may already be executing this session
    return {
      agent,
      dispose: async () => { agent.stopTail(); detachAgent(); detachSession(); },
    };
  }
}

export { DispatchAgentLoop };
