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
      config: { type: 'object', additionalProperties: true, description: '任务类型的配置对象。目标节点各类型统一支持 node（单个）或 nodes（数组）：health={node|nodes,dims,focus}、sqlreview（Top SQL 报表）={node,dimensions,topN,sqls,focus}——dimensions 是榜单维度数组，用户说"按执行次数和耗时分别 Top5"就填 ["calls","elapsed"]、topN=5（可选 elapsed=总耗时/calls=执行次数/avg=平均耗时/cpu/io/blocks=逻辑读/dbtime/spill=下盘/rows=返回行数），**这类需求必须用 sqlreview 类型，不要退化成 prompt 定时对话**；**先判断对话意图**：用户要的是各维度 Top-N（→ dimensions 填维度、sqls 留空）还是跟踪他在对话里讨论/贴出的那几条具体 SQL（→ sqls 填这些 SQL 原文、dimensions 传 []，报表只含这几条）；对象明确就只跟踪对象，不要两者混填、不要把榜单语句复制进 sqls、wdr={node,beginSnap,endSnap,topN}、ddl={node,hours}、rules={plugin}。**用户点名了具体节点就必须填**，不填 = 该智能体绑定的全部节点（可能是几百个）。' },
      run_now: { type: 'boolean', description: '创建后立即运行一次（默认 true）。设为 false 则只等 cron。' },
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
      });
      // 建完立即跑一次（2026-08-22 user 反馈：建任务成功但首次巡检没做）——入队即返回，
      // 引擎下一 tick（NOTIFY 拍醒，约 0.5s）真正开会话执行。
      const runNow = args.run_now !== false;
      let firstRun = '';
      if (runNow) {
        try {
          await deps.tasks.runNow(task.id, 'manual');
          firstRun = '；已排入首次运行（稍后在侧栏任务页看报告）';
        } catch (cause) {
          firstRun = `；首次运行排队失败：${String((cause as Error).message ?? cause)}`;
        }
      }
      return { content: `任务已创建：「${task.name}」（${task.type}，${task.cron ?? '手动触发'}）${firstRun}。侧栏任务列表可见；结果将在任务大盘只读展示。` };
    },
  } as any);
}

function defineTaskUpdateTool(deps: Deps) {
  return defineTool({
    name: 'task_update',
    description: '调整当前智能体某个任务的策略（交互纲领：用户在会话里说变更，由你调整——任务大盘上没有编辑按钮）。可改 cron/启停/配置/名称。',
    parameters: {
      task: { type: 'string', required: true, description: '要调整的任务名称（或 id）。' },
      cron: { type: 'string', description: '新 cron（北京时间）；传空字符串 "" 表示改为仅手动。' },
      enabled: { type: 'boolean', description: '启用/停用。' },
      config: { type: 'object', additionalProperties: true, description: '新配置对象（整体替换）。' },
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
      if (typeof args.new_name === 'string' && args.new_name !== '') patch.name = args.new_name;
      const updated = await deps.tasks.updateTask(target.id, patch);
      return { content: `任务「${updated.name}」已调整：${updated.cron ?? '手动触发'} · ${updated.enabled ? '启用' : '停用'}` };
    },
  } as any);
}

/** 立即运行一次（user 2026-08-22：说"马上跑一次"时模型此前无工具可用） */
function defineTaskRunNowTool(deps: Deps) {
  return defineTool({
    name: 'task_run_now',
    description: '立即运行当前智能体的某个任务一次（不改动它的 cron 周期）。用户说「马上跑一次/现在执行/立即巡检」时用它。入队即返回，引擎随后开会话执行，结果在任务大盘展示。',
    parameters: {
      task: { type: 'string', required: true, description: '任务名称（或 id）。' },
    },
    output: TEXT_OUTPUT,
    async execute(args: any, exec: any) {
      const agent = await requireAgent(deps, exec);
      const all = await deps.tasks.listTasks();
      const ref = String(args.task ?? '');
      const target = all.find((t: any) => t.agentId === agent.id && (t.name === ref || t.id === ref));
      if (target === undefined) throw new Error(`智能体「${agent.name}」没有名为「${ref}」的任务（用 task_list 查看现有任务）`);
      const run = await deps.tasks.runNow(target.id, 'manual');
      return { content: `任务「${target.name}」已排入立即运行（run ${String(run.id)}）——引擎会开一个新会话执行，完成后报告出现在任务大盘。` };
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
      const table = all.length > 0 ? renderTable(['name', 'type', 'cron', 'enabled'], all.map(taskLine)) : '（还没有任务）';
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
  ctx.effect(() => anyCtx.tools.register(defineTaskRunNowTool(deps)), 'tool-task-admin.runNow');
  ctx.effect(() => anyCtx.tools.register(defineTaskProposeTool(deps)), 'tool-task-admin.propose');
}
