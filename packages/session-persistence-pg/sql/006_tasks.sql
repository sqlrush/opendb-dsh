-- W4: 任务插件契约（设计 §8.5，G1 冻结）：任务/运行/报告/审批 + dsh_schedules 收编。
CREATE TABLE IF NOT EXISTS dsh_tasks (
  id                text PRIMARY KEY,
  tenant_id         text NOT NULL DEFAULT 'default',
  agent_id          text NOT NULL REFERENCES dsh_agents(id),
  type              text NOT NULL,
  name              text NOT NULL,
  config            jsonb NOT NULL DEFAULT '{}',
  cron              text,                                -- NULL = 仅手动触发
  enabled           boolean NOT NULL DEFAULT true,
  requires_approval boolean NOT NULL DEFAULT false,
  timeout_ms        integer NOT NULL DEFAULT 600000,
  last_fired_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS dsh_task_runs (
  id           text PRIMARY KEY,
  task_id      text NOT NULL REFERENCES dsh_tasks(id) ON DELETE CASCADE,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('cron','manual','event')),
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','timeout')),
  session_id   text,
  error        text,
  fired_at     timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX IF NOT EXISTS dsh_task_runs_task_idx ON dsh_task_runs (task_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS dsh_task_runs_session_idx ON dsh_task_runs (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dsh_task_runs_open_idx ON dsh_task_runs (status) WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS dsh_task_reports (
  id         text PRIMARY KEY,
  run_id     text NOT NULL UNIQUE REFERENCES dsh_task_runs(id) ON DELETE CASCADE,
  task_id    text NOT NULL,
  severity   text NOT NULL CHECK (severity IN ('ok','warn','critical')),
  summary    text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dsh_approvals (
  id           text PRIMARY KEY,
  tenant_id    text NOT NULL DEFAULT 'default',
  kind         text NOT NULL CHECK (kind IN ('report-ack','action')),
  subject      text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  ref_run_id   text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by   text,
  decided_at   timestamptz,
  comment      text,
  expires_at   timestamptz
);
CREATE INDEX IF NOT EXISTS dsh_approvals_pending_idx ON dsh_approvals (requested_at) WHERE status = 'pending';

-- dsh_schedules 收编（G1 决策 1）：搬为 type='prompt' 的任务后删除旧表
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'dsh_schedules') THEN
    INSERT INTO dsh_tasks (id, tenant_id, agent_id, type, name, config, cron, enabled, last_fired_at)
      SELECT id, tenant_id, agent_id, 'prompt', name, jsonb_build_object('prompt', prompt), cron, enabled, last_fired_at
      FROM dsh_schedules
      ON CONFLICT (tenant_id, name) DO NOTHING;
    DROP TABLE dsh_schedules;
  END IF;
END $$;
