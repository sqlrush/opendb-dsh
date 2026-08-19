/**
 * 任务插件契约（设计 §8.5，G1 冻结 2026-08-19）。
 * 任务插件只定义三件事：配什么（configSchema）、说什么（buildPrompt）、交什么（reportSchema）。
 * 本文件的接口是冻结面——P2 的新任务类型（monitor-dashboard/incident）只能加字段不能改语义。
 */

export type Severity = 'ok' | 'warn' | 'critical';
export type ReportMode = 'required' | 'optional' | 'none';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout';
export type TriggerKind = 'cron' | 'manual' | 'event';

export interface TaskRecord<C = unknown> {
  id: string; tenantId: string; agentId: string; type: string; name: string;
  config: C; cron?: string; enabled: boolean; requiresApproval: boolean;
  timeoutMs: number; lastFiredAt?: Date;
}

export interface TaskRunRecord {
  id: string; taskId: string; triggerKind: TriggerKind; status: RunStatus;
  sessionId?: string; error?: string; firedAt: Date; finishedAt?: Date;
}

export interface TaskReportRecord {
  id: string; runId: string; taskId: string; severity: Severity; summary: string;
  data: unknown; createdAt: Date;
}

/** 引擎注入 buildPrompt 的只读上下文；metrics/dictionary 服务在场时可用（可选能力，additive）。 */
export interface TaskBuildContext {
  nodesOf(agentId: string): Promise<{ id: string; name: string; engine: string; host: string; port: number; dbname: string; status: string }[]>;
  metricsLatest?(nodeId: string): Promise<{ metric: string; value: number; time: Date }[]>;
  dictChanges?(nodeId: string, sinceHours: number): Promise<unknown[]>;
  /** 舰队聚合（P2 W2 additive；metrics-timescale.fleetOverview 在场时可用）。 */
  fleetOverview?(nodeIds: string[], topMetrics: string[], topN?: number): Promise<{
    covered: number; coveredIds: string[];
    agg: { metric: string; n: number; avg: number; max: number; min: number }[];
    top: { nodeId: string; metric: string; value: number }[];
  }>;
}

export interface TaskType<C = any> {
  key: string;
  title: string;
  /**
   * 'session'：触发→开会话→模型执行→task_report。
   * 'service'（P2 W2 落地，G1 冻结时预留）：不走 LLM——任务 enabled 期间由引擎在 Host 内
   * 常驻运行 startService 实例；创建/启用→start，停用/删除/配置变更→stop（变更则重启），
   * Host 重启后 reconcile 自动拉起（常驻跨重启存活）。
   */
  runMode: 'session' | 'service';
  /** required: 无报告 = run failed；optional: 交了就存；none: task_report 拒收。 */
  report: ReportMode;
  /** schemastery schema —— UI 表单与校验同源。 */
  configSchema: (value?: any) => C;
  /** task_report.data 的校验 schema；校验失败工具报错让模型修正重交。 */
  reportSchema: (value?: any) => unknown;
  defaultCron?: string;
  buildPrompt(task: TaskRecord<C>, run: TaskRunRecord, ctx: TaskBuildContext): Promise<string>;
  /** service 型必须提供：启动常驻实例，返回 stop 清理函数（幂等）。 */
  startService?(task: TaskRecord<C>, ctx: TaskBuildContext): Promise<() => void | Promise<void>>;
}
