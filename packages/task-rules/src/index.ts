/**
 * task-rules — 平台规则目录（user 2026-08-22 增补）：查看 opendb-dsh 当前使用的全部
 * 确定性规则/阈值/归因纪律。双形态：任务全 UI（registerTaskPanel 静态渲染目录）+
 * 会话简易 UI（rules_catalog 工具输出 markdown，任意会话可问"平台现在有哪些规则"）。
 * 规则数据 = 代码内目录快照（catalog.ts），与各实现常量的同步由单测交叉比对守护。
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { TaskType, TaskRecord } from '@opendb-dsh/tasks';
import { catalogCodes } from './catalog.ts';
import { ruleStats } from './stats.ts';

export { rulesCatalog, catalogMarkdown, codesOf, tuneRulesOf, catalogCodes, HEALTH_T, WDR_T, DDL_T, CAP_T } from './catalog.ts';
export type { RuleGroup, RuleRow, RuleStep, RuleLevel } from './catalog.ts';
export { ruleStats } from './stats.ts';
export type { RuleStat, PluginStat } from './stats.ts';

export const name = 'task-rules';
// connection：注册 /opendb-rules 通道给目录面板取命中统计与阈值当前值；
// opendbThresholds：阈值的「默认值 → 当前值 + 谁改的」直接来自服务，目录不再手写一份可调项清单。
export const inject = ['opendbTasks', 'connection', 'opendbThresholds'];

interface RulesConfig { plugin: string; focus: string }

export const RULES_TASK_TYPE: TaskType<RulesConfig> = {
  key: 'rules',
  title: '平台规则目录',
  runMode: 'session',
  report: 'optional',
  configSchema: z.object({
    plugin: z.string().default('').description('只看某个插件的规则（health/sqlreview/wdr/ddl/capacity）；空 = 全部'),
    focus: z.string().default('').description('额外关注点'),
  }),
  reportSchema: z.object({
    summary: z.string().default(''),
  }),
  async buildPrompt(task: TaskRecord<RulesConfig>): Promise<string> {
    return [
      `请展示 opendb-dsh 平台当前使用的规则目录${task.config.plugin !== '' ? `（只看 ${task.config.plugin}）` : ''}。`,
      ``,
      `1. 调用 rules_catalog${task.config.plugin !== '' ? `（plugin 传 "${task.config.plugin}"）` : ''}——它返回五个任务插件（健康检查/SQL 审核/WDR/DDL 追溯/容量与增长）的确定性规则、阈值阶梯与归因纪律的权威目录。`,
      `2. 在会话里原样呈现目录（markdown 表格保留），并用两三句话概括：规则总数、级别分布、哪些是"确定性联动升级"类规则。`,
      `3. 目录来自代码内置快照，不要增删改任何规则或阈值数字。`,
      task.config.focus !== '' ? `4. 额外关注：${task.config.focus}` : ``,
      `本任务无需 task_report（report=optional）；完整交互式目录在任务大盘的「平台规则目录」面板。`,
    ].filter((l) => l !== '').join('\n');
  },
};

/** 目录页要的活数据：命中统计 + 阈值当前值 + 目录漏登记的规则码 */
async function catalogStats(anyCtx: any, days: number): Promise<unknown> {
  const stats = await ruleStats(anyCtx.opendbTasks.pool, days);
  const known = catalogCodes();
  // 存档里出现过、目录却没登记的码——目录漂了就在页面上自己招供，不用等人发现
  const unregistered = stats.flatMap((s) => s.rules.filter((r) => !known.has(r.code)).map((r) => ({ plugin: s.plugin, code: r.code, hit: r.hit })));
  const thresholds = (await anyCtx.opendbThresholds.list()) as any[];
  // 改阈值的人记成 session-xxxx（改动都发生在会话里）；换成会话标题，页面上才读得懂是"哪次对话改的"
  const sids = [...new Set(thresholds.filter((t) => String(t.updatedBy ?? '').startsWith('session-')).map((t) => String(t.updatedBy)))];
  const titles = new Map<string, string>();
  if (sids.length > 0) {
    const r = await anyCtx.opendbTasks.pool.query(
      `SELECT DISTINCT ON (session_id) session_id, data->>'title' AS title
         FROM dsh_session_events WHERE type = 'session/title' AND session_id = ANY($1::text[])
        ORDER BY session_id, seq DESC`, [sids]);
    for (const row of r.rows) titles.set(String(row.session_id), String(row.title ?? ''));
  }
  return {
    days,
    plugins: stats,
    unregistered,
    thresholds: thresholds.map((t) => ({
      plugin: t.plugin, key: t.key, rule: t.rule, label: t.label, unit: t.unit, cmp: t.cmp,
      default: t.default, current: t.current, overridden: t.overridden === true,
      updatedAt: t.updatedAt ?? null, updatedBy: t.updatedBy ?? '', reason: t.reason ?? '',
      updatedIn: titles.get(String(t.updatedBy ?? '')) ?? '',
    })),
  };
}

export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  ctx.effect(() => anyCtx.opendbTasks.register(RULES_TASK_TYPE), 'task-rules.type');

  ctx.effect(() => anyCtx.connection.rpc.handle('/opendb-rules', async (endpoint: string, payload: any): Promise<any> => {
    try {
      if (endpoint !== 'stats') return { ok: false, error: { code: 'not_found', message: `unknown endpoint ${endpoint}`, details: {} } };
      const days = Math.max(1, Math.min(Number(payload?.days ?? 30), 365));
      return { ok: true, value: await catalogStats(anyCtx, days) };
    } catch (cause) {
      return { ok: false, error: { code: 'internal', message: String((cause as Error).message ?? cause), details: {} } };
    }
  }, { authority: 'trusted-host' }), 'task-rules.rpc');
}
