import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { emitAgentEvent } from '@deepseek-ai/dsh-agent';
import { createPool } from '@opendb-dsh/session-persistence-pg';
import { HostFanout } from './fanout.ts';

export { HostFanout, type FanoutDeps, type FanoutMessage } from './fanout.ts';

export const name = 'host-fanout';
export const inject = ['agents', 'sessions', 'opendbNotify'];
export const Config = z.object({
  connectionString: z.string().required(),
  podName: z.string().default(process.env.OPENDB_POD_NAME ?? process.env.HOSTNAME ?? `host-${process.pid}`),
  /** 新建会话的 seed 经 write-behind 落库可能晚几十毫秒：扇入 resume 前最多等这么久 */
  settleMs: z.number().default(3000),
});

/** PG NOTIFY 通道（opendbNotify 总线，at-most-once 提示信号；漏一条的后果只是那台副本要等下一次触碰） */
export const CHANNEL = 'opendb_host_fanout';

/**
 * cordis 胶水：把本副本的 session/created、agent/status、agent/error 接到 HostFanout，
 * 再把总线消息交给它扇入（resume / 重抛）。见 fanout.ts 头注释。
 */
export function apply(ctx: Context, config: { connectionString: string; podName?: string; settleMs?: number }): void {
  const anyCtx = ctx as any;
  const pool = createPool(config.connectionString);
  const podName = config.podName ?? process.env.OPENDB_POD_NAME ?? process.env.HOSTNAME ?? `host-${process.pid}`;
  const log = (line: string) => process.stderr.write(`[host-fanout] ${line}\n`);

  const fanout = new HostFanout({
    podName,
    settleMs: config.settleMs ?? 3000,
    hasAgent: (id) => anyCtx.agents.get(id) !== undefined,
    resume: async (id) => {
      // 与 apiproxy 的 resume 同款模型选择；预设 setup 在 Host 上不参与运行（Host 不跑 turn），省略
      const sel = anyCtx.get?.('agentDefaultModel')?.currentSelection?.() ?? {};
      await anyCtx.agents.resume({ resumeSessionId: id, agentOptions: { provider: sel.provider, model: sel.model } });
    },
    raise: (id, message) => {
      const agent = anyCtx.agents.get(id);
      if (agent === undefined) return false;
      emitAgentEvent(ctx as any, agent, 'agent/error' as any, { error: new Error(message) } as any);
      return true;
    },
    persisted: async (id) => {
      const r = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM dsh_session_events WHERE session_id = $1', [id]);
      return Number(r.rows[0]?.n ?? 0) > 0;
    },
    publish: (msg) => anyCtx.opendbNotify.publish(CHANNEL, JSON.stringify(msg)),
    log,
  });

  ctx.on('session/created' as any, (session: any) => fanout.onSessionCreated(String(session.id)));
  ctx.on('agent/status' as any, ({ agent, status }: any) => fanout.onAgentStatus(String(agent.id), String(status)));
  ctx.on('agent/error' as any, ({ agent, error }: any) => fanout.onAgentError(String(agent.id), String(error?.message ?? error)));
  ctx.effect(() => anyCtx.opendbNotify.subscribe(CHANNEL, (payload: string) => {
    void fanout.handle(payload).catch((err: unknown) => log(`inbound failed: ${String(err)}`));
  }), 'hostFanout.subscribe');
  ctx.effect(() => () => pool.end(), 'hostFanout.pool');
}
