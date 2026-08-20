-- P3 agent-presets-pg：预设落库（PG 为真相；插件物化到 $DSH_HOME/.agent-presets 供 dsh 原生扫描）。
CREATE TABLE IF NOT EXISTS opendb_agent_presets (
  id              text PRIMARY KEY,   -- preset id = 目录名（dsh 校验 kebab/word 格式）
  tenant_id       text NOT NULL DEFAULT 'default',
  preset_yml      text NOT NULL,      -- preset.yml 内容（name/description/order）
  agent_cordis_yml text NOT NULL,     -- agent.cordis.yml 内容（agent 面插件组合）
  updated_at      timestamptz NOT NULL DEFAULT now()
);
