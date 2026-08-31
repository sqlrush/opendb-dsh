-- 2026-08-31 容量与增长报告（task-capacity）：容量采样时序。每次 capacity_collect 把库 / 数据目录（估算）/ 表空间 / schema /
-- Top 表 / 系统占用（statement_history、WDR、WAL、日志、审计、core）各记一行，增速回归、对象级 24h 增量、
-- 采集空窗都从这张表算；整包存档仍在 opendb_task_collects（task_type='capacity'）。~100 行/次。
CREATE TABLE IF NOT EXISTS opendb_capacity_samples (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL DEFAULT 'default',
  node         text NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now(),
  kind         text NOT NULL,          -- db | dir | tablespace | schema | table | sys
  name         text NOT NULL,          -- 库名 / 目录名 / 表空间名 / schema / sch.table / statement_history…
  bytes        bigint NOT NULL,
  extra        jsonb                   -- 行数、死元组、文件数等附加计数
);
CREATE INDEX IF NOT EXISTS opendb_capacity_samples_series_idx ON opendb_capacity_samples (node, kind, name, collected_at DESC);
CREATE INDEX IF NOT EXISTS opendb_capacity_samples_time_idx ON opendb_capacity_samples (collected_at DESC);
