-- W3 批次3: 定时任务（cron → 新会话入队；Host 内 scheduler 插件消费）
CREATE TABLE IF NOT EXISTS dsh_schedules (
  id              text PRIMARY KEY,
  tenant_id       text NOT NULL DEFAULT 'default',
  agent_id        text NOT NULL REFERENCES dsh_agents(id),
  name            text NOT NULL,
  cron            text NOT NULL,
  prompt          text NOT NULL,
  enabled         boolean NOT NULL DEFAULT true,
  last_fired_at   timestamptz,
  last_session_id text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
