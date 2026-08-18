import type { Context } from '@deepseek-ai/cordis';

export const name = 'ui-opendb';
export const inject = ['connection', 'webServer', 'opendbRegistry'];

type RpcResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } };

function bad(message: string): RpcResult {
  return { ok: false, error: { code: 'bad-request', message, details: {} } };
}

/**
 * Host half of the OpenDB management UI: the `/opendb` RPC channel (design §research:
 * single-segment channel via connection.rpc.handle; POST /opendb/<endpoint> with the
 * client-request envelope). The browser half (lib/client.js) renders a settings section
 * that drives these endpoints.
 */
export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  const registry = anyCtx.opendbRegistry;

  ctx.effect(() => anyCtx.connection.rpc.handle('/opendb', async (endpoint: string, payload: any, _signal: AbortSignal): Promise<RpcResult> => {
    try {
      switch (endpoint) {
        case 'agents/list': {
          const agents = await registry.listAgents();
          const nodes = await registry.listNodes();
          const counts = new Map<string, number>();
          for (const n of nodes) if (n.agentId) counts.set(n.agentId, (counts.get(n.agentId) ?? 0) + 1);
          return { ok: true, value: { agents: agents.map((a: any) => ({ ...a, nodeCount: counts.get(a.id) ?? 0 })) } };
        }
        case 'agents/update': {
          if (typeof payload?.id !== 'string') return bad('id required');
          const updated = await registry.updateAgent(payload.id, payload.patch ?? {});
          return updated ? { ok: true, value: { agent: updated } } : bad(`agent ${payload.id} not found`);
        }
        case 'agents/setInstructions': {
          if (typeof payload?.id !== 'string' || typeof payload?.doc !== 'string') return bad('id and doc required');
          const updated = await registry.setInstructionDoc(payload.id, payload.doc);
          return updated ? { ok: true, value: { agent: updated } } : bad(`agent ${payload.id} not found`);
        }
        case 'nodes/list':
          return { ok: true, value: { nodes: await registry.listNodes(typeof payload?.agentId === 'string' ? { agentId: payload.agentId } : {}) } };
        case 'nodes/create': {
          if (typeof payload?.name !== 'string' || typeof payload?.host !== 'string') return bad('name and host required');
          const node = await registry.createNode({
            name: payload.name, host: payload.host,
            port: typeof payload.port === 'number' ? payload.port : undefined,
            engine: payload.engine === 'postgresql' ? 'postgresql' : 'opengauss',
            dbname: typeof payload.dbname === 'string' ? payload.dbname : undefined,
            username: typeof payload.username === 'string' ? payload.username : undefined,
            sshTarget: typeof payload.sshTarget === 'string' ? payload.sshTarget : undefined,
            agentId: typeof payload.agentId === 'string' ? payload.agentId : undefined,
          });
          return { ok: true, value: { node } };
        }
        case 'nodes/assign': {
          if (typeof payload?.nodeId !== 'string') return bad('nodeId required');
          await registry.assignNode(payload.nodeId, typeof payload.agentId === 'string' ? payload.agentId : null);
          return { ok: true, value: {} };
        }
        default:
          return bad(`unknown endpoint ${endpoint}`);
      }
    } catch (cause) {
      return { ok: false, error: { code: 'internal', message: String(cause), details: {} } };
    }
  }, { authority: 'trusted-host' }), 'ui-opendb./opendb');
}
