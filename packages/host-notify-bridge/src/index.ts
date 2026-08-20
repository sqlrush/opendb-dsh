import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import type pg from 'pg';
import { createPool } from '@opendb-dsh/session-persistence-pg';

declare module '@deepseek-ai/cordis' {
  interface Context { opendbNotify: NotifyBridge }
}

/**
 * ctx.opendbNotify — PG NOTIFY/LISTEN 事件总线（P3 host-notify-bridge）：
 * 跨副本/跨角色的毫秒级信号面。publish 走池连接 pg_notify；subscribe 走**专用 LISTEN 连接**
 * （断线自动重连并重放全部 LISTEN——W4 僵尸连接教训：连接死即由 PG 放资源，重连即恢复）。
 * 首批消费者：会话队列唤醒（agent-loop-dispatch→runtime-worker）、任务队列唤醒（runNow→引擎 tick）。
 * 语义：at-most-once 提示信号（丢了有 poll 保底），不做可靠投递。
 */
export default class NotifyBridge extends Service {
  static Config = z.object({ connectionString: z.string().required() });

  private readonly pool: pg.Pool;
  private readonly handlers = new Map<string, Set<(payload: string) => void>>();
  private listenClient: pg.PoolClient | undefined;
  private connecting = false;
  private disposed = false;

  constructor(ctx: Context, config: { connectionString: string }) {
    super(ctx, 'opendbNotify');
    this.pool = createPool(config.connectionString);
    ctx.effect(() => () => {
      this.disposed = true;
      if (this.listenClient !== undefined) { try { this.listenClient.release(true as any); } catch { /* closing */ } }
      void this.pool.end();
    }, 'opendbNotify.pool');
  }

  /** 发布信号（payload ≤ 8000 字节；超限截断——总线只传提示，不传数据）。 */
  async publish(channel: string, payload = ''): Promise<void> {
    await this.pool.query('SELECT pg_notify($1, $2)', [channel, payload.slice(0, 7900)]);
  }

  /** 订阅信号；返回退订函数。懒建 LISTEN 连接；连接已在时对新 channel 即时补挂 LISTEN。 */
  subscribe(channel: string, handler: (payload: string) => void): () => void {
    let set = this.handlers.get(channel);
    const isNewChannel = set === undefined;
    if (set === undefined) { set = new Set(); this.handlers.set(channel, set); }
    set.add(handler);
    if (isNewChannel && this.listenClient !== undefined) {
      this.listenClient.query(`LISTEN ${quoteIdent(channel)}`).catch(() => { /* 重连时会重放 */ });
    }
    void this.ensureListener();
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.handlers.delete(channel);
    };
  }

  private async ensureListener(): Promise<void> {
    if (this.disposed || this.connecting || this.listenClient !== undefined) return;
    this.connecting = true;
    try {
      const c = await this.pool.connect();
      c.on('notification', (msg) => {
        const set = this.handlers.get(msg.channel);
        if (set === undefined) return;
        for (const h of [...set]) {
          try { h(msg.payload ?? ''); } catch (cause) {
            process.stderr.write(`[notify] handler failed on ${msg.channel}: ${String((cause as Error).message ?? cause)}\n`);
          }
        }
      });
      const onGone = (): void => {
        if (this.listenClient === c) this.listenClient = undefined;
        try { c.release(true as any); } catch { /* already destroyed */ }
        if (!this.disposed) setTimeout(() => void this.ensureListener(), 2000);
      };
      c.on('error', onGone);
      for (const channel of this.handlers.keys()) await c.query(`LISTEN ${quoteIdent(channel)}`);
      this.listenClient = c;
      // 订阅可能在建连期间新增：补挂
      for (const channel of this.handlers.keys()) await c.query(`LISTEN ${quoteIdent(channel)}`);
    } catch (cause) {
      process.stderr.write(`[notify] listen connect failed (retry in 2s): ${String((cause as Error).message ?? cause)}\n`);
      if (!this.disposed) setTimeout(() => void this.ensureListener(), 2000);
    } finally {
      this.connecting = false;
    }
  }
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`invalid channel name: ${name}`);
  return `"${name}"`;
}

export { NotifyBridge };
