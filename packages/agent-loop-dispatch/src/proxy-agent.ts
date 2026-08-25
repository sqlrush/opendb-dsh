import { emitAgentEvent } from '@deepseek-ai/dsh-agent';
import { createScope } from '@deepseek-ai/dsh-scope';
import type pg from 'pg';
import {
  enqueue, interrupt, markReported, openRows, pendingQueue, reapStaleThread, settleDurable, threadStatus, unreportedFailures,
  type QueueKind,
} from './queue.ts';
import { QueueInbox, projectQueue, type QueuedMessage } from './queue-inbox.ts';
import { bridgeQuestionsOnce, mirrorOnce } from './tailer.ts';
import { trace } from './debug.ts';

type Status = 'idle' | 'running';

export interface ProxyAgentDeps {
  pool: pg.Pool;
  tailMs: number;
  /** A `running` thread whose heartbeat is older than this is reaped by the Host tail (Runtime fleet may be dead). */
  staleMs: number;
  persistence: any;
}

/**
 * Host-side stand-in for a dsh Agent (implements the `Agent` interface surface used by
 * dsh-host-apiproxy). It owns a REAL Session + scope so the rest of dsh treats it like any
 * agent, but it never runs turns: `followup()` writes the queue row and starts tailing PG,
 * mirroring Runtime-written events into the live Session.
 *
 * Queue semantics (2026-08-25, poisoned-Runtime postmortem): the Host OWNS a prompt until its
 * `user/message` is in the durable log. `inbox` is a PG-backed projection of `dsh_thread_queue`
 * (native queue dock + `session.updateQueue` work unchanged); a prompt stays visible there from
 * submit until the Runtime persists it, survives Runtime failures (rows are re-offered up to the
 * attempt cap), and a dead-lettered prompt is surfaced as `agent/error`.
 */
export class ProxyAgent {
  readonly id: any;
  readonly options: any;
  readonly session: any;
  readonly inbox: QueueInbox;
  readonly ctx: any;
  status: Status = 'idle';
  private idleWaiters: Array<() => void> = [];
  private tailTimer: NodeJS.Timeout | undefined;
  private readonly questionsInFlight = new Set<string>();
  private lastTailError = 0;
  private idleEmptyTicks = 0;
  /** Ids of user messages already in the durable log (seeded from the loaded session, extended as events mirror in). */
  private readonly durable = new Set<string>();

  private readonly pool: pg.Pool;
  private readonly tailMs: number;
  private readonly staleMs: number;
  private readonly persistence: any;

  constructor(loopCtx: any, session: any, options: any, deps: ProxyAgentDeps) {
    this.pool = deps.pool;
    this.tailMs = deps.tailMs;
    this.staleMs = deps.staleMs;
    this.persistence = deps.persistence;
    this.id = session.id;
    this.session = session;
    this.options = options;
    const scope = createScope(loopCtx, this as any);
    this.ctx = scope.ctx.extend({ agent: this });
    this.inbox = new QueueInbox(this.pool, (line) => process.stderr.write(`[agent-loop-dispatch] ${String(this.id)} ${line}\n`));
    this.noteDurable(0);
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
  send(message: any, target: unknown, _wakeup: boolean): void {
    trace(`send ${String(this.id)}`);
    this.setStatus('running');
    void this.dispatch(message, target === 'next-step' ? 'steer' : 'queued');
  }
  /** Flush the Host-side log first so the Runtime resumes from a prefix that includes every local event. */
  private async dispatch(message: QueuedMessage, intent: QueueKind): Promise<void> {
    try {
      await this.ctx.sessions.flush(this.session);
      // steer only means something while a Runtime is mid-turn; otherwise it is just the next prompt
      const kind: QueueKind = intent === 'steer' && (await threadStatus(this.pool, this.id)) === 'running' ? 'steer' : 'queued';
      const queueId = await enqueue(this.pool, this.id, {
        content: message.content, source: message.source ?? { kind: 'user' }, message, agentOptions: this.options ?? {},
      }, kind);
      this.inbox.add({ queueId, kind, message });
    } catch (err) {
      trace(`dispatch error ${String(this.id)}: ${String(err)}`);
      // the prompt never reached the queue: say so instead of letting it vanish
      this.raise(new Error(`消息未能进入处理队列：${String((err as Error).message ?? err)}`));
    }
    this.startTail();
  }
  followup(m: any) { this.send(m, 'next-turn', true); }
  steer(m: any) { this.send(m, 'next-step', true); }
  inject(m: any) { this.send(m, 'next-turn', false); }
  cancel(_cause: unknown, _options?: unknown): void { void interrupt(this.pool, this.id); }
  whenIdle(): Promise<void> {
    return this.status === 'idle' ? Promise.resolve() : new Promise((res) => this.idleWaiters.push(res));
  }
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> { return task(new AbortController().signal); }

  /** Surface a failure through dsh's own channel (apiproxy → `host/agent-error` frame → red banner in the conversation). */
  private raise(error: Error): void {
    emitAgentEvent(this.ctx, this as any, 'agent/error' as any, { error } as any);
  }

  /** Record `user/message` ids appended since `fromSeq` (events are seq-indexed: index == seq). */
  private noteDurable(fromSeq: number): void {
    const events: Array<{ type: string; data?: { id?: unknown } }> = this.session.events ?? [];
    for (let i = Math.max(0, fromSeq); i < events.length; i++) {
      const ev = events[i];
      if (ev.type === 'user/message' && typeof ev.data?.id === 'string') this.durable.add(ev.data.id);
    }
  }

  /**
   * One tail tick's queue bookkeeping: reap a heartbeat-dead thread, settle re-offered rows whose
   * message is already durable (never run a prompt twice), re-project the inbox, report dead letters.
   */
  private async reconcileQueue(): Promise<void> {
    if (await reapStaleThread(this.pool, this.id, this.staleMs)) {
      process.stderr.write(`[agent-loop-dispatch] ${String(this.id)}: running thread heartbeat older than ${this.staleMs}ms → re-offered its prompt\n`);
    }
    const rows = await openRows(this.pool, this.id);
    const settled = rows.filter((r) => !r.admitted && r.messageId !== null && this.durable.has(r.messageId)).map((r) => r.messageId as string);
    if (settled.length > 0) await settleDurable(this.pool, this.id, settled);
    this.inbox.refresh(projectQueue(rows, this.durable));
    const failures = await unreportedFailures(this.pool, this.id);
    for (const f of failures) {
      this.raise(new Error(`消息处理失败（Runtime 已尝试 ${f.attempts} 次）：${f.lastError ?? '未知错误'}`));
    }
    await markReported(this.pool, failures.map((f) => f.queueId));
  }

  startTail(): void {
    if (this.tailTimer) return;
    const tick = async () => {
      try {
        const before = this.session.seq;
        await mirrorOnce(this.persistence, this.session);
        this.noteDurable(before);
        await bridgeQuestionsOnce(this.pool, this.ctx, this, this.questionsInFlight);
        await this.reconcileQueue();
        const st = await threadStatus(this.pool, this.id);
        const pending = await pendingQueue(this.pool, this.id);
        // Every Host replica that tails this session reports it as running while a Runtime holds the turn or
        // prompts wait: the Service has no affinity, so the WS / RPC of one browser may land on different pods —
        // without this, the thinking indicator and updateQueue's steer gate only worked on the pod that got the prompt.
        if (st === 'running' || pending > 0) this.setStatus('running');
        if (st !== 'running' && pending === 0) {
          // The Runtime releases the thread right after its last write-behind batch is scheduled; keep
          // mirroring until two consecutive idle ticks bring nothing new, then stop.
          const seqBefore = this.session.seq;
          const more = await mirrorOnce(this.persistence, this.session);
          this.noteDurable(seqBefore);
          this.idleEmptyTicks = more > 0 ? 0 : this.idleEmptyTicks + 1;
          if (this.idleEmptyTicks >= 2) {
            process.stderr.write(`[agent-loop-dispatch] tail stop ${String(this.id)} status=${st} seq=${this.session.seq}\n`);
            this.idleEmptyTicks = 0;
            this.setStatus('idle');
            this.tailTimer = undefined;
            return;
          }
        } else {
          this.idleEmptyTicks = 0;
        }
      } catch (err) {
        // transient PG/validation error: log (rate-limited) and retry next tick
        const now = Date.now();
        if (now - this.lastTailError > 5000) { this.lastTailError = now; process.stderr.write(`[agent-loop-dispatch] tail error ${String(this.id)}: ${String(err)}\n`); }
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
