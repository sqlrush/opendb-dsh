import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'instructions-pg';
export const inject = ['opendbRegistry'];
export const Config = z.object({ maxBytes: z.number().step(1).min(1).default(65536) });

interface InjectedState { version: number }

/**
 * 「本会话是否已注入过」必须**无状态判断**——直接看消息列表里有没有自己的 snapshot。
 * 进程内 Map 行不通：插件 apply 在 agent 作用域反复执行（apply 内的 Map 每轮新建），
 * 提到模块级又跨不了多副本 Runtime（实测 6 轮仍注入 4 次）。消息列表是会话的唯一真相，
 * 跨 pod、跨重启、跨 resume 都正确。（2026-08-22 与原生 dsh 对比：原生只在首步注入一次。）
 */
export function alreadyInjected(messages: unknown[], plugin: string): boolean {
  return messages.some((m) => {
    const src = (m as any)?.source;
    return src?.kind === 'plugin' && src?.plugin === plugin;
  });
}
/** 指令版本水位（仅用于「文档改了就重注一次」，缺失时退化为不重注——安全侧） */
const lastVersion = new Map<string, number>();

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
  const anyCtx = ctx as any;
  anyCtx.on('agent/pre-step', async ({ agent, messages, turn, step }: any, next: () => Promise<any>) => {
    const decision = await next();
    // 只在会话首轮首步注入（同 memory-context：decision.messages 不含历史，进程内去重表
    // 跨不了多副本 Runtime；turn/step 是服务端给的会话级事实）
    if (decision.kind === 'reject' || Number(turn) > 1 || Number(step) > 1) return decision;
    try {
      const registry = anyCtx.opendbRegistry;
      const sessionAgent = await resolveAgent(registry, agent);
      if (!sessionAgent || sessionAgent.instructionDoc.trim() === '') return decision;
      // 已注入过就跳过；指令版本变了则允许重注（内容确实变了才值得再占一条消息）
      if (alreadyInjected(decision.messages as unknown[], '@opendb-dsh/instructions-pg')
        && lastVersion.get(String(agent?.id ?? '')) === sessionAgent.instructionVersion) return decision;
      let doc = sessionAgent.instructionDoc;
      if (Buffer.byteLength(doc, 'utf8') > maxBytes) doc = Buffer.from(doc, 'utf8').subarray(0, maxBytes).toString('utf8') + '\n\n[指令过长已截断]';
      const message = createUserMessage({
        content: [{ type: 'text', text: frame(sessionAgent.name, doc) }],
        source: { kind: 'plugin', plugin: '@opendb-dsh/instructions-pg', form: 'snapshot' },
      } as any);
      lastVersion.set(String(agent?.id ?? ''), sessionAgent.instructionVersion);
      if (lastVersion.size > 500) for (const k of [...lastVersion.keys()].slice(0, 250)) lastVersion.delete(k);
      const lastClaimedIndex = decision.messages.findLastIndex((m: unknown) => (messages as unknown[]).includes(m));
      return { kind: 'enter', messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, message) };
    } catch (err) {
      process.stderr.write(`[instructions-pg] injection skipped: ${String(err)}\n`);
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
  if (m) return registry.getAgentByName(decodeURIComponent(m[1]));
  return undefined;
}
