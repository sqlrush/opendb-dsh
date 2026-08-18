import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';

export const name = 'memory-ingest';
export const inject = ['opendbMemory', 'opendbTasks', 'opendbRegistry'];
export const Config = z.object({ scanMs: z.number().step(1).min(10_000).default(60_000), maxFindings: z.number().step(1).min(1).default(5) });

/** Pure formatter: one task report → one memory text (unit-tested). */
export function formatReportMemory(input: {
  date: string; taskName: string; taskType: string; severity: string; summary: string;
  findings: { node?: string; item?: string; level?: string; detail?: string; sql?: string; issue?: string; suggestion?: string }[];
  maxFindings: number;
}): string {
  const lines = [`[${input.date}] 任务「${input.taskName}」(${input.taskType}) 结论 ${input.severity}：${input.summary}`];
  for (const f of input.findings.slice(0, input.maxFindings)) {
    if (f.issue !== undefined) lines.push(`- ${f.sql !== undefined ? `SQL「${String(f.sql).slice(0, 80)}」` : ''}${f.issue}${f.suggestion !== undefined ? `（建议：${f.suggestion}）` : ''}`);
    else lines.push(`- [${f.level ?? '?'}] ${f.node ?? ''} ${f.item ?? ''}${f.detail !== undefined && f.detail !== '' ? `：${String(f.detail).slice(0, 120)}` : ''}`);
  }
  if (input.findings.length > input.maxFindings) lines.push(`（其余 ${input.findings.length - input.maxFindings} 条略）`);
  return lines.join('\n');
}

/**
 * 任务报告 → agent 记忆（W5 批次2）：Host 侧定时扫描新报告，格式化为一条 kind=report
 * 的记忆（source=run id 幂等），让「次日对话能引用昨日巡检结论」。
 */
export function apply(ctx: Context, config: { scanMs?: number; maxFindings?: number } = {}): void {
  const anyCtx = ctx as any;
  const memory = anyCtx.opendbMemory;
  const tasks = anyCtx.opendbTasks;
  const scanMs = config.scanMs ?? 60_000;
  const maxFindings = config.maxFindings ?? 5;

  async function scanOnce(): Promise<void> {
    const r = await tasks.pool.query(
      `SELECT p.run_id, p.severity, p.summary, p.data, p.created_at, t.name, t.type, t.agent_id
       FROM dsh_task_reports p JOIN dsh_tasks t ON t.id = p.task_id
       WHERE p.created_at > now() - interval '7 days'
         AND NOT EXISTS (SELECT 1 FROM opendb_memories m WHERE m.agent_id = t.agent_id AND m.source = 'report:' || p.run_id)
       ORDER BY p.created_at LIMIT 20`,
    );
    for (const raw of r.rows) {
      const findings = Array.isArray(raw.data?.findings) ? raw.data.findings : [];
      const content = formatReportMemory({
        date: new Date(raw.created_at).toISOString().slice(0, 10),
        taskName: raw.name, taskType: raw.type, severity: raw.severity, summary: raw.summary,
        findings, maxFindings,
      });
      try {
        await memory.write({ agentId: raw.agent_id, kind: 'report', content, source: `report:${raw.run_id}` });
        process.stderr.write(`[memory-ingest] 报告入记忆：${raw.name} (${raw.run_id})\n`);
      } catch (cause) {
        process.stderr.write(`[memory-ingest] 写入失败 ${raw.run_id}: ${String((cause as Error).message ?? cause)}\n`);
      }
    }
  }

  ctx.effect(() => {
    const timer = setInterval(() => { void scanOnce().catch((cause) => process.stderr.write(`[memory-ingest] scan failed: ${String(cause)}\n`)); }, scanMs);
    void scanOnce().catch(() => {});
    return () => clearInterval(timer);
  }, 'memory-ingest.scan');
}
