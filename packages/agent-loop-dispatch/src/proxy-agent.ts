import { Inbox, emitAgentEvent } from '@deepseek-ai/dsh-agent';
import { createScope } from '@deepseek-ai/dsh-scope';
import type pg from 'pg';
import { enqueue, interrupt, pendingQueue, threadStatus } from './queue.ts';
import { bridgeQuestionsOnce, mirrorOnce } from './tailer.ts';

type Status = 'idle' | 'running';

/**
 * Host-side stand-in for a dsh Agent (implements the `Agent` interface surface used by
 * dsh-host-apiproxy). It owns a REAL Session + Inbox + scope so the rest of dsh treats
 * it like any agent, but it never runs turns: `followup()` writes the queue row and
 * starts tailing PG, mirroring Runtime-written events into the live Session.
 */
export class ProxyAgent {
  readonly id: any;
  readonly options: any;
  readonly session: any;
  readonly inbox: Inbox;
  readonly ctx: any;
  status: Status = 'idle';
  private idleWaiters: Array<() => void> = [];
  private tailTimer: NodeJS.Timeout | undefined;
  private readonly questionsInFlight = new Set<string>();

  private readonly pool: pg.Pool;
  private readonly tailMs: number;
  private readonly persistence: any;

  constructor(loopCtx: any, session: any, options: any, pool: pg.Pool, tailMs: number, persistence: any) {
    this.pool = pool;
    this.tailMs = tailMs;
    this.persistence = persistence;
    this.id = session.id;
    this.session = session;
    this.options = options;
    const scope = createScope(loopCtx, this as any);
    this.ctx = scope.ctx.extend({ agent: this });
    this.inbox = new Inbox(session, {
      inserted: (m) => emitAgentEvent(this.ctx, this as any, 'agent/inbox/inserted' as any, { message: m } as any),
      discarded: (m) => emitAgentEvent(this.ctx, this as any, 'agent/inbox/discarded' as any, { message: m } as any),
      claimed: (m, turn) => emitAgentEvent(this.ctx, this as any, 'agent/inbox/claimed' as any, { message: m, turn } as any),
    });
  }

  private setStatus(s: Status) {
    if (this.status === s) return;
    this.status = s;
    emitAgentEvent(this.ctx, this as any, 'agent/status' as any, { status: s } as any);
    if (s === 'idle') {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  /** Host never appends locally: enqueue and tail. Runtime assigns seq; Host mirrors. */
  send(message: any, _target: unknown, _wakeup: boolean): void {
    void enqueue(this.pool, this.id, { content: message.content, source: message.source ?? { kind: 'user' } });
    this.setStatus('running');
    this.startTail();
  }
  followup(m: any) { this.send(m, 'next-turn', true); }
  steer(m: any) { this.send(m, 'next-step', true); }
  inject(m: any) { this.send(m, 'next-step', false); }
  cancel(_cause: unknown, _options?: unknown): void { void interrupt(this.pool, this.id); }
  whenIdle(): Promise<void> {
    return this.status === 'idle' ? Promise.resolve() : new Promise((res) => this.idleWaiters.push(res));
  }
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> { return task(new AbortController().signal); }

  startTail(): void {
    if (this.tailTimer) return;
    const tick = async () => {
      try {
        await mirrorOnce(this.persistence, this.session);
        await bridgeQuestionsOnce(this.pool, this.ctx, this, this.questionsInFlight);
        const st = await threadStatus(this.pool, this.id);
        const pending = await pendingQueue(this.pool, this.id);
        if (st !== 'running' && pending === 0) {
          await mirrorOnce(this.persistence, this.session);
          this.setStatus('idle');
          this.tailTimer = undefined;
          return;
        }
      } catch {
        // transient PG error: retry next tick
      }
      this.tailTimer = setTimeout(tick, this.tailMs);
    };
    this.tailTimer = setTimeout(tick, 0);
  }
  stopTail(): void {
    if (this.tailTimer) clearTimeout(this.tailTimer);
    this.tailTimer = undefined;
  }
}
