import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm';
import { createServer, type Server } from 'node:http';
import type pg from 'pg';
import { createPool, runMigrations, migrationFailures } from '@opendb-dsh/session-persistence-pg';
import { claimNext, heartbeat, markStale, pendingInterrupts, pendingSteers, release, requeueFailed, type Claimed, type QueuePayload } from './claim.ts';
import { PgUserQuestionProvider } from './questions-provider.ts';

/** 「拒绝认领」日志节流（每分钟一条），避免中毒期间每 2s 刷一行 */
let lastRefuseLog = 0;

/**
 * 队列行 → dsh 用户消息。Host 透传了完整消息（含它铸的 id）就原样冻结使用：Runtime 落的 user/message
 * 与 Host 排队投影里是同一个 id，Host 才能判定「已持久化」并从排队 dock 撤下；旧行（无 message）退回自铸 id。
 */
function toUserMessage(payload: QueuePayload): unknown {
  if (payload.message !== undefined && typeof payload.message.id === 'string') return freezeMessage(payload.message as any);
  return createUserMessage({ content: payload.content as any, source: payload.source as any } as any);
}

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

export { claimNext, heartbeat, markStale, pendingInterrupts, pendingSteers, release, requeueFailed } from './claim.ts';
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
  /** 同一条消息最多让 Runtime 尝试几次（user 2026-08-25 定 3），之后 failed_at 死信 + Host 报错 */
  maxAttempts: number;
  /** 一次运行失败后本 pod 停止认领的冷却，让别的 pod 先重领同一条 */
  failurePenaltyMs: number;
  /** 轮次活动看门狗：会话日志多久没有新事件（模型不出 token、工具不返回）就判定上游卡死，切断并重投 */
  turnIdleMs: number;
  /** 连续失败达到此数即健康 503（熔断）→ livenessProbe 重启本 pod */
  breakerFailures: number;
}

interface AgentHandleLike {
  agent: {
    followup(message: unknown): void;
    steer(message: unknown): void;
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
    staleMs: z.number().default(90000),   // 与 agent-loop-dispatch.staleMs 对齐（2026-08-27 从 30s 放宽，见那边注释）
    healthPort: z.number().default(9090),
    // 每 pod 并发 turn 上限：不设限会把整个队列瞬间吸干，队列深度归零 → KEDA 扩缩信号失真（W6 实测）
    maxConcurrent: z.number().default(2),
    maxAttempts: z.number().default(3),
    failurePenaltyMs: z.number().default(5000),
    breakerFailures: z.number().default(3),
    // 2026-08-27：一次 DeepSeek 流式调用挂了 55 分钟没有任何输出（dsh 的 streamIdleTimeoutMs=5min 没触发，推测上游 keep-alive
    // 一直在喂空包）。平台层兜底：会话日志 10 分钟没有任何新事件就切断本轮并换 id 重投（计一次 attempt，3 次死信报错）。
    turnIdleMs: z.number().default(600000),
  });

  private stopping = false;
  /** 正在本 pod 上运行的轮次（sessionId → 代理），SIGTERM 时逐个取消 */
  private readonly running = new Map<string, { cancel(cause: unknown): void }>();
  /** 连续运行失败计数（成功一次清零）；达到 breakerFailures 即熔断：不再认领、健康 503 */
  private consecutiveFailures = 0;
  /** 失败冷却截止时间戳：期间不认领，把重投机会让给别的 pod */
  private penaltyUntil = 0;
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
      // 熔断（连续 breakerFailures 次运行失败）同样 503：秒失败的 pod 只会不停吞消息，让 k8s 重启它
      const broken = this.consecutiveFailures >= this.config.breakerFailures;
      res.statusCode = this.stopping || migrationFailures() > 0 || broken ? 503 : 200;
      res.end(this.stopping ? 'draining' : broken ? `breaker open (${this.consecutiveFailures} consecutive failures)` : 'ok');
    }).listen(config.healthPort);

    // SIGTERM 自己接：dsh 关机时插件销毁顺序不可控（2026-08-25 实测：持久化连接先关、轮次继续跑、输出全丢、
    // 线程最后还被标 idle）。第一时间取消本地轮次 → run() 走"被切断"分支：换新 id 重投 + 线程 interrupted。
    ctx.effect(() => {
      const onSignal = (sig: string) => {
        process.stderr.write(`[runtime-worker] ${sig}: shutting down, cutting ${this.running.size} in-flight turn(s) for re-delivery\n`);
        this.beginShutdown();
      };
      const term = () => onSignal('SIGTERM');
      const int = () => onSignal('SIGINT');
      process.on('SIGTERM', term);
      process.on('SIGINT', int);
      return () => { process.off('SIGTERM', term); process.off('SIGINT', int); };
    }, 'runtimeWorker.signals');

    let timer: NodeJS.Timeout | undefined;
    ctx.effect(() => {
      const tick = async () => {
        if (this.stopping) return;
        try {
          await markStale(this.pool, this.config.staleMs);
          if (this.inFlight.size < this.config.maxConcurrent) {
            // 本进程有 PG 服务迁移失败时绝不认领：认领了也必失败，还会把用户消息吞掉
            //（队列行已 admitted 不再重投）。tick 照常跑（markStale 清扫不停），等 livenessProbe 重启本 pod
            const broken = this.consecutiveFailures >= this.config.breakerFailures;
            if (migrationFailures() > 0 || broken) {
              if (Date.now() - lastRefuseLog > 60_000) {
                lastRefuseLog = Date.now();
                const why = migrationFailures() > 0
                  ? `${migrationFailures()} migration failure(s) in this process`
                  : `breaker open after ${this.consecutiveFailures} consecutive run failures`;
                process.stderr.write(`[runtime-worker] refusing to claim: ${why}; health=503, awaiting restart\n`);
              }
            } else if (Date.now() < this.penaltyUntil) {
              // 刚失败过：冷却期内不认领，同一条消息优先由别的 pod 重领（poll 保底会在冷却后回来）
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
        // drain: stop claiming, cut in-flight turns for re-delivery elsewhere, then close resources
        this.beginShutdown();
        if (timer) clearTimeout(timer);
        await Promise.allSettled([...this.inFlight]);
        this.server.close();
        await this.ready.catch(() => {});
        await this.pool.end();
      };
    }, 'runtimeWorker.loop');
  }

  /** 停止认领，并取消本 pod 上所有运行中的轮次（run() 随后把它们换新 id 重投）。幂等。 */
  private beginShutdown(): void {
    if (this.stopping) return;
    this.stopping = true;
    for (const [sessionId, agent] of this.running) {
      try { agent.cancel({ kind: 'user' }); } catch (err) { process.stderr.write(`[runtime-worker] cancel on shutdown failed for ${sessionId}: ${String(err)}\n`); }
    }
  }

  private async run(claimed: Claimed): Promise<void> {
    const anyCtx = this.ctx as any;
    const { sessionId, payload } = claimed;
    // 心跳 = 所有权栅栏（2026-08-27：Host 把心跳陈旧的轮次重投给第二个 pod，第一个 pod 其实还活着，同一轮跑了两遍）。
    // 心跳返回 false（线程已不归本 pod）→ 立刻取消本地轮次，之后不 release / 不重投 / 不算失败；
    // 心跳连续失败超过 staleMs（PG 不可达，Host 那边多半已回收）→ 同样自认失去所有权。
    // 心跳的异常必须接住：以前 `void heartbeat()` 一个 ECONNREFUSED 就成了未处理 rejection，dsh 当作 fatal 把整个进程退了。
    let fenced = false;
    let hbFailedSince = 0;
    const fence = (why: string) => {
      if (fenced) return;
      fenced = true;
      process.stderr.write(`[runtime-worker] ${sessionId}: ownership lost (${why}) → cancelling local turn, result discarded\n`);
      const a = this.running.get(sessionId);
      if (a !== undefined) { try { a.cancel({ kind: 'user' }); } catch { /* already stopped */ } }
    };
    // 活动看门狗：日志事件数长时间不变 = 上游卡死（模型不出 token / 工具不返回）→ 切断本轮，走重投
    let idleCut = false;
    let lastEventCount = -1;
    let lastEventAt = Date.now();
    let agentRef: any;   // resume 完成后指向 handle.agent（this.running 里的类型只暴露 cancel）
    const hb = setInterval(() => {
      heartbeat(this.pool, sessionId, this.config.podName)
        .then((owned) => { hbFailedSince = 0; if (!owned) fence('heartbeat fenced: thread no longer owned by this pod'); })
        .catch((err) => {
          if (hbFailedSince === 0) hbFailedSince = Date.now();
          if (Date.now() - hbFailedSince > this.config.staleMs) fence(`heartbeat unreachable for ${Math.round((Date.now() - hbFailedSince) / 1000)}s: ${String((err as Error).message ?? err).slice(0, 80)}`);
        });
      const n: number = agentRef?.session?.events?.length ?? -1;
      if (n !== lastEventCount) { lastEventCount = n; lastEventAt = Date.now(); }
      else if (!idleCut && !fenced && agentRef !== undefined && Date.now() - lastEventAt > this.config.turnIdleMs) {
        idleCut = true;
        process.stderr.write(`[runtime-worker] ${sessionId}: no session events for ${Math.round((Date.now() - lastEventAt) / 1000)}s (upstream hung?) → cutting the turn, will re-offer\n`);
        try { agentRef.cancel({ kind: 'user' }); } catch { /* already stopped */ }
      }
    }, this.config.heartbeatMs);
    let handle: AgentHandleLike | undefined;
    try {
      const fallback = anyCtx.get('agentDefaultModel')?.currentSelection?.() ?? {};
      const agentOptions = payload.agentOptions?.provider && payload.agentOptions?.model ? payload.agentOptions : { provider: fallback.provider, model: fallback.model };
      handle = (await anyCtx.agents.resume({ resumeSessionId: sessionId, agentOptions })) as AgentHandleLike;
      process.stderr.write(`[runtime-worker] claimed ${sessionId} (queue ${claimed.queueId}) on ${this.config.podName}\n`);
      const agent = handle.agent;
      agentRef = agent;
      this.running.set(sessionId, agent);
      if (this.stopping) agent.cancel({ kind: 'user' });   // SIGTERM 抢在 resume 完成之前：立刻切断，走重投
      let userInterrupted = false;
      const interruptPoll = setInterval(() => {
        void pendingInterrupts(this.pool, sessionId).then((n) => { if (n > 0) { userInterrupted = true; agent.cancel({ kind: 'user' }); } });
        // 运行中插队（原生 updateQueue 的 steer / composer 的 steer 模式）：Host 写 steer 行，本 pod 喂进当前轮
        void pendingSteers(this.pool, sessionId, this.config.podName)
          .then((rows) => { for (const row of rows) agent.steer(toUserMessage(row.payload)); })
          .catch((err) => process.stderr.write(`[runtime-worker] steer poll failed for ${sessionId}: ${String(err)}\n`));
      }, 1000);
      try {
        agent.followup(toUserMessage(payload));
        await agent.whenIdle();
        // dsh appends turn/end after the (async) agent/turn-stopping hooks, which can be after status→idle: wait for the log to close the turn
        const t0 = Date.now();
        while (!turnClosed(agent.session.events) && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 50));
        if (!turnClosed(agent.session.events)) process.stderr.write(`[runtime-worker] WARN turn still open after 60s for ${sessionId}; releasing anyway\n`);
        // durability checkpoint: the last write-behind batch (turn/end) reaches PG before release.
        // 关机途中持久化连接可能已被别的插件关掉（2026-08-25 实测）：失败不算运行失败，重投分支会兜底
        try { await (anyCtx.sessions?.flush?.(agent.session) ?? Promise.resolve()); }
        catch (err) { process.stderr.write(`[runtime-worker] flush failed for ${sessionId} (shutting down=${this.stopping}): ${String(err)}\n`); }
      } finally {
        clearInterval(interruptPoll);
      }
      // 2026-08-25 21:06 user 实测：滚动更新终止旧 pod 时运行中的轮次被切断，用户的提问就这么没了。
      // 不是用户自己中断的 interrupted、或关机中没跑到 completed = 被基础设施切断：换一个消息 id 重投
      //（原 id 已落日志，会被 Host 去重吞掉），新 pod 重跑一遍，日志上第一轮标 interrupted。
      const reason = lastTurnEndReason(agent.session.events);
      if (fenced) {
        // 这一轮已经归别的 pod 了：本地结果作废，不 release（会把别人的 running 改掉）、不重投（会跑第三遍）
        process.stderr.write(`[runtime-worker] ${sessionId}: fenced turn ended (${reason ?? 'no turn/end'}); nothing released or re-offered\n`);
        return;
      }
      if (!userInterrupted && (idleCut || reason === 'interrupted' || (this.stopping && reason !== 'completed'))) {
        const why = idleCut ? `turn idle for ${Math.round(this.config.turnIdleMs / 1000)}s on ${this.config.podName} (no session events; upstream hung?)` : `turn interrupted by runtime shutdown on ${this.config.podName}`;
        const outcome = await requeueFailed(this.pool, claimed.queueId, why, this.config.maxAttempts, { rotateMessageId: true, ownerPod: this.config.podName })
          .catch((e) => { process.stderr.write(`[runtime-worker] resend after cut failed for queue ${claimed.queueId}: ${String(e)}\n`); return undefined; });
        process.stderr.write(`[runtime-worker] ${sessionId}: ${idleCut ? 'turn cut by idle watchdog' : 'turn cut by shutdown'} → ${outcome === undefined ? 'row no longer owned by this pod, not re-offered' : outcome.failed ? 'dead-lettered' : `re-offered with a fresh message id (attempt ${outcome.attempts})`}\n`);
        await release(this.pool, sessionId, this.config.podName, 'interrupted');
        return;
      }
      await release(this.pool, sessionId, this.config.podName, 'idle');
      this.consecutiveFailures = 0;
      process.stderr.write(`[runtime-worker] released ${sessionId} idle\n`);
    } catch (err) {
      const detail = describeError(err);
      process.stderr.write(`[runtime-worker] run failed for ${sessionId}: ${detail}\n`);
      if (fenced) { process.stderr.write(`[runtime-worker] ${sessionId}: failure after fence ignored (another pod owns the turn)\n`); return; }
      // 2026-08-25 中毒 pod 事故：以前失败只 release，队列行留在 admitted 成死信，用户消息凭空消失。
      // 现在：计次 + 让出（冷却）+ 未到上限则任何 pod 可重领；到上限记 failed_at，Host 把失败报给用户。
      this.consecutiveFailures += 1;
      this.penaltyUntil = Date.now() + this.config.failurePenaltyMs;
      const outcome = await requeueFailed(this.pool, claimed.queueId, detail, this.config.maxAttempts, { ownerPod: this.config.podName })
        .catch((e) => { process.stderr.write(`[runtime-worker] requeue failed for queue ${claimed.queueId}: ${String(e)}\n`); return undefined; });
      if (outcome !== undefined) {
        process.stderr.write(outcome.failed
          ? `[runtime-worker] queue ${claimed.queueId} dead-lettered after ${outcome.attempts} attempts (session ${sessionId})\n`
          : `[runtime-worker] queue ${claimed.queueId} re-offered (attempt ${outcome.attempts}/${this.config.maxAttempts}); this pod sits out ${this.config.failurePenaltyMs}ms\n`);
      }
      await release(this.pool, sessionId, this.config.podName, 'interrupted');
    } finally {
      clearInterval(hb);
      this.running.delete(sessionId);
      await handle?.dispose().catch(() => {});
    }
  }
}

export { RuntimeWorker };

/** True when the last opened turn in the log has been closed by a turn/end. */
/** Reason of the most recent turn/end in the log (undefined when no turn has ended yet). */
export function lastTurnEndReason(events: ReadonlyArray<{ type: string; data?: unknown }>): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'turn/end') return (e.data as { reason?: { kind?: string } } | undefined)?.reason?.kind;
  }
  return undefined;
}

export function turnClosed(events: ReadonlyArray<{ type: string }>): boolean {
  let open = false;
  for (const e of events) {
    if (e.type === 'turn/start') open = true;
    else if (e.type === 'turn/end') open = false;
  }
  return !open;
}
