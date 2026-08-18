import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'instructions-pg';
export const inject = ['registry'];
export const Config = z.object({ maxBytes: z.number().step(1).min(1).default(65536) });

interface InjectedState { version: number }

function frame(agentName: string, doc: string): string {
  return `<system-reminder>\n以下是数据库运维平台为 agent「${agentName}」配置的常驻指令（由平台管理员维护，优先级高于会话内偏好）：\n\n${doc}\n</system-reminder>`;
}

/**
 * Inject the registry's instruction_doc for the agent bound to this session's workspace
 * as an authority user message on step 1, and again whenever instruction_version changes
 * (design §3.6 常驻指令层; replaces dsh-agent-instructions' AGENTS.md scan).
 */
export function apply(ctx: Context, config: { maxBytes?: number }): void {
  const maxBytes = config.maxBytes ?? 65536;
  const injected = new WeakMap<object, InjectedState>();
  const anyCtx = ctx as any;
  anyCtx.on('agent/pre-step', async ({ agent, messages }: any, next: () => Promise<any>) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    try {
      const registry = anyCtx.registry;
      const sessionAgent = await resolveAgent(registry, agent);
      if (!sessionAgent || sessionAgent.instructionDoc.trim() === '') return decision;
      const state = injected.get(agent);
      if (state !== undefined && state.version === sessionAgent.instructionVersion) return decision;
      let doc = sessionAgent.instructionDoc;
      if (Buffer.byteLength(doc, 'utf8') > maxBytes) doc = Buffer.from(doc, 'utf8').subarray(0, maxBytes).toString('utf8') + '\n\n[指令过长已截断]';
      const message = createUserMessage({
        content: [{ type: 'text', text: frame(sessionAgent.name, doc) }],
        source: { kind: 'plugin', plugin: '@opendb-dsh/instructions-pg', form: 'snapshot' },
      } as any);
      injected.set(agent, { version: sessionAgent.instructionVersion });
      const lastClaimedIndex = decision.messages.findLastIndex((m: unknown) => (messages as unknown[]).includes(m));
      return { kind: 'enter', messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, message) };
    } catch {
      return decision;   // registry unavailable → run without standing instructions
    }
  });
}

/** The session's agent record: workspace binding first (workspace == agent), name fallback later (W2 UI wires the binding). */
async function resolveAgent(registry: any, agent: any): Promise<{ name: string; instructionDoc: string; instructionVersion: number } | undefined> {
  const workspaceId = agent.session?.header?.metadata?.workspaceId ?? agent.session?.header?.workspaceId;
  if (workspaceId) {
    const byWs = await registry.getAgentByWorkspace(String(workspaceId));
    if (byWs) return byWs;
  }
  const cwd: string | undefined = agent.session?.header?.cwd;
  const m = cwd ? /\/agents\/([^/]+)\/?$/.exec(cwd) : null;   // $DSH_HOME/agents/<agent-id>
  if (m) return registry.getAgent(m[1]);
  return undefined;
}
