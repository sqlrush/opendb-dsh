/**
 * task-rules — 平台规则目录（user 2026-08-22 增补）：查看 opendb-dsh 当前使用的全部
 * 确定性规则/阈值/归因纪律。双形态：任务全 UI（registerTaskPanel 静态渲染目录）+
 * 会话简易 UI（rules_catalog 工具输出 markdown，任意会话可问"平台现在有哪些规则"）。
 * 规则数据 = 代码内目录快照（catalog.ts），与各实现常量的同步由单测交叉比对守护。
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { TaskType, TaskRecord } from '@opendb-dsh/tasks';

export { rulesCatalog, catalogMarkdown, HEALTH_T, WDR_T } from './catalog.ts';
export type { RuleGroup, RuleRow } from './catalog.ts';

export const name = 'task-rules';
export const inject = ['opendbTasks'];

interface RulesConfig { plugin: string; focus: string }

export const RULES_TASK_TYPE: TaskType<RulesConfig> = {
  key: 'rules',
  title: '平台规则目录',
  runMode: 'session',
  report: 'optional',
  configSchema: z.object({
    plugin: z.string().default('').description('只看某个插件的规则（health/sqlreview/wdr/ddl）；空 = 全部'),
    focus: z.string().default('').description('额外关注点'),
  }),
  reportSchema: z.object({
    summary: z.string().default(''),
  }),
  async buildPrompt(task: TaskRecord<RulesConfig>): Promise<string> {
    return [
      `请展示 opendb-dsh 平台当前使用的规则目录${task.config.plugin !== '' ? `（只看 ${task.config.plugin}）` : ''}。`,
      ``,
      `1. 调用 rules_catalog${task.config.plugin !== '' ? `（plugin 传 "${task.config.plugin}"）` : ''}——它返回四个任务插件（健康检查/SQL 审核/WDR/DDL 追溯）的确定性规则、阈值阶梯与归因纪律的权威目录。`,
      `2. 在会话里原样呈现目录（markdown 表格保留），并用两三句话概括：规则总数、级别分布、哪些是"确定性联动升级"类规则。`,
      `3. 目录来自代码内置快照，不要增删改任何规则或阈值数字。`,
      task.config.focus !== '' ? `4. 额外关注：${task.config.focus}` : ``,
      `本任务无需 task_report（report=optional）；完整交互式目录在任务大盘的「平台规则目录」面板。`,
    ].filter((l) => l !== '').join('\n');
  },
};

export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  ctx.effect(() => anyCtx.opendbTasks.register(RULES_TASK_TYPE), 'task-rules.type');
}
