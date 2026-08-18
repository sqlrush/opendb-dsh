import type { Context } from '@deepseek-ai/cordis';
import { defineTaskReportTool } from '@opendb-dsh/tasks';

export const name = 'tool-task-report';
export const inject = ['opendbTasks', 'tools'];

/**
 * task_report 工具注册（function plugin，同 tool-db 的已验证模式）。
 * 单独成包的原因（W4 事故）：Service 构造器内 anyCtx.inject(['tools']) 的注册不生效，
 * 模型工具列表里根本没有 task_report；function plugin + 顶层 inject 是被验证过的路径。
 */
export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  const tasks = anyCtx.opendbTasks;
  ctx.effect(
    () => anyCtx.tools.register(defineTaskReportTool({ pool: tasks.pool, getType: (key: string) => tasks.getType(key) })),
    'tool-task-report.task_report',
  );
}
