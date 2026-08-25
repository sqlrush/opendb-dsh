/**
 * Host 副本扇出的纯逻辑（cordis 胶水在 index.ts，这里只依赖注入的窄接口，便于单测）。
 *
 * 问题（2026-08-25 user 报障）：dsh-host-apiproxy 的两条推送流（events.mux / events.host）都只转发**本副本**
 * 的 ctx 事件；浏览器三条连接（HTTP / mux / host）经 traefik 粘性 cookie 绑在一台，但 Host 滚动后重连会分家
 * ——HTTP 在 A 建了会话，通知只在 A 的流上发，页面的流在 B → 草稿永远等不到「会话已建好」→ 输入框置灰。
 *
 * 解法：任何副本上「被触碰」的会话（新建 / 有人在它上面发了提问）经 PG NOTIFY 广播，其余副本把它 resume 成本地
 * 活会话——announce 会触发本副本的 session/created → apiproxy 给本副本的 mux/host 流补上订阅与 host/session-added；
 * 之后 ProxyAgent 的 tail 从 PG 镜像事件、按线程状态上报 running/idle，三条流落在哪台都完整。
 * agent/error（死信红条等）只在发现它的那台触发，也广播给其余副本重新抛出。
 */

export interface FanoutMessage { origin: string; kind: 'session' | 'agent-error'; sessionId: string; message?: string }

export interface FanoutDeps {
  podName: string;
  /** 本副本是否已有该会话的活代理 */
  hasAgent(sessionId: string): boolean;
  /** 把会话 resume 成本地活会话（apiproxy 同款 agents.resume） */
  resume(sessionId: string): Promise<void>;
  /** 在本地代理上重新抛出错误（emitAgentEvent agent/error） */
  raise(sessionId: string, message: string): boolean;
  /** 会话日志是否已可安全加载：至少一条事件已落库（新建会话的 seed 走 write-behind，可能晚几十毫秒） */
  persisted(sessionId: string): Promise<boolean>;
  publish(msg: FanoutMessage): Promise<void>;
  log(line: string): void;
  /** 等待 seed 落库的上限与步长 */
  settleMs?: number;
  pollMs?: number;
}

export class HostFanout {
  private readonly inbound = new Set<string>();
  private readonly inflight = new Map<string, Promise<void>>();
  private raising = false;
  private readonly deps: FanoutDeps;

  constructor(deps: FanoutDeps) { this.deps = deps; }

  // ---------------------------------------------------------------- outbound（本副本的 ctx 事件 → 总线）
  /** session/created：本副本新建或 resume 了会话。由扇入触发的 resume 不再回播。 */
  onSessionCreated(sessionId: string): void {
    if (this.inbound.has(sessionId)) return;
    void this.deps.publish({ origin: this.deps.podName, kind: 'session', sessionId }).catch((err) => this.deps.log(`publish failed: ${String(err)}`));
  }
  /** agent/status：转为 running 意味着本副本上有人发了提问（或 tail 看到 Runtime 在跑）——确保各副本都活着。 */
  onAgentStatus(sessionId: string, status: string): void {
    if (status !== 'running' || this.inbound.has(sessionId)) return;
    void this.deps.publish({ origin: this.deps.podName, kind: 'session', sessionId }).catch((err) => this.deps.log(`publish failed: ${String(err)}`));
  }
  /** agent/error：广播给其余副本重新抛出；由扇入重抛的不再回播。 */
  onAgentError(sessionId: string, message: string): void {
    if (this.raising) return;
    void this.deps.publish({ origin: this.deps.podName, kind: 'agent-error', sessionId, message }).catch((err) => this.deps.log(`publish failed: ${String(err)}`));
  }

  // ---------------------------------------------------------------- inbound（总线 → 本副本）
  handle(payload: string): Promise<void> {
    let msg: FanoutMessage;
    try { msg = JSON.parse(payload) as FanoutMessage; } catch { return Promise.resolve(); }
    if (typeof msg?.sessionId !== 'string' || msg.origin === this.deps.podName) return Promise.resolve();
    if (msg.kind === 'session') return this.ensureLive(msg.sessionId);
    if (msg.kind === 'agent-error') {
      this.raising = true;
      try { this.deps.raise(msg.sessionId, msg.message ?? 'unknown error'); } finally { this.raising = false; }
    }
    return Promise.resolve();
  }

  /** 让会话在本副本活起来（幂等、并发合并）。 */
  ensureLive(sessionId: string): Promise<void> {
    if (this.deps.hasAgent(sessionId)) return Promise.resolve();
    const running = this.inflight.get(sessionId);
    if (running !== undefined) return running;
    const task = (async () => {
      if (!(await this.waitPersisted(sessionId))) { this.deps.log(`${sessionId}: seed not persisted within ${this.deps.settleMs ?? 3000}ms; not resuming`); return; }
      if (this.deps.hasAgent(sessionId)) return;
      this.inbound.add(sessionId);
      try {
        await this.deps.resume(sessionId);
      } catch (err) {
        this.deps.log(`${sessionId}: resume failed: ${String((err as Error).message ?? err)}`);
      } finally {
        this.inbound.delete(sessionId);
      }
    })().finally(() => this.inflight.delete(sessionId));
    this.inflight.set(sessionId, task);
    return task;
  }

  private async waitPersisted(sessionId: string): Promise<boolean> {
    const deadline = Date.now() + (this.deps.settleMs ?? 3000);
    const step = this.deps.pollMs ?? 250;
    for (;;) {
      if (await this.deps.persisted(sessionId)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, step));
    }
  }
}
