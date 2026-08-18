-- W3 批次2: 监控指标（timescaledb hypertable 由 metrics-timescale 服务启动时尝试转换，
-- 无 timescaledb 扩展时保持普通表 + 索引）与数据字典快照/变更。
CREATE TABLE IF NOT EXISTS opendb_metrics (
  time      timestamptz NOT NULL,
  tenant_id text NOT NULL DEFAULT 'default',
  node_id   text NOT NULL,
  metric    text NOT NULL,
  value     double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS opendb_metrics_node_metric_time_idx ON opendb_metrics (node_id, metric, time DESC);

CREATE TABLE IF NOT EXISTS opendb_dict_objects (
  tenant_id  text NOT NULL DEFAULT 'default',
  node_id    text NOT NULL,
  kind       text NOT NULL,
  sch        text NOT NULL,
  name       text NOT NULL,
  signature  text NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, kind, sch, name)
);

CREATE TABLE IF NOT EXISTS opendb_dict_changes (
  id            bigserial PRIMARY KEY,
  time          timestamptz NOT NULL DEFAULT now(),
  tenant_id     text NOT NULL DEFAULT 'default',
  node_id       text NOT NULL,
  kind          text NOT NULL,
  sch           text NOT NULL,
  name          text NOT NULL,
  change        text NOT NULL CHECK (change IN ('added','removed','modified')),
  old_signature text,
  new_signature text
);
CREATE INDEX IF NOT EXISTS opendb_dict_changes_node_time_idx ON opendb_dict_changes (node_id, time DESC);
