import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'memory-context';
export const inject = ['opendbMemory', 'opendbRegistry'];
export const Config = z.object({
  recentCount: z.number().step(1).min(0).default(3),
  searchCount: z.number().step(1).min(0).default(4),
  maxBytes: z.number().step(1).min(512).default(6144),
  // 2026-08-22 事故：语义检索要先算 embedding，Ollama bge-m3 在 CPU 上实测 5-6s/次，
  // 卡在 agent/pre-step 上 → 用户消息要等上下文组装完才落库上屏，聊天框空窗 3-6 秒。
  // 超时后降级为「只用最近记忆」（纯 PG 查询，毫秒级），对话永远优先。
  searchTimeoutMs: z.number().step(1).min(100).default(1200).description('语义检索超时；超时降级为仅最近记忆'),
});

/** 超时包装：到点就返回兜底值，不抛错、不阻塞对话 */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.catch(() => fallback),
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Pure: merge recent + searched memories (dedup by id), render the system-reminder text. */
export function renderMemoryContext(
  recent: { id: string; kind: string; createdAt: Date; content: string }[],
  searched: { id: string; kind: string; createdAt: Date; content: string }[],
  maxBytes: number,
): string | undefined {
  const seen = new Set<string>();
  const merged = [...searched, ...recent].filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  if (merged.length === 0) return undefined;
  const lines: string[] = [];
  for (const m of merged) {
    const line = `- (${new Date(m.createdAt).toISOString().slice(0, 10)}·${m.kind}) ${m.content.replace(/\n/g, ' ')}`;
    lines.push(line);
    if (Buffer.byteLength(lines.join('\n'), 'utf8') > maxBytes) { lines.pop(); break; }
  }
  if (lines.length === 0) return undefined;
  return `<system-reminder>\n以下是平台记忆库中与本 agent 相关的记忆（供参考，未必与当前问题相关；引用时注明日期）：\n\n${lines.join('\n')}\n</system-reminder>`;
}

/** 从会话 agent 解析平台 agent（instructions-pg 同款约定）。 */
async function resolveAgentId(registry: any, agent: any): Promise<string | undefined> {
  const header = agent?.session?.header;
  const workspaceId = header?.metadata?.workspaceId ?? header?.workspaceId;
  if (workspaceId) {
    const byWs = await registry.getAgentByWorkspace(String(workspaceId));
    if (byWs) return byWs.id;
  }
  const cwd: string | undefined = header?.cwd;
  const m = cwd ? /\/agents\/([^/]+)\/?$/.exec(cwd) : null;
  if (m) return (await registry.getAgentByName(decodeURIComponent(m[1])))?.id;
  return undefined;
}

/** 提取本回合最新用户文本作为检索 query。 */
export function latestUserText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as any;
    if (m?.role !== 'user' || m?.source?.kind === 'plugin') continue;
    const texts = Array.isArray(m.content) ? m.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text) : [];
    const joined = texts.join(' ').trim();
    if (joined !== '') return joined.slice(0, 500);
  }
  return '';
}

/**
 * 会话记忆注入（W5 批次2，设计 §8.3）：agent/pre-step 第 1 步把「最近记忆 + 与用户消息
 * 语义相关的记忆」作为 system-reminder 注入（instructions-pg 同款已验证钩子模式）。
 * 每会话注入一次；记忆层故障时静默跳过（对话永远可用）。
 */
export function apply(ctx: Context, config: { recentCount?: number; searchCount?: number; maxBytes?: number; searchTimeoutMs?: number } = {}): void {
  const anyCtx = ctx as any;
  const recentCount = config.recentCount ?? 3;
  const searchCount = config.searchCount ?? 4;
  const maxBytes = config.maxBytes ?? 6144;
  const searchTimeoutMs = config.searchTimeoutMs ?? 1200;
  const injected = new WeakSet<object>();

  anyCtx.on('agent/pre-step', async ({ agent, messages }: any, next: () => Promise<any>) => {
    const decision = await next();
    if (decision.kind === 'reject' || injected.has(agent)) return decision;
    try {
      const agentId = await resolveAgentId(anyCtx.opendbRegistry, agent);
      if (agentId === undefined) return decision;
      const memory = anyCtx.opendbMemory;
      const query = latestUserText(messages as unknown[]);
      const [recent, searched] = await Promise.all([
        withTimeout(recentCount > 0 ? memory.recent({ agentId, limit: recentCount }) : Promise.resolve([]), searchTimeoutMs, []),
        // 语义检索超时即降级：宁可少注入几条记忆，也不让用户对着空聊天框等 5 秒
        withTimeout(searchCount > 0 && query !== '' ? memory.search({ agentId, query, topK: searchCount }) : Promise.resolve([]), searchTimeoutMs, []),
      ]);
      const text = renderMemoryContext(recent, searched, maxBytes);
      injected.add(agent);
      if (text === undefined) return decision;
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: '@opendb-dsh/memory-context', form: 'snapshot' },
      } as any);
      const lastClaimedIndex = decision.messages.findLastIndex((m: unknown) => (messages as unknown[]).includes(m));
      return { kind: 'enter', messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, message) };
    } catch (cause) {
      process.stderr.write(`[memory-context] 注入跳过：${String((cause as Error).message ?? cause)}\n`);
      return decision;
    }
  });
}
