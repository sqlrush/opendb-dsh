-- 2026-08-27 Top SQL 报表（R5）：采集器结果存档，任务面板直读确定性数字（同健康报告 016 的做法，
-- 但按任务类型通用：task_type 区分，后续 wdr/ddl 也可落这张表）。payload 含负载总量 / 各维度榜单 /
-- 去重 Top SQL 明细（指标·占比·榜位·类型·计划·归因违规）/ 一眼结论 / 规则违规；~20-60KB/次。
CREATE TABLE IF NOT EXISTS opendb_task_collects (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL DEFAULT 'default',
  task_type    text NOT NULL,
  session_id   text,
  node         text,
  worst        text NOT NULL DEFAULT 'ok',
  collected_at timestamptz NOT NULL DEFAULT now(),
  payload      jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS opendb_task_collects_session_idx ON opendb_task_collects (task_type, session_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS opendb_task_collects_time_idx ON opendb_task_collects (collected_at DESC);
