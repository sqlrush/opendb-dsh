import type pg from 'pg';
import { removePending, replacePending, type OpenRow, type QueueKind } from './queue.ts';

/** A user message as the Host minted it (dsh-llm `createUserMessage` shape; extra fields pass through). */
export interface QueuedMessage { id: string; role: string; content: unknown[]; source: unknown; [extra: string]: unknown }

/** One projected queue entry: the PG row it lives in plus the message the native dock renders. */
export interface QueueEntry { queueId: string; kind: QueueKind; message: QueuedMessage }

/**
 * Array whose `toSpliced` is the identity. dsh-host-apiproxy builds every `session/queue` frame as
 * `agent.inbox.nextTurn.toSpliced(splice…)` where the splice is the `agent/inbox/spliced` event that
 * just hit the session log — on the Host those events are the RUNTIME's own inbox mutations mirrored
 * in, and their indices mean nothing against this projection (PG is the truth here). Ignoring them
 * keeps the dock from flickering a duplicate/missing row for one tick.
 */
class Projection extends Array<QueuedMessage> {
  /** map/filter on a projection yield plain arrays — only the projection itself ignores splices. */
  static get [Symbol.species]() { return Array; }
  // ES2023 Array#toSpliced is not in this tsconfig's lib, so this is a plain member rather than an override
  toSpliced(): QueuedMessage[] { return this; }
}

/**
 * PG-backed stand-in for dsh's `Inbox`, exposing exactly the surface `dsh-host-apiproxy` touches
 * (`nextTurn` / `nextStep` / `replace` / `remove`) so the native queue dock and `session.updateQueue`
 * (edit / remove / steer) work unchanged on the Host. The real `Inbox` cannot be used here: it appends
 * `agent/inbox/spliced` to the session log, and the Host must never write seq while a Runtime runs
 * the turn (single-writer; see tailer.ts).
 *
 * State is a snapshot refreshed by the tail tick from `dsh_thread_queue`; mutations apply locally
 * first (the dock updates instantly) and are written through. While a write is in flight the
 * snapshot is not replaced, so a stale read cannot resurrect a removed row.
 */
export class QueueInbox {
  private entries: readonly QueueEntry[] = [];
  private writesInFlight = 0;
  private readonly pool: pg.Pool;
  private readonly log: (line: string) => void;

  // explicit fields, not parameter properties: tests run under node's strip-only TS mode
  constructor(pool: pg.Pool, log: (line: string) => void) {
    this.pool = pool;
    this.log = log;
  }

  get nextTurn(): QueuedMessage[] { return Projection.from(this.entries.filter((e) => e.kind === 'queued').map((e) => e.message)); }
  get nextStep(): QueuedMessage[] { return Projection.from(this.entries.filter((e) => e.kind === 'steer').map((e) => e.message)); }
  get hasPending(): boolean { return this.entries.length > 0; }
  /** Current projection (queue order). */
  list(): readonly QueueEntry[] { return this.entries; }

  /** Replace the snapshot from PG (tail tick). Skipped while a local mutation is still being written. */
  refresh(entries: readonly QueueEntry[]): boolean {
    if (this.writesInFlight > 0) return false;
    const changed = !sameEntries(this.entries, entries);
    this.entries = entries;
    return changed;
  }

  /** Optimistic insert right after `enqueue` returned its id. */
  add(entry: QueueEntry): void {
    if (this.entries.some((e) => e.message.id === entry.message.id)) return;
    this.entries = [...this.entries, entry];
  }

  /** Native `updateQueue` remove / steer (steer removes here, then `agent.steer()` re-enqueues as a steer row). */
  remove(messageId: string): boolean {
    const entry = this.entries.find((e) => e.message.id === messageId);
    if (entry === undefined) return false;
    this.entries = this.entries.filter((e) => e !== entry);
    this.writeThrough(removePending(this.pool, entry.queueId), `remove ${entry.queueId}`);
    return true;
  }

  /** Native `updateQueue` edit: same id, new content. */
  replace(messageId: string, message: QueuedMessage): boolean {
    const entry = this.entries.find((e) => e.message.id === messageId);
    if (entry === undefined) return false;
    const next: QueueEntry = { ...entry, message };
    this.entries = this.entries.map((e) => (e === entry ? next : e));
    this.writeThrough(replacePending(this.pool, entry.queueId, { content: message.content, source: message.source, message }), `replace ${entry.queueId}`);
    return true;
  }

  // --- rest of the dsh Inbox surface: the Host never runs turns, so these are inert -------------
  claim(): QueuedMessage[] { return []; }
  clear(): void { /* the Runtime owns the running turn; nothing to drop locally */ }
  append(): void { /* prompts enter through ProxyAgent.send → enqueue */ }
  prepend(): void { /* same */ }
  splice(): QueuedMessage[] { return []; }

  private writeThrough(op: Promise<boolean>, what: string): void {
    this.writesInFlight += 1;
    op.then((hit) => { if (!hit) this.log(`queue ${what}: row already admitted; the Runtime keeps it`); })
      .catch((err) => this.log(`queue ${what} failed: ${String(err)}`))
      .finally(() => { this.writesInFlight -= 1; });
  }
}

/**
 * What the dock should show for one session: rows nobody has picked up yet.
 * 2026-08-27 user：一条 5ms 就被领走的消息在排队区还挂着，点删除得到原生的「可能已经开始发送」。
 * 已被 Runtime 领走的行一律不再投影（它已不可撤回，要中止走停止键）；领走 → user/message 落日志之间
 * 只有 ~100ms，加上客户端 1s 轮询，看不到它的空窗可忽略。重投/回收后重新变成 pending 的行会再次出现。
 */
export function projectQueue(rows: readonly OpenRow[], durable: ReadonlySet<string>): QueueEntry[] {
  const isDurable = (r: OpenRow) => r.messageId !== null && durable.has(r.messageId);
  return rows
    .filter((r) => !r.admitted && !isDurable(r))
    .map((r) => ({ queueId: r.queueId, kind: r.kind, message: messageOf(r) }));
}

/** Native `session/queue` frame items (same shape dsh-host-apiproxy emits) for a projection. */
export function queueFrameItems(entries: readonly QueueEntry[]): Array<{ id: string; placement: 'queued' | 'steering' | 'context'; message: QueuedMessage }> {
  return entries.map((e) => ({
    id: e.message.id,
    placement: e.kind === 'queued' ? 'queued' : (e.message.source as { kind?: string } | undefined)?.kind === 'user' ? 'steering' : 'context',
    message: e.message,
  }));
}

/** The dock renders the Host-minted message; pre-015 rows (no `message`) get a synthetic one keyed by the queue id. */
function messageOf(row: OpenRow): QueuedMessage {
  const m = row.payload.message;
  if (m !== undefined && typeof m.id === 'string') return m as QueuedMessage;
  return { id: row.messageId ?? `queue-${row.queueId}`, role: 'user', content: row.payload.content, source: row.payload.source ?? { kind: 'user' } };
}

function sameEntries(a: readonly QueueEntry[], b: readonly QueueEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((e, i) => e.queueId === b[i].queueId && e.kind === b[i].kind && e.message.id === b[i].message.id);
}
