-- 2026-08-26 健康报告改造（user）：面板直读采集器的确定性结果，不经模型转述。
-- health_collect 每次采集把完整结构（每维 measures/charts/findings、生效阈值）按会话存档；
-- 任务面板按 run.session_id 取当次采集。payload 体积 ~10-30KB/次，按天保留策略后续再定。
CREATE TABLE IF NOT EXISTS opendb_health_collects (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL DEFAULT 'default',
  session_id   text,
  scope        text NOT NULL,
  worst        text NOT NULL,
  node_count   int  NOT NULL DEFAULT 0,
  collected_at timestamptz NOT NULL DEFAULT now(),
  payload      jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS opendb_health_collects_session_idx ON opendb_health_collects (session_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS opendb_health_collects_time_idx ON opendb_health_collects (collected_at DESC);
