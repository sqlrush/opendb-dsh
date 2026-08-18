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
}

export interface TaskType<C = any> {
  key: string;
  title: string;
  /** 冻结时预留 'service'（P2 监控大盘：不走 LLM）。 */
  runMode: 'session';
  /** required: 无报告 = run failed；optional: 交了就存；none: task_report 拒收。 */
  report: ReportMode;
  /** schemastery schema —— UI 表单与校验同源。 */
  configSchema: (value: unknown) => C;
  /** task_report.data 的校验 schema；校验失败工具报错让模型修正重交。 */
  reportSchema: (value: unknown) => unknown;
  defaultCron?: string;
  buildPrompt(task: TaskRecord<C>, run: TaskRunRecord, ctx: TaskBuildContext): Promise<string>;
}
