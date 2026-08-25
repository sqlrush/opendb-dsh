/**
 * task-thresholds — 平台阈值配置（user 2026-08-24：独立插件展示 opendb 全部报警/判定阈值，
 * 支持对话修改）。双形态：
 * - 任务全 UI：registerTaskPanel('thresholds') 大盘——默认值 vs 当前值、覆盖标记、变更历史（只读展示）；
 * - 会话简易 UI：threshold_list / threshold_set / threshold_reset 工具（tool-thresholds 包），
 *   修改走「模型复述 → ask_user_question 确认 → 落库」，改完下一次采集即生效。
 * 阈值真相：默认值 = 各插件代码常量（启动时向 opendbThresholds 注册），覆盖值 = opendb_thresholds 表。
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { TaskType, TaskRecord } from '@opendb-dsh/tasks';

export const name = 'task-thresholds';
export const inject = ['opendbTasks'];

interface ThresholdsConfig { plugin: string }

export const THRESHOLDS_TASK_TYPE: TaskType<ThresholdsConfig> = {
  key: 'thresholds',
  title: '阈值配置',
  runMode: 'session',
  report: 'optional',
  configSchema: z.object({
    plugin: z.string().default('').description('只看某个插件的阈值（health/sqlreview/wdr/ddl）；空 = 全部'),
  }),
  reportSchema: z.object({
    summary: z.string().default(''),
  }),
  async buildPrompt(task: TaskRecord<ThresholdsConfig>): Promise<string> {
    const only = task.config.plugin !== '' ? task.config.plugin : '';
    return [
      `请展示 opendb-dsh 平台当前的报警/判定阈值${only !== '' ? `（只看 ${only}）` : ''}。`,
      ``,
      `1. 调用 threshold_list${only !== '' ? `（plugin 传 "${only}"）` : ''}——返回四个任务插件全部数值判据的默认值、当前值与是否被改过。`,
      `2. 按插件分组呈现（用 currentText/defaultText，已带单位），被改过的阈值单独列出并注明改动时间与原因。`,
      `3. 本任务只展示，不要调用 threshold_set / threshold_reset；用户要改阈值时在会话里说，走确认流。`,
      `本任务无需 task_report（report=optional）；完整交互式大盘在任务页「阈值配置」面板。`,
    ].join('\n');
  },
};

export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  ctx.effect(() => anyCtx.opendbTasks.register(THRESHOLDS_TASK_TYPE), 'task-thresholds.type');
}
