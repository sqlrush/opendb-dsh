import type { Context } from '@deepseek-ai/cordis';

export const name = 'ui-memory';
export const inject = ['connection', 'webServer', 'opendbMemory', 'opendbRegistry'];

interface RpcResult { ok: boolean; value?: unknown; error?: { code: string; message: string; details: object } }

/** 记忆管理的 Host 半边：/opendb-memory 通道（列表/检索/修剪）。 */
export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  const memory = anyCtx.opendbMemory;
  const registry = anyCtx.opendbRegistry;

  ctx.effect(() => anyCtx.connection.rpc.handle('/opendb-memory', async (endpoint: string, payload: any): Promise<RpcResult> => {
    try {
      switch (endpoint) {
        case 'list': {
          const [rows, agents] = await Promise.all([
            memory.list({ agentId: payload.agentId, kind: payload.kind, limit: 200 }),
            registry.listAgents(),
          ]);
          const names = new Map(agents.map((a: any) => [a.id, a.name]));
          return { ok: true, value: { memories: rows.map((m: any) => ({ ...m, agentName: names.get(m.agentId) ?? m.agentId })), agents } };
        }
        case 'search': {
          const rows = await memory.search({ agentId: String(payload.agentId ?? ''), query: String(payload.query ?? ''), topK: 10 });
          return { ok: true, value: { memories: rows } };
        }
        case 'remove':
          await memory.remove(String(payload.id ?? ''));
          return { ok: true, value: { removed: true } };
        default:
          return { ok: false, error: { code: 'bad-request', message: `unknown endpoint ${endpoint}`, details: {} } };
      }
    } catch (cause) {
      return { ok: false, error: { code: 'internal', message: String((cause as Error).message ?? cause), details: {} } };
    }
  }, { authority: 'trusted-host' }), 'ui-memory.rpc');
}
