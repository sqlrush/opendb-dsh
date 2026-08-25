-- 阈值可配置化（user 2026-08-24：独立插件展示全部报警/判定阈值，支持会话修改）。
-- 代码里的常量降为默认值，本表只存「被改过的」覆盖项；未覆盖的键不落行，读取时与默认值合并。
-- 判定语义（比较方向、级别阶梯）仍由各插件代码定义，这里只管数值——借鉴成果不大改。
CREATE TABLE IF NOT EXISTS opendb_thresholds (
  plugin      text        NOT NULL,             -- health / sqlreview / wdr / ddl
  key         text        NOT NULL,             -- 点路径，如 connRatio.warn、bloatMinLive
  value       double precision NOT NULL,
  tenant_id   text        NOT NULL DEFAULT 'default',
  reason      text        NOT NULL DEFAULT '',
  updated_by  text        NOT NULL DEFAULT '',  -- 会话 id / 'system'
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin, key, tenant_id)
);

-- 变更历史：谁在什么时候把哪个阈值从多少改到多少（new_value 为 NULL = 重置回默认）
CREATE TABLE IF NOT EXISTS opendb_threshold_changes (
  id          bigserial   PRIMARY KEY,
  plugin      text        NOT NULL,
  key         text        NOT NULL,
  old_value   double precision,
  new_value   double precision,
  reason      text        NOT NULL DEFAULT '',
  changed_by  text        NOT NULL DEFAULT '',
  tenant_id   text        NOT NULL DEFAULT 'default',
  changed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS opendb_threshold_changes_time_idx
  ON opendb_threshold_changes (tenant_id, changed_at DESC);
