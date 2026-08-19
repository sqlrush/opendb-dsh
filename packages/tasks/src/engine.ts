import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { isDue } from './cron.ts';
import type { TaskType, TaskRecord, TaskRunRecord, TaskBuildContext, ReportMode } from './types.ts';

const REMINDER_MARK = '等待补交报告（已催交）';
const ENGINE_LEADER_LOCK = 7_204_211_031;   // P3 多 Host 副本引擎 leader 锁（advisory key 段 7204211xxx）

export interface EngineDeps {
  pool: pg.Pool;
  registry: any;
  types: Map<string, TaskType>;
  buildCtx: TaskBuildContext;
  approvals?: () => any | undefined;    // lazy: Host 有 opendbApprovals，Runtime 无
  baseUrl: string;
  tenant: string;
  tzOffsetMinutes: number;
}

export function taskRow(r: any): TaskRecord {
  return {
    id: r.id, tenantId: r.tenant_id, agentId: r.agent_id, type: r.type, name: r.name,
    config: r.config, cron: r.cron ?? undefined, enabled: r.enabled,
    requiresApproval: r.requires_approval, timeoutMs: r.timeout_ms,
    lastFiredAt: r.last_fired_at ?? undefined,
  };
}
export function runRow(r: any): TaskRunRecord {
  return {
    id: r.id, taskId: r.task_id, triggerKind: r.trigger_kind, status: r.status,
    sessionId: r.session_id ?? undefined, error: r.error ?? undefined,
    firedAt: r.fired_at, finishedAt: r.finished_at ?? undefined,
  };
}

function reportRequirement(mode: ReportMode): string {
  if (mode === 'required') return '\n\n结束要求：完成后【必须】调用 task_report 工具提交结构化结论（severity=ok|warn|critical、summary 一句话、data 按上文要求的结构）。不提交报告本次任务将被记为失败。';
  if (mode === 'optional') return '\n\n如有结构化结论，可调用 task_report 工具提交（可选）。';
  return '';
}

/**
 * 任务引擎（仅 Host 启用）：CAS 触发（每 cron 槽至多一次）、经 Host 自身 /api 开会话
 * （与手发无差别）、超时/无报告终态判定、requires_approval 报告的签收单创建（单写者）。
 */
export class TaskEngine {
  private readonly d: EngineDeps;
  private busy = false;

  constructor(deps: EngineDeps) {
    this.d = deps;
  }

  /**
   * 一轮：service 实例对账 + 手动队列拾取 + cron 触发 + 终态清扫 + 审批单补建。
   * P3 多 Host 副本：整个 tick 套 **事务级 advisory try-lock 做 leader 竞选**——拿到锁的副本
   * 执行本轮，其余副本静默跳过（30s 后再竞）。事务级锁天然防 W4 僵尸连接持锁事故
   * （连接死/事务回滚即放锁）；leader 挂掉最多一个 tick 周期后其它副本接管。
   * service 实例也随 leader 走：失去 leader 的副本在下一轮把本地 service 全部停掉。
   */
  async tick(now = new Date()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const c = await this.d.pool.connect();
    try {
      await c.query('BEGIN');
      const got = await c.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [ENGINE_LEADER_LOCK]);
      if (got.rows[0].ok !== true) {
        await c.query('COMMIT');
        if (this.services.size > 0) await this.stopAllServices();   // 不是 leader：不能留常驻实例
        return;
      }
      await this.reconcileServices();
      await this.fireQueuedManuals();
      await this.fireDue(now);
      await this.sweepTimeouts(now);
      await this.settleFinishedTurns();
      await this.createPendingAcks();
      await c.query('COMMIT');   // 放 leader 锁（本轮工作全部完成后）
    } catch (cause) {
      await c.query('ROLLBACK').catch(() => {});
      process.stderr.write(`[tasks] tick failed: ${String((cause as Error).message ?? cause)}\n`);
    } finally {
      c.release();
      this.busy = false;
    }
  }

  // ---------------- service 型任务（P2 W2：runMode:'service'，不走 LLM 的常驻实例）
  private readonly services = new Map<string, { stop: () => void | Promise<void>; fingerprint: string }>();

  /**
   * 对账：enabled 的 service 型任务 ↔ 运行中实例。缺则 start、多则 stop、
   * 配置/名称变更则重启（指纹比对）。Host 重启后首轮 tick 自动全量拉起——常驻跨重启存活。
   */
  private async reconcileServices(): Promise<void> {
    const r = await this.d.pool.query(`SELECT * FROM dsh_tasks WHERE tenant_id = $1 AND enabled`, [this.d.tenant]);
    const want = new Map<string, TaskRecord>();
    for (const raw of r.rows) {
      const task = taskRow(raw);
      if (this.d.types.get(task.type)?.runMode === 'service') want.set(task.id, task);
    }
    for (const [id, inst] of [...this.services]) {
      const task = want.get(id);
      if (task !== undefined && serviceFingerprint(task) === inst.fingerprint) continue;
      this.services.delete(id);
      try { await inst.stop(); } catch (cause) {
        process.stderr.write(`[tasks] service stop ${id} failed: ${String((cause as Error).message ?? cause)}\n`);
      }
      process.stderr.write(`[tasks] service stopped: ${id}${task !== undefined ? ' (config changed, will restart)' : ''}\n`);
    }
    for (const [id, task] of want) {
      if (this.services.has(id)) continue;
      const type = this.d.types.get(task.type);
      if (type?.startService === undefined) continue;
      try {
        // config 过 schema 规范化再交给实例（SQL 直插/历史行缺省字段会拿到默认值——
        // 实测教训：config={} 时 intervalSeconds=undefined → setInterval(fn, NaN)=毫秒级疯狂循环）
        const normalized: TaskRecord = { ...task, config: type.configSchema(task.config ?? {}) };
        const stop = await type.startService(normalized, this.d.buildCtx);
        this.services.set(id, { stop, fingerprint: serviceFingerprint(task) });
        process.stderr.write(`[tasks] service started: ${task.name} (${id})\n`);
      } catch (cause) {
        process.stderr.write(`[tasks] service start ${task.name} failed: ${String((cause as Error).message ?? cause)}\n`);
      }
    }
  }

  /** 引擎停机（Host 关闭/热重载）：停掉全部 service 实例。 */
  async stopAllServices(): Promise<void> {
    for (const [id, inst] of [...this.services]) {
      this.services.delete(id);
      try { await inst.stop(); } catch { /* teardown 尽力而为 */ }
    }
  }

  /**
   * runNow 只入队立即返回（真正 fire 在下一次 tick）：fire 会经 Host 自身 /api 开会话，
   * 而 runNow 本身就跑在 /api 的 RPC 处理上下文里 —— 同步自调用会与请求处理串行化互等
   * 而死锁（实测挂满 curl 超时）。异步拾取彻底绕开。
   */
  async runNow(taskId: string, kind: 'manual' | 'event' = 'manual'): Promise<TaskRunRecord> {
    const r = await this.d.pool.query('SELECT * FROM dsh_tasks WHERE id = $1', [taskId]);
    if (r.rows[0] === undefined) throw new Error(`任务 ${taskId} 不存在`);
    return this.createRun(taskId, kind);
  }

  /** 拾取 runNow 入队、尚未开会话的 manual run（MVP Host 单副本；P3 多引擎需 claim）。 */
  private async fireQueuedManuals(): Promise<void> {
    const r = await this.d.pool.query(
      `SELECT r.id AS run_id, t.* FROM dsh_task_runs r JOIN dsh_tasks t ON t.id = r.task_id
       WHERE r.status = 'queued' AND r.session_id IS NULL AND r.trigger_kind IN ('manual', 'event')
       ORDER BY r.fired_at`,
    );
    for (const raw of r.rows) {
      const task = taskRow(raw);
      const runRes = await this.d.pool.query('SELECT * FROM dsh_task_runs WHERE id = $1', [raw.run_id]);
      try {
        await this.fire(task, runRow(runRes.rows[0]));
      } catch (cause) {
        process.stderr.write(`[tasks] manual fire "${task.name}" failed: ${String((cause as Error).message ?? cause)}\n`);
      }
    }
  }

  private async fireDue(now: Date): Promise<void> {
    const r = await this.d.pool.query(
      `SELECT * FROM dsh_tasks WHERE tenant_id = $1 AND enabled AND cron IS NOT NULL`, [this.d.tenant]);
    for (const raw of r.rows) {
      const task = taskRow(raw);
      try {
        if (!isDue(task.cron!, task.lastFiredAt, now, this.d.tzOffsetMinutes)) continue;
        const claimed = await this.d.pool.query(
          `UPDATE dsh_tasks SET last_fired_at = $3, updated_at = now()
           WHERE id = $1 AND coalesce(last_fired_at, 'epoch'::timestamptz) = coalesce($2, 'epoch'::timestamptz)
           RETURNING id`,
          [task.id, task.lastFiredAt ?? null, now],
        );
        if (claimed.rowCount === 0) continue;   // 另一个引擎实例赢了 CAS
        const run = await this.createRun(task.id, 'cron');
        await this.fire(task, run);
      } catch (cause) {
        process.stderr.write(`[tasks] fire "${task.name}" failed: ${String((cause as Error).message ?? cause)}\n`);
      }
    }
  }

  private async createRun(taskId: string, triggerKind: 'cron' | 'manual' | 'event'): Promise<TaskRunRecord> {
    const r = await this.d.pool.query(
      `INSERT INTO dsh_task_runs (id, task_id, trigger_kind) VALUES ($1,$2,$3) RETURNING *`,
      [`run-${randomUUID().slice(0, 8)}`, taskId, triggerKind],
    );
    return runRow(r.rows[0]);
  }

  /** 开会话 + 注入任务框架提示词；失败把 run 置 failed（不留悬挂态）。 */
  private async fire(task: TaskRecord, run: TaskRunRecord): Promise<void> {
    try {
      const type = this.d.types.get(task.type);
      if (type === undefined) throw new Error(`任务类型 ${task.type} 未注册`);
      if (type.runMode !== 'session') throw new Error(`service 型任务不经会话运行（enabled 即常驻，无需触发）`);
      const agent = await this.d.registry.getAgent(task.agentId);
      if (agent === undefined) throw new Error(`agent ${task.agentId} 不存在`);
      const workspaces = await this.api('workspace.list', {});
      const ws = (workspaces.items ?? []).find((w: any) => typeof w.path === 'string' && new RegExp(`/agents/${agent.name}/?$`).test(w.path));
      if (ws === undefined) throw new Error(`agent「${agent.name}」没有对应工作区（先在控制台打开过一次即可创建）`);
      const body = await type.buildPrompt(task, run, this.d.buildCtx);
      const text = `【任务运行】${task.name}（类型：${type.title}）\n\n${body}${reportRequirement(type.report)}`;
      const created = await this.api('session.create', { workspaceId: ws.workspaceId });
      if (typeof created.sessionId !== 'string') throw new Error('session.create 未返回 sessionId');
      await this.d.pool.query(
        `UPDATE dsh_task_runs SET session_id = $2, status = 'running', fired_at = now() WHERE id = $1 AND status = 'queued'`,   // fired_at=实际开跑：排队等待不计入超时
        [run.id, created.sessionId],
      );
      await this.api('session.prompt', { sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text }] });
      process.stderr.write(`[tasks] fired "${task.name}" → ${created.sessionId}\n`);
    } catch (cause) {
      await this.d.pool.query(
        `UPDATE dsh_task_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status IN ('queued','running')`,
        [run.id, String((cause as Error).message ?? cause)],
      ).catch(() => {});
      throw cause;
    }
  }

  private async sweepTimeouts(now: Date): Promise<void> {
    await this.d.pool.query(
      `UPDATE dsh_task_runs r SET status = 'timeout', finished_at = now()
       FROM dsh_tasks t
       WHERE t.id = r.task_id AND r.status IN ('queued','running')
         AND r.fired_at < $1::timestamptz - make_interval(secs => t.timeout_ms / 1000.0)`,
      [now],
    );
  }

  /**
   * 回合全部闭合但没有报告的 running run：
   * required → 先补救一次（追加催交 prompt，error 字段做提醒标记），仍不交才 failed；
   * optional/none → succeeded。
   * turn 闭合判定必须是 start/end 计数相抵（提醒会开新 turn，单看 EXISTS turn/end 会在
   * 补救回合进行中误判）。
   */
  private async settleFinishedTurns(): Promise<void> {
    const r = await this.d.pool.query(
      `SELECT r.id, r.session_id, r.error, t.type FROM dsh_task_runs r
       JOIN dsh_tasks t ON t.id = r.task_id
       WHERE r.status = 'running' AND r.session_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM dsh_task_reports p WHERE p.run_id = r.id)
         AND (SELECT count(*) FILTER (WHERE e.type = 'turn/start') > 0
                AND count(*) FILTER (WHERE e.type = 'turn/end') >= count(*) FILTER (WHERE e.type = 'turn/start')
              FROM dsh_session_events e
              WHERE e.session_id = r.session_id AND e.type IN ('turn/start', 'turn/end'))`,
    );
    for (const raw of r.rows) {
      const mode: ReportMode = this.d.types.get(raw.type)?.report ?? 'required';
      if (mode !== 'required') {
        await this.d.pool.query(
          `UPDATE dsh_task_runs SET status = 'succeeded', finished_at = now() WHERE id = $1 AND status = 'running'`,
          [raw.id]);
        continue;
      }
      if (raw.error !== REMINDER_MARK) {
        // 第一次：催交（模型偶发跑完不调 task_report——一次提醒能救回大多数）
        try {
          await this.api('session.prompt', {
            sessionId: raw.session_id, mode: 'queue',
            content: [{ type: 'text', text: '任务尚未提交报告。请立即调用 task_report 工具提交结构化结论（severity/summary/data 按任务要求），不要做其它事情。' }],
          });
          await this.d.pool.query(`UPDATE dsh_task_runs SET error = $2 WHERE id = $1 AND status = 'running'`, [raw.id, REMINDER_MARK]);
          process.stderr.write(`[tasks] report reminder sent for run ${raw.id}\n`);
        } catch (cause) {
          process.stderr.write(`[tasks] report reminder failed for run ${raw.id}: ${String((cause as Error).message ?? cause)}\n`);
        }
      } else {
        await this.d.pool.query(
          `UPDATE dsh_task_runs SET status = 'failed', error = '未提交报告（已催交一次）', finished_at = now() WHERE id = $1 AND status = 'running'`,
          [raw.id]);
      }
    }
  }

  /** requires_approval 任务的成功报告 → report-ack 审批单（缺哪补哪，单写者幂等）。 */
  private async createPendingAcks(): Promise<void> {
    const approvals = this.d.approvals?.();
    if (approvals === undefined) return;
    const r = await this.d.pool.query(
      `SELECT r.id AS run_id, t.name, t.id AS task_id, p.severity, p.summary
       FROM dsh_task_runs r
       JOIN dsh_tasks t ON t.id = r.task_id AND t.requires_approval
       JOIN dsh_task_reports p ON p.run_id = r.id
       WHERE r.status = 'succeeded'
         AND NOT EXISTS (SELECT 1 FROM dsh_approvals a WHERE a.ref_run_id = r.id)`,
    );
    for (const raw of r.rows) {
      await approvals.request({
        kind: 'report-ack',
        subject: `报告签收：${raw.name}（${raw.severity}）`,
        payload: { taskId: raw.task_id, runId: raw.run_id, severity: raw.severity, summary: raw.summary },
        refRunId: raw.run_id,
      }).catch((cause: unknown) => process.stderr.write(`[tasks] create ack failed: ${String(cause)}\n`));
    }
  }

  private async api(method: string, payload: unknown): Promise<any> {
    const res = await fetch(`${this.d.baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: this.d.baseUrl },
      body: JSON.stringify({ type: 'client-request', rpcId: `task-${randomUUID().slice(0, 8)}`, method, payload }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`${method} → HTTP ${res.status}`);
    const body = await res.json() as any;
    const result = body.result ?? body;
    if (result.ok === false) throw new Error(`${method} → ${result.error?.message ?? 'request failed'}`);
    return result.value ?? result;
  }
}

/** service 实例指纹：名称/配置/时长参数任一变化 → 重启实例。 */
function serviceFingerprint(task: TaskRecord): string {
  return JSON.stringify([task.name, task.config, task.timeoutMs]);
}
