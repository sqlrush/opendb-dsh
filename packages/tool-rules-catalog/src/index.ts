/**
 * tool-rules-catalog — rules_catalog 工具（task-rules 的会话半边，Runtime 侧）。
 * 任意会话可用："平台现在有哪些规则/阈值" → markdown 目录（会话简易 UI）。
 * 独立 function plugin（工具注册定论），无数据库依赖——目录是代码内置事实。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { catalogMarkdown } from '@opendb-dsh/task-rules';

export const name = 'tool-rules-catalog';
export const inject = ['opendbTasks'];
export const Config = z.object({});

export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  anyCtx.inject(['tools'], (c: any) => {
    c.effect(() => c.tools.register(defineTool({
      name: 'rules_catalog',
      description: 'opendb-dsh 平台规则目录：四个任务插件（健康检查/SQL 审核/WDR/DDL 追溯）当前使用的全部确定性规则、阈值阶梯、归因纪律与实现位置。回答"平台现在按什么规则判定"类问题的权威来源。',
      parameters: {
        plugin: { type: 'string', description: '只看某个插件（health/sqlreview/wdr/ddl）；省略 = 全部。' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true } } },
        render: (_args: unknown, value: any) => [{ type: 'text', text: value.content }],
      },
      async execute(args: any) {
        return { content: catalogMarkdown(typeof args.plugin === 'string' ? args.plugin : undefined) };
      },
    } as any)), 'tool-rules-catalog.rules_catalog');
  });
}
