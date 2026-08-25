/**
 * tool-thresholds — threshold_list / threshold_set / threshold_reset（task-thresholds 的会话半边，Runtime 侧）。
 * user 2026-08-24：独立插件展示 opendb 所有报警/判定阈值，支持对话修改；修改须模型复述并用
 * ask_user_question 确认后才落库（与 task_create 同一确认纪律）；改完下一次采集即生效。
 *
 * 独立 function plugin（工具注册定论：顶层 inject 数据服务 + 嵌套只 inject(['tools'])）。
 * 输出 = `--` 注释头 + JSON（与各 *_collect 工具同形，ui-task-inline 据此渲染会话卡）。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ThresholdValue } from '@opendb-dsh/thresholds-pg';

export const name = 'tool-thresholds';
export const inject = ['opendbThresholds'];
export const Config = z.object({});

const TEXT_OUTPUT = {
  schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true } } },
  render: (_args: unknown, value: any) => [{ type: 'text', text: value.content }],
} as const;

const PLUGIN_TITLE: Record<string, string> = { health: '健康检查', sqlreview: 'SQL 审核', wdr: 'WDR 窗口', ddl: 'DDL 追溯' };

/** 单位友好显示：ratio 显示百分比，bytes 显示 MB，其余原值带单位 */
export function fmtValue(v: number, unit: string): string {
  switch (unit) {
    case 'ratio': return `${Math.round(v * 10000) / 100}%`;
    case 'bytes': return v >= 1024 * 1024 ? `${Math.round(v / 1024 / 1024)}MB` : `${v}B`;
    case 'ms': return `${v}ms`;
    case 's': return `${v}s`;
    case 'hour': return `${v} 点`;
    case 'x': return `${v}`;
    default: return `${v}`;
  }
}

function sessionOf(exec: any): string {
  const id = exec?.agent?.id;
  return typeof id === 'string' ? id : 'session';
}

function itemView(v: ThresholdValue): Record<string, unknown> {
  return {
    key: v.key, label: v.label, rule: v.rule, cmp: v.cmp, unit: v.unit, desc: v.desc,
    default: v.default, current: v.current, overridden: v.overridden,
    defaultText: fmtValue(v.default, v.unit), currentText: fmtValue(v.current, v.unit),
    ...(v.overridden ? { updatedAt: v.updatedAt, updatedBy: v.updatedBy, reason: v.reason } : {}),
  };
}

function defineListTool(thresholds: any) {
  return defineTool({
    name: 'threshold_list',
    description: 'opendb-dsh 平台全部报警/判定阈值的权威清单：四个任务插件（健康检查/SQL 审核/WDR/DDL 追溯）每个数值判据的默认值、当前值、是否被改过、判定方向与单位。回答「现在的阈值是多少」「哪些阈值被改过」类问题用它；要改阈值先用它确认 key 与当前值。',
    parameters: {
      plugin: { type: 'string', description: '只看某个插件（health/sqlreview/wdr/ddl）；省略 = 全部。' },
      only_overridden: { type: 'boolean', description: 'true = 只列被改过的阈值。' },
    },
    output: TEXT_OUTPUT,
    async execute(args: any) {
      const plugin = typeof args.plugin === 'string' && args.plugin !== '' ? args.plugin : undefined;
      const all: ThresholdValue[] = await thresholds.list(plugin);
      const picked = args.only_overridden === true ? all.filter((v) => v.overridden) : all;
      const byPlugin = new Map<string, ThresholdValue[]>();
      for (const v of picked) byPlugin.set(v.plugin, [...(byPlugin.get(v.plugin) ?? []), v]);
      const payload = {
        total: all.length,
        overridden: all.filter((v) => v.overridden).length,
        groups: [...byPlugin.entries()].map(([p, items]) => ({ plugin: p, title: PLUGIN_TITLE[p] ?? p, items: items.map(itemView) })),
      };
      const header = [
        `-- threshold_list · ${payload.total} 个阈值 · ${payload.overridden} 个被改过${plugin !== undefined ? ` · 只看 ${plugin}` : ''}`,
        '-- key 是修改时用的标识（如 health / connRatio.warn）；cmp 是判定方向（>= 越大越严重，< 越小越严重）',
        '-- 向用户展示时用 currentText/defaultText（已带单位），不要把 ratio 的 0.8 直接念成 0.8',
      ].join('\n');
      return { content: `${header}\n${JSON.stringify(payload, null, 1)}` };
    },
  } as any);
}

function defineSetTool(thresholds: any) {
  return defineTool({
    name: 'threshold_set',
    description: '修改一个平台阈值（改完下一次采集即生效，之前的报告不变）。**调用前必须走确认流**：1) 用 threshold_list 确认 key 存在与当前值；2) 向用户复述「哪个插件 / 哪个阈值 / 旧值 → 新值 / 影响哪条规则」；3) 用 ask_user_question 让用户确认；4) 用户明确同意后才调用本工具。校验失败（超范围、破坏阶梯单调）会报错，把原因转告用户即可，不要自行换值重试。',
    parameters: {
      plugin: { type: 'string', required: true, description: '插件 key：health / sqlreview / wdr / ddl。' },
      key: { type: 'string', required: true, description: '阈值 key（threshold_list 里的 key），如 connRatio.warn、bloatMinLive。' },
      value: { type: 'number', required: true, description: '新值。比例类用 0~1（80% 写 0.8），字节类写字节数，时间类按该阈值的单位。' },
      reason: { type: 'string', description: '修改原因（记入变更历史，建议填用户的原话）。' },
    },
    output: TEXT_OUTPUT,
    async execute(args: any, exec: any) {
      const value = Number(args.value);
      if (!Number.isFinite(value)) return { content: '-- threshold_set 失败\nvalue 必须是数值' };
      try {
        const r = await thresholds.set(String(args.plugin ?? ''), String(args.key ?? ''), value, {
          by: sessionOf(exec), reason: typeof args.reason === 'string' ? args.reason : '',
        });
        const payload = {
          action: 'set', plugin: r.spec.plugin, key: r.spec.key, label: r.spec.label, rule: r.spec.rule, unit: r.spec.unit,
          oldValue: r.oldValue, newValue: r.newValue,
          oldText: fmtValue(r.oldValue, r.spec.unit), newText: fmtValue(r.newValue, r.spec.unit),
          reason: typeof args.reason === 'string' ? args.reason : '', effective: '下一次采集起生效',
        };
        return { content: `-- threshold_set · ${r.spec.label}：${payload.oldText} → ${payload.newText}（规则 ${r.spec.rule}，下一次采集起生效）\n${JSON.stringify(payload, null, 1)}` };
      } catch (cause) {
        return { content: `-- threshold_set 失败（未做任何修改）\n${String((cause as Error).message ?? cause)}` };
      }
    },
  } as any);
}

function defineResetTool(thresholds: any) {
  return defineTool({
    name: 'threshold_reset',
    description: '把一个被改过的阈值重置回代码默认值。与 threshold_set 同一确认纪律：先复述「哪个阈值 / 当前值 → 默认值」，ask_user_question 确认后才调用。',
    parameters: {
      plugin: { type: 'string', required: true, description: '插件 key：health / sqlreview / wdr / ddl。' },
      key: { type: 'string', required: true, description: '阈值 key。' },
      reason: { type: 'string', description: '重置原因（记入变更历史）。' },
    },
    output: TEXT_OUTPUT,
    async execute(args: any, exec: any) {
      try {
        const r = await thresholds.reset(String(args.plugin ?? ''), String(args.key ?? ''), {
          by: sessionOf(exec), reason: typeof args.reason === 'string' ? args.reason : '',
        });
        const payload = {
          action: 'reset', plugin: r.spec.plugin, key: r.spec.key, label: r.spec.label, rule: r.spec.rule, unit: r.spec.unit,
          oldValue: r.oldValue, newValue: r.newValue, changed: r.changed,
          oldText: fmtValue(r.oldValue, r.spec.unit), newText: fmtValue(r.newValue, r.spec.unit),
          effective: r.changed ? '下一次采集起生效' : '该阈值本就是默认值，无需重置',
        };
        return { content: `-- threshold_reset · ${r.spec.label}：${r.changed ? `${payload.oldText} → 默认 ${payload.newText}` : '本就是默认值'}\n${JSON.stringify(payload, null, 1)}` };
      } catch (cause) {
        return { content: `-- threshold_reset 失败（未做任何修改）\n${String((cause as Error).message ?? cause)}` };
      }
    },
  } as any);
}

export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  anyCtx.inject(['tools'], (c: any) => {
    const thresholds = anyCtx.opendbThresholds;
    c.effect(() => c.tools.register(defineListTool(thresholds)), 'tool-thresholds.threshold_list');
    c.effect(() => c.tools.register(defineSetTool(thresholds)), 'tool-thresholds.threshold_set');
    c.effect(() => c.tools.register(defineResetTool(thresholds)), 'tool-thresholds.threshold_reset');
  });
}
