import type { Context } from '@deepseek-ai/cordis';

export const name = 'ui-knowledge';
export const inject = ['connection', 'webServer', 'opendbKnowledge', 'opendbRegistry'];

interface RpcResult { ok: boolean; value?: unknown; error?: { code: string; message: string; details: object } }

/** 知识库管理的 Host 半边：/opendb-knowledge 通道（列表/灌入/删除/检索试验）。 */
export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  const knowledge = anyCtx.opendbKnowledge;
  const registry = anyCtx.opendbRegistry;

  ctx.effect(() => anyCtx.connection.rpc.handle('/opendb-knowledge', async (endpoint: string, payload: any): Promise<RpcResult> => {
    try {
      switch (endpoint) {
        case 'docs/list': {
          const [docs, agents] = await Promise.all([knowledge.listDocs({}), registry.listAgents()]);
          const names = new Map(agents.map((a: any) => [a.id, a.name]));
          return { ok: true, value: { docs: docs.map((d: any) => ({ ...d, agentName: d.agentId ? names.get(d.agentId) ?? d.agentId : undefined })) } };
        }
        case 'docs/ingest': {
          const doc = await knowledge.ingest({
            agentId: payload.global === true ? undefined : payload.agentId,
            title: String(payload.title ?? ''),
            source: typeof payload.source === 'string' && payload.source !== '' ? payload.source : undefined,
            text: String(payload.text ?? ''),
          });
          return { ok: true, value: { doc } };
        }
        case 'docs/remove':
          await knowledge.removeDoc(String(payload.id ?? ''));
          return { ok: true, value: { removed: true } };
        case 'search': {
          const hits = await knowledge.search({ agentId: payload.agentId, query: String(payload.query ?? ''), topK: 5 });
          return { ok: true, value: { hits } };
        }
        default:
          return { ok: false, error: { code: 'bad-request', message: `unknown endpoint ${endpoint}`, details: {} } };
      }
    } catch (cause) {
      return { ok: false, error: { code: 'internal', message: String((cause as Error).message ?? cause), details: {} } };
    }
  }, { authority: 'trusted-host' }), 'ui-knowledge.rpc');
}
