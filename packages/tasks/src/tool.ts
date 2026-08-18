import { defineTool } from '@deepseek-ai/dsh-tools';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { TaskType, Severity } from './types.ts';

const SEVERITIES: readonly Severity[] = ['ok', 'warn', 'critical'];

export interface TaskReportToolDeps { pool: pg.Pool; getType(key: string): TaskType | undefined }

/**
 * task_report — 任务报告唯一提交通道（G1 决策 3）。运行在 Runtime；经 exec.agent.id ==
 * sessionId（P0 约定）定位 running 的任务运行；data 按任务类型 reportSchema 校验，
 * 校验失败即工具报错 → 模型看到具体原因自动修正重交（dsh 工具循环原生重试）。
 */
export function defineTaskReportTool(deps: TaskReportToolDeps) {
  return defineTool({
    name: 'task_report',
    description: '提交本次任务运行的结构化结论报告（仅任务会话可用；severity: ok|warn|critical；data 结构以本任务类型要求为准）。',
    parameters: {
      severity: { type: 'string', required: true, description: '总体结论级别：ok（正常）| warn（需关注）| critical（需立即处理）。' },
      summary: { type: 'string', required: true, description: '一句话结论（将展示在任务列表与审批卡片上）。' },
      data: { type: 'object', required: true, description: '结构化明细，字段结构以任务提示词中的要求为准。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { content: { type: 'string', required: true } },
      },
      render: (_args: unknown, value: any) => [{ type: 'text', text: value.content }],
    },
    async execute(args: any, exec: any) {
      const sessionId: string | undefined = exec?.agent?.id;
      if (typeof sessionId !== 'string' || sessionId === '') throw new Error('task_report 只能在任务会话中调用（无会话上下文）');
      const r = await deps.pool.query(
        `SELECT r.id AS run_id, r.task_id, t.type, t.name
         FROM dsh_task_runs r JOIN dsh_tasks t ON t.id = r.task_id
         WHERE r.session_id = $1 AND r.status IN ('running','timeout')   -- 迟到报告好过丢失：超时后送达仍接收
         ORDER BY r.fired_at DESC LIMIT 1`,
        [sessionId],
      );
      const run = r.rows[0];
      if (run === undefined) throw new Error('当前会话不是运行中的任务会话，无需提交任务报告');
      const type = deps.getType(run.type);
      if (type === undefined) throw new Error(`任务类型 ${run.type} 未在本运行环境注册`);
      if (type.report === 'none') throw new Error(`任务类型 ${type.title} 不接收报告`);
      const severity = String(args.severity ?? '');
      if (!SEVERITIES.includes(severity as Severity)) throw new Error(`severity 必须是 ok | warn | critical，收到 "${severity}"`);
      const summary = String(args.summary ?? '').trim();
      if (summary === '') throw new Error('summary 不能为空');
      let data: unknown;
      try {
        data = type.reportSchema(args.data);
      } catch (cause) {
        throw new Error(`data 不符合任务类型「${type.title}」的报告结构：${String((cause as Error).message ?? cause)}`);
      }
      // 幂等：模型重复提交时以最后一次为准
      await deps.pool.query(
        `INSERT INTO dsh_task_reports (id, run_id, task_id, severity, summary, data)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (run_id) DO UPDATE SET severity = EXCLUDED.severity, summary = EXCLUDED.summary, data = EXCLUDED.data, created_at = now()`,
        [`rep-${randomUUID().slice(0, 8)}`, run.run_id, run.task_id, severity, summary, JSON.stringify(data ?? {})],
      );
      await deps.pool.query(
        `UPDATE dsh_task_runs SET status = 'succeeded', finished_at = now(), error = NULL WHERE id = $1 AND status IN ('running','timeout')`,
        [run.run_id],
      );
      return { content: `报告已提交（${severity}）：${summary}` };
    },
  } as any);
}
