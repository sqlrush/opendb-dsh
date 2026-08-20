import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolvePlatformAgent, renderTable, clampText } from '@opendb-dsh/tool-db';

export const name = 'tool-task-admin';
export const inject = ['opendbTasks', 'opendbRegistry', 'tools'];

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { content: { type: 'string', required: true } },
  },
  render: (_args: unknown, value: any) => [{ type: 'text', text: value.content }],
} as const;

interface Deps { tasks: any; registry: any }

async function requireAgent(deps: Deps, exec: any): Promise<{ id: string; name: string }> {
  const agent = await resolvePlatformAgent(deps.registry, exec?.agent);
  if (agent === undefined) throw new Error('无法确定当前会话所属的智能体');
  return agent;
}

function taskLine(t: any): Record<string, unknown> {
  return {
    name: t.name, type: t.type, cron: t.cron ?? '手动', enabled: t.enabled ? '启用' : '停用',
    approval: t.requiresApproval ? '需签收' : '-',
  };
}

function defineTaskCreateTool(deps: Deps) {
  return defineTool({
    name: 'task_create',
    description: '为当前智能体创建一个持续性任务（opendb-harness 交互纲领：用户在会话里描述任务即建立）。已注册类型可用 task_list 查看；cron 按北京时间。创建前应向用户复述任务要点确认。',
    parameters: {
      type: { type: 'string', required: true, description: '任务类型 key（如 inspection=定期巡检、sql-audit=SQL审核、prompt=定时对话）。' },
      name: { type: 'string', required: true, description: '任务名称（简短、唯一）。' },
      cron: { type: 'string', description: '5 字段 cron（北京时间），如 "0 8 * * *"=每天8点；省略=仅手动触发。' },
      config: { type: 'object', additionalProperties: true, description: '任务类型的配置对象（结构随类型；如 sql-audit 的 {topN, node}）。' },
      requires_approval: { type: 'boolean', description: '报告是否需要 DBA 签收（默认 true）。' },
    },
    output: TEXT_OUTPUT,
    async execute(args: any, exec: any) {
      const agent = await requireAgent(deps, exec);
      const task = await deps.tasks.createTask({
        agentId: agent.id,
        type: String(args.type ?? ''),
        name: String(args.name ?? ''),
        cron: typeof args.cron === 'string' && args.cron !== '' ? args.cron : undefined,
        config: args.config ?? {},
        requiresApproval: args.requires_approval !== false,
      });
      return { content: `任务已创建：「${task.name}」（${task.type}，${task.cron ?? '手动触发'}${task.requiresApproval ? '，报告需签收' : ''}）。侧栏任务列表可见；结果将在任务大盘展示。` };
    },
  } as any);
}

function defineTaskUpdateTool(deps: Deps) {
  return defineTool({
    name: 'task_update',
    description: '调整当前智能体某个任务的策略（交互纲领：用户在会话里说变更，由你调整——任务大盘上没有编辑按钮）。可改 cron/启停/配置/签收要求/名称。',
    parameters: {
      task: { type: 'string', required: true, description: '要调整的任务名称（或 id）。' },
      cron: { type: 'string', description: '新 cron（北京时间）；传空字符串 "" 表示改为仅手动。' },
      enabled: { type: 'boolean', description: '启用/停用。' },
      config: { type: 'object', additionalProperties: true, description: '新配置对象（整体替换）。' },
      requires_approval: { type: 'boolean', description: '报告是否需签收。' },
      new_name: { type: 'string', description: '重命名。' },
    },
    output: TEXT_OUTPUT,
    async execute(args: any, exec: any) {
      const agent = await requireAgent(deps, exec);
      const all = await deps.tasks.listTasks();
      const ref = String(args.task ?? '');
      const target = all.find((t: any) => t.agentId === agent.id && (t.name === ref || t.id === ref));
      if (target === undefined) throw new Error(`智能体「${agent.name}」没有名为「${ref}」的任务（用 task_list 查看现有任务）`);
      const patch: any = {};
      if (typeof args.cron === 'string') patch.cron = args.cron === '' ? null : args.cron;
      if (typeof args.enabled === 'boolean') patch.enabled = args.enabled;
      if (args.config !== undefined) patch.config = args.config;
      if (typeof args.requires_approval === 'boolean') patch.requiresApproval = args.requires_approval;
      if (typeof args.new_name === 'string' && args.new_name !== '') patch.name = args.new_name;
      const updated = await deps.tasks.updateTask(target.id, patch);
      return { content: `任务「${updated.name}」已调整：${updated.cron ?? '手动触发'} · ${updated.enabled ? '启用' : '停用'}${updated.requiresApproval ? ' · 报告需签收' : ''}` };
    },
  } as any);
}

function defineTaskListTool(deps: Deps) {
  return defineTool({
    name: 'task_list',
    description: '列出当前智能体的全部任务与已注册的任务类型（回答"我有哪些任务"或创建前查可用类型）。',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute(_args: unknown, exec: any) {
      const agent = await requireAgent(deps, exec);
      const all = (await deps.tasks.listTasks()).filter((t: any) => t.agentId === agent.id);
      const types = deps.tasks.listTypes().map((t: any) => `${t.key}（${t.title}${t.defaultCron ? '，建议 ' + t.defaultCron : ''}）`).join('、');
      const table = all.length > 0 ? renderTable(['name', 'type', 'cron', 'enabled', 'approval'], all.map(taskLine)) : '（还没有任务）';
      return { content: clampText(`智能体「${agent.name}」的任务：\n${table}\n\n可用任务类型：${types}`, 20000) };
    },
  } as any);
}

/** 会话即任务管理（交互纲领 §15 的落地）：function plugin 顶层 inject（W4 教训姿势）。 */
/**
 * W5.5 批次4 补齐：显式「提案→人确认→启用」环（纲领 §15：任务从会话衍生，
 * 人类监督在启用点）。草案=enabled:false 的真实任务：面板可见（标停用）、可被 task_update
 * 启用、被拒则 task_update 删除或留档。工具描述引导模型走 ask_user 确认流。
 */
function defineTaskProposeTool(deps: Deps) {
  return defineTool({
    name: 'task_propose',
    description: '提交一个任务草案（enabled=false，不会运行）。用于「先提案、经用户明确同意再启用」的流程：调用本工具落草案 → 用 ask_user 向用户展示要点并请求确认 → 用户同意后用 task_update 将该任务 enabled=true；用户否决则告知已留存草案或按其要求处理。当用户已明确下达建任务指令时直接用 task_create，不必走提案。',
    parameters: {
      type: { type: 'string', required: true, description: '任务类型 key。' },
      name: { type: 'string', required: true, description: '任务名称。' },
      cron: { type: 'string', description: '5 字段 cron（北京时间）；省略=仅手动。' },
      config: { type: 'object', additionalProperties: true, description: '任务类型配置对象。' },
      rationale: { type: 'string', description: '提案理由（一句话，向用户展示时使用）。' },
    },
    output: TEXT_OUTPUT,
    async execute(args: any, exec: any) {
      const agent = await requireAgent(deps, exec);
      const task = await deps.tasks.createTask({
        agentId: agent.id,
        type: String(args.type ?? ''),
        name: String(args.name ?? ''),
        cron: typeof args.cron === 'string' && args.cron !== '' ? args.cron : undefined,
        config: args.config ?? {},
        requiresApproval: true,
        enabled: false,
      });
      return { content: `草案已落（未启用）：「${task.name}」（${task.type}，${task.cron ?? '手动'}）。请向用户展示方案${typeof args.rationale === 'string' && args.rationale !== '' ? `与理由（${args.rationale}）` : ''}并用 ask_user 请求确认；同意后用 task_update 启用。` };
    },
  } as any);
}

export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  const deps: Deps = { tasks: anyCtx.opendbTasks, registry: anyCtx.opendbRegistry };
  ctx.effect(() => anyCtx.tools.register(defineTaskCreateTool(deps)), 'tool-task-admin.create');
  ctx.effect(() => anyCtx.tools.register(defineTaskUpdateTool(deps)), 'tool-task-admin.update');
  ctx.effect(() => anyCtx.tools.register(defineTaskListTool(deps)), 'tool-task-admin.list');
  ctx.effect(() => anyCtx.tools.register(defineTaskProposeTool(deps)), 'tool-task-admin.propose');
}
