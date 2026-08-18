import z from '@deepseek-ai/schemastery';
import type { TaskType, TaskRecord } from './types.ts';

/** 内置「定时对话」类型（G1 决策 1：收编 dsh_schedules 的裸定时场景）。 */
export const PROMPT_TASK_TYPE: TaskType<{ prompt: string }> = {
  key: 'prompt',
  title: '定时对话',
  runMode: 'session',
  report: 'optional',
  configSchema: z.object({ prompt: z.string().required().description('到点发给 agent 的提示词') }),
  reportSchema: z.any(),
  async buildPrompt(task: TaskRecord<{ prompt: string }>): Promise<string> {
    return task.config.prompt;
  },
};
