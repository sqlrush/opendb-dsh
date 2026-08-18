import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';
import { TaskEngine, taskRow, runRow } from './engine.ts';
import { defineTaskReportTool } from './tool.ts';
import { PROMPT_TASK_TYPE } from './prompt-type.ts';
import { parseCron } from './cron.ts';
import type { TaskType, TaskRecord, TaskRunRecord, TaskReportRecord, TaskBuildContext } from './types.ts';

export * from './types.ts';
export { parseCron, nextFire, isDue } from './cron.ts';
export { PROMPT_TASK_TYPE } from './prompt-type.ts';
export { defineTaskReportTool } from './tool.ts';

declare module '@deepseek-ai/cordis' {
  interface Context { opendbTasks: TasksService }
}

function reportRow(r: any): TaskReportRecord {
  return { id: r.id, runId: r.run_id, taskId: r.task_id, severity: r.severity, summary: r.summary, data: r.data, createdAt: r.created_at };
}

/**
 * ctx.opendbTasks — 任务插件契约的平台实现（设计 §8.5，G1 冻结）：类型注册表 + 任务
 * CRUD + 触发引擎（engine:true，仅 Host）+ task_report 工具（有 tools 注册表处，即 Runtime）。
 */
export default class TasksService extends Service {
  static inject = ['opendbRegistry'];
  static Config = z.object({
    connectionString: z.string().required(),
    engine: z.boolean().default(false),
    tickMs: z.number().step(1).min(5000).default(30_000),
    baseUrl: z.string().default(''),
    tzOffsetMinutes: z.number().default(480),   // cron 表达式按北京时间书写
    defaultTenant: z.string().default('default'),
  });

  readonly pool: pg.Pool;
  private readonly ready: Promise<void>;
  private readonly registry: any;
  private readonly tenant: string;
  private readonly types = new Map<string, TaskType>();
  private readonly engine: TaskEngine | undefined;

  constructor(ctx: Context, config: { connectionString: string; engine?: boolean; tickMs?: number; baseUrl?: string; tzOffsetMinutes?: number; defaultTenant?: string }) {
    super(ctx, 'opendbTasks');
    const anyCtx = ctx as any;
    this.pool = createPool(config.connectionString);
    this.registry = anyCtx.opendbRegistry;
    this.tenant = config.defaultTenant ?? 'default';
    this.ready = runMigrations(this.pool);
    this.ready.catch(() => { /* surfaced on first call */ });
    this.types.set(PROMPT_TASK_TYPE.key, PROMPT_TASK_TYPE);

    if (config.engine === true) {
      const buildCtx: TaskBuildContext = {
        nodesOf: (agentId: string) => this.registry.listNodes({ agentId }),
        metricsLatest: anyCtx.opendbMetrics !== undefined ? (nodeId: string) => anyCtx.opendbMetrics.latest(nodeId) : undefined,
        dictChanges: anyCtx.opendbDictionary !== undefined ? (nodeId: string, sinceHours: number) => anyCtx.opendbDictionary.changes({ nodeId, sinceHours }) : undefined,
      };
      this.engine = new TaskEngine({
        pool: this.pool,
        registry: this.registry,
        types: this.types,
        buildCtx,
        approvals: () => anyCtx.opendbApprovals,
        baseUrl: (config.baseUrl ?? '') !== '' ? config.baseUrl! : `http://127.0.0.1:${process.env.OPENDB_HOST_PORT ?? '3080'}`,
        tenant: this.tenant,
        tzOffsetMinutes: config.tzOffsetMinutes ?? 480,
      });
      const tickMs = config.tickMs ?? 30_000;
      ctx.effect(() => {
        const timer = setInterval(() => { void this.ready.then(() => this.engine!.tick()).catch(() => {}); }, tickMs);
        return () => clearInterval(timer);
      }, 'opendbTasks.engine');
    }

    // task_report 工具：注册到任何有 tools 注册表的环境（Runtime）；Host 无 tools 则自然跳过
    anyCtx.inject(['tools'], (c: any) => {
      c.effect(() => c.tools.register(defineTaskReportTool({ pool: this.pool, types: this.types })), 'tasks.task_report');
    });

    ctx.effect(() => async () => { await this.ready.catch(() => {}); await this.pool.end(); }, 'opendbTasks.pool');
  }

  // ---------------- 类型注册（冻结面）
  register(type: TaskType): () => void {
    const previous = this.types.get(type.key);
    this.types.set(type.key, type);
    return () => {
      if (previous !== undefined) this.types.set(type.key, previous);
      else this.types.delete(type.key);
    };
  }
  getType(key: string): TaskType | undefined { return this.types.get(key); }
  listTypes(): { key: string; title: string; report: string; defaultCron?: string }[] {
    return [...this.types.values()].map((t) => ({ key: t.key, title: t.title, report: t.report, defaultCron: t.defaultCron }));
  }

  // ---------------- 任务 CRUD
  async createTask(input: { agentId: string; type: string; name: string; config?: unknown; cron?: string; requiresApproval?: boolean; timeoutMs?: number; enabled?: boolean }): Promise<TaskRecord> {
    await this.ready;
    const type = this.types.get(input.type);
    if (type === undefined) throw new Error(`未知任务类型 ${input.type}（已注册：${[...this.types.keys()].join(', ')}）`);
    const config = type.configSchema(input.config ?? {});
    if (input.cron !== undefined && input.cron !== '') parseCron(input.cron);   // fail fast on bad cron
    const r = await this.pool.query(
      `INSERT INTO dsh_tasks (id, tenant_id, agent_id, type, name, config, cron, requires_approval, timeout_ms, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [`task-${randomUUID().slice(0, 8)}`, this.tenant, input.agentId, input.type, input.name,
       JSON.stringify(config ?? {}), input.cron !== '' ? input.cron ?? null : null,
       input.requiresApproval ?? false, input.timeoutMs ?? 600_000, input.enabled ?? true],
    );
    return taskRow(r.rows[0]);
  }
  async listTasks(): Promise<TaskRecord[]> {
    await this.ready;
    const r = await this.pool.query('SELECT * FROM dsh_tasks WHERE tenant_id = $1 ORDER BY created_at', [this.tenant]);
    return r.rows.map(taskRow);
  }
  async getTask(id: string): Promise<TaskRecord | undefined> {
    await this.ready;
    const r = await this.pool.query('SELECT * FROM dsh_tasks WHERE id = $1', [id]);
    return r.rows[0] ? taskRow(r.rows[0]) : undefined;
  }
  async updateTask(id: string, patch: { name?: string; cron?: string | null; requiresApproval?: boolean; timeoutMs?: number; enabled?: boolean; config?: unknown }): Promise<TaskRecord | undefined> {
    await this.ready;
    const current = await this.getTask(id);
    if (current === undefined) return undefined;
    if (typeof patch.cron === 'string' && patch.cron !== '') parseCron(patch.cron);
    let config = current.config;
    if (patch.config !== undefined) {
      const type = this.types.get(current.type);
      if (type === undefined) throw new Error(`任务类型 ${current.type} 未注册`);
      config = type.configSchema(patch.config);
    }
    const r = await this.pool.query(
      `UPDATE dsh_tasks SET name = $2, cron = $3, requires_approval = $4, timeout_ms = $5, enabled = $6, config = $7, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, patch.name ?? current.name,
       patch.cron === null ? null : (patch.cron === '' ? null : patch.cron ?? current.cron ?? null),
       patch.requiresApproval ?? current.requiresApproval, patch.timeoutMs ?? current.timeoutMs,
       patch.enabled ?? current.enabled, JSON.stringify(config ?? {})],
    );
    return taskRow(r.rows[0]);
  }
  async removeTask(id: string): Promise<void> {
    await this.ready;
    await this.pool.query('DELETE FROM dsh_tasks WHERE id = $1', [id]);
  }

  // ---------------- 运行与报告
  async runNow(taskId: string): Promise<TaskRunRecord> {
    await this.ready;
    if (this.engine === undefined) throw new Error('本实例未启用任务引擎（engine:false）');
    return this.engine.runNow(taskId);
  }
  async listRuns(filter: { taskId?: string; limit?: number } = {}): Promise<TaskRunRecord[]> {
    await this.ready;
    const limit = Math.min(filter.limit ?? 50, 200);
    const r = filter.taskId !== undefined
      ? await this.pool.query('SELECT * FROM dsh_task_runs WHERE task_id = $1 ORDER BY fired_at DESC LIMIT $2', [filter.taskId, limit])
      : await this.pool.query(
          `SELECT r.* FROM dsh_task_runs r JOIN dsh_tasks t ON t.id = r.task_id WHERE t.tenant_id = $1 ORDER BY r.fired_at DESC LIMIT $2`,
          [this.tenant, limit]);
    return r.rows.map(runRow);
  }
  async getReport(runId: string): Promise<TaskReportRecord | undefined> {
    await this.ready;
    const r = await this.pool.query('SELECT * FROM dsh_task_reports WHERE run_id = $1', [runId]);
    return r.rows[0] ? reportRow(r.rows[0]) : undefined;
  }
}
export { TasksService };
