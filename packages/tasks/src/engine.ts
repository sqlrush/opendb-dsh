import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { isDue } from './cron.ts';
import type { TaskType, TaskRecord, TaskRunRecord, TaskBuildContext, ReportMode } from './types.ts';

const REMINDER_MARK = '等待补交报告（已催交）';
const MODEL_ERROR_PREFIX = '模型调用失败';
/** 模型侧错误 → 用户能看懂的一句话（余额不足是最常见的一种，2026-08-29 DeepSeek 余额 -0.35 元时所有任务连续失败） */
export function describeModelError(error: { code?: string; status?: number; message?: string }): string {
  const code = String(error.code ?? '');
  const status = Number(error.status ?? 0);
  const msg = String(error.message ?? '').slice(0, 120);
  if (code === 'QUOTA' || status === 402 || /insufficient balance/i.test(msg)) return `${MODEL_ERROR_PREFIX}：模型服务余额不足（${status || 402} ${msg || 'Insufficient Balance'}）——充值后任务自动恢复，或点「立即运行」`;
  if (status === 401 || status === 403 || /api key|unauthorized/i.test(msg)) return `${MODEL_ERROR_PREFIX}：模型服务鉴权失败（${status} ${msg}）——检查 API Key`;
  if (status === 429) return `${MODEL_ERROR_PREFIX}：模型服务限流（429 ${msg}）——稍后自动重试`;
  return `${MODEL_ERROR_PREFIX}：${code || 'ERROR'} ${status || ''} ${msg}`.replace(/\s+/g, ' ').trim();
}
const ENGINE_LEADER_LOCK = 7_204_211_031;   // P3 多 Host 副本引擎 leader 锁（advisory key 段 7204211xxx）

export interface EngineDeps {
  pool: pg.Pool;
  registry: any;
  types: Map<string, TaskType>;
  buildCtx: TaskBuildContext;
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
 * （与手发无差别）、超时/无报告终态判定。（审批签收链路已下线：平台聚焦只读展示。）
 */
export class TaskEngine {
  private readonly d: EngineDeps;
  private busy = false;

  constructor(deps: EngineDeps) {
    this.d = deps;
  }

  /**
   * P3 多 Host 副本 leader 竞选：**session 级 advisory lock 持在专用连接上、跨 tick 持有**——
   * xact 级锁只能互斥不能固定 leader（实测：两副本轮流拿锁各自 start service，快照双份）。
   * 每 tick 先 SELECT 1 保活检测；连接断（pod 死）PG 自动放锁，其它副本下轮接管
   * （半开连接极端场景由 PG tcp_keepalives ~2 分钟清理，W4 防线复用）。
   */
  private leaderClient: pg.PoolClient | undefined;

  private async ensureLeader(): Promise<boolean> {
    if (this.leaderClient !== undefined) {
      try { await this.leaderClient.query('SELECT 1'); return true; }
      catch { try { this.leaderClient.release(true as any); } catch { /* gone */ } this.leaderClient = undefined; }
    }
    const c = await this.d.pool.connect();
    try {
      const r = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [ENGINE_LEADER_LOCK]);
      if (r.rows[0].ok === true) {
        this.leaderClient = c;
        process.stderr.write('[tasks] engine leader acquired\n');
        return true;
      }
      c.release();
      return false;
    } catch (cause) {
      c.release(true as any);
      throw cause;
    }
  }

  /** 停机释放 leader（优雅退出立刻让位；非优雅由 PG 断连放锁）。 */
  async releaseLeader(): Promise<void> {
    if (this.leaderClient === undefined) return;
    try { await this.leaderClient.query('SELECT pg_advisory_unlock($1)', [ENGINE_LEADER_LOCK]); } catch { /* closing */ }
    try { this.leaderClient.release(); } catch { /* closing */ }
    this.leaderClient = undefined;
  }

  /** 一轮：leader 竞选 → service 对账 + 队列拾取 + cron 触发 + 终态清扫 + 审批单补建。 */
  async tick(now = new Date()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!(await this.ensureLeader())) {
        if (this.services.size > 0) await this.stopAllServices();   // 失去/不是 leader：不留常驻实例
        return;
      }
      await this.reconcileServices();
      await this.fireQueuedManuals();
      await this.fireDue(now);
      await this.sweepTimeouts(now);
      await this.settleFinishedTurns();
    } catch (cause) {
      process.stderr.write(`[tasks] tick failed: ${String((cause as Error).message ?? cause)}\n`);
    } finally {
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
      // 归档的任务不再按 cron 触发（2026-08-27：一个归档的 */10 任务在无人可见的情况下跑了 3 小时）
      // last_error / last_finished 只看已结束的运行（running 的手动运行 error 为空，会把"模型服务失败"的守卫瞬间解除——
      // 2026-08-29 实测：点一次「立即运行」，被守卫压着的 cron 槽位同一秒补发，一个任务并排跑两轮）
      `SELECT t.*,
              (SELECT r.error FROM dsh_task_runs r WHERE r.task_id = t.id AND r.finished_at IS NOT NULL ORDER BY r.fired_at DESC LIMIT 1) AS last_error,
              (SELECT r.finished_at FROM dsh_task_runs r WHERE r.task_id = t.id AND r.finished_at IS NOT NULL ORDER BY r.fired_at DESC LIMIT 1) AS last_finished,
              EXISTS (SELECT 1 FROM dsh_task_runs r WHERE r.task_id = t.id AND r.status IN ('queued', 'running')) AS has_active
         FROM dsh_tasks t WHERE t.tenant_id = $1 AND t.enabled AND t.cron IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM opendb_archived_tasks a WHERE a.task_id = t.id)`, [this.d.tenant]);
    for (const raw of r.rows) {
      const task = taskRow(raw);
      try {
        if (!isDue(task.cron!, task.lastFiredAt, now, this.d.tzOffsetMinutes)) continue;
        // 跳过本槽位时也要把 last_fired_at 推到 now：否则错过的槽位一直"到期"，守卫一解除就补发（cron 追赶），
        // 与用户的手动运行撞在同一秒并排跑（2026-08-29 Top1 / 过载监控 / WDR 三次实测）
        const consumeSlot = async (why: string): Promise<void> => {
          await this.d.pool.query(
            `UPDATE dsh_tasks SET last_fired_at = $3, updated_at = now()
             WHERE id = $1 AND coalesce(last_fired_at, 'epoch'::timestamptz) = coalesce($2, 'epoch'::timestamptz)`,
            [task.id, task.lastFiredAt ?? null, now]);
          process.stderr.write(`[tasks] "${task.name}" cron slot skipped: ${why}\n`);
        };
        // 同一任务上一轮还在跑（手动或上一个 cron 槽位）：不叠加开第二轮
        if (raw.has_active === true) { await consumeSlot('a run of this task is still active'); continue; }
        // 上一次因模型服务失败（余额不足/鉴权/限流）而失败的任务：30 分钟内不再按 cron 开新会话（每 5 分钟开一个只会失败的会话没意义），
        // 30 分钟后自动重试一次；user 充值后想立刻恢复就点「立即运行」
        const lastErr = typeof raw.last_error === 'string' ? raw.last_error : '';
        const lastFinished = raw.last_finished ? new Date(raw.last_finished).getTime() : 0;
        if (lastErr.startsWith(MODEL_ERROR_PREFIX) && now.getTime() - lastFinished < 30 * 60_000) {
          await consumeSlot(`model service failing (${lastErr.slice(0, 60)}); retry after 30min`);
          continue;
        }
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
      // session 路径同样过 configSchema 规范化（service 路径已有）——SQL 直插/部分字段 config
      // 缺省时补默认值，否则 buildPrompt 里 config.xxx.length 直接炸（2026-08-21 sqlreview e2e 实证）
      task = { ...task, config: type.configSchema(task.config ?? {}) };
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
      // 2026-08-29：模型调用本身失败（402 余额不足 / 鉴权 / 上游故障）——催交只会再失败一次，直接把真实原因写进 run
      //（之前一律显示"未提交报告（已催交一次）"，user 以为是平台 bug）
      const modelErr = await this.lastTurnError(raw.session_id);
      if (modelErr !== undefined) {
        await this.d.pool.query(
          `UPDATE dsh_task_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status = 'running'`,
          [raw.id, modelErr]);
        process.stderr.write(`[tasks] run ${raw.id} failed on model error: ${modelErr}\n`);
        continue;
      }
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

  /** 会话最后一个 turn/end 若是 error 结束，返回给用户看的一句原因；否则 undefined */
  private async lastTurnError(sessionId: string): Promise<string | undefined> {
    const r = await this.d.pool.query(
      `SELECT data->'reason' AS reason FROM dsh_session_events WHERE session_id = $1 AND type = 'turn/end' ORDER BY seq DESC LIMIT 1`,
      [sessionId]);
    const reason = r.rows[0]?.reason as { kind?: string; error?: { code?: string; status?: number; message?: string } } | undefined;
    if (reason?.kind !== 'error') return undefined;
    return describeModelError(reason.error ?? {});
  }

  // 审批签收链路已整体下线（2026-08-21 user 决策：平台聚焦模型分析+只读展示，不做变更操作类功能；
  // createPendingAcks 及 approvals 依赖随之移除，dsh_approvals 表保留但不再写入——恢复走暂缓池）。

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
