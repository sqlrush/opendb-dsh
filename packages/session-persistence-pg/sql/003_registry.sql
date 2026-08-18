-- opendb-dsh P1 W2: platform registry (tenants / users / agents / db_nodes / db_groups).
CREATE TABLE IF NOT EXISTS dsh_tenants (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO dsh_tenants (id, name) VALUES ('default', 'Default') ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS dsh_users (
  id         text PRIMARY KEY,
  tenant_id  text NOT NULL DEFAULT 'default' REFERENCES dsh_tenants(id),
  name       text NOT NULL,
  role       text NOT NULL DEFAULT 'operator' CHECK (role IN ('admin','operator','viewer')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dsh_agents (
  id                  text PRIMARY KEY,
  tenant_id           text NOT NULL DEFAULT 'default' REFERENCES dsh_tenants(id),
  name                text NOT NULL,
  kind                text NOT NULL DEFAULT 'domain' CHECK (kind IN ('domain','assistant')),
  runtime_class       text NOT NULL DEFAULT 'default',
  preset              text NOT NULL DEFAULT 'standard',
  model_provider      text,
  model_name          text,
  instruction_doc     text NOT NULL DEFAULT '',
  instruction_version integer NOT NULL DEFAULT 0,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  workspace_id        text,                      -- dsh workspace bound to this agent (workspace == agent)
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS dsh_db_groups (
  id         text PRIMARY KEY,
  tenant_id  text NOT NULL DEFAULT 'default' REFERENCES dsh_tenants(id),
  name       text NOT NULL,
  kind       text NOT NULL DEFAULT 'primary_standby' CHECK (kind IN ('primary_standby','cluster','single')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS dsh_db_nodes (
  id         text PRIMARY KEY,
  tenant_id  text NOT NULL DEFAULT 'default' REFERENCES dsh_tenants(id),
  agent_id   text REFERENCES dsh_agents(id),
  group_id   text REFERENCES dsh_db_groups(id),
  group_role text CHECK (group_role IN ('primary','standby','replica','node')),
  name       text NOT NULL,
  engine     text NOT NULL DEFAULT 'opengauss' CHECK (engine IN ('opengauss','postgresql')),
  host       text NOT NULL,
  port       integer NOT NULL DEFAULT 5432,
  dbname     text NOT NULL DEFAULT 'postgres',
  username   text,                         -- platform account; password 由 Secret/env 提供，不落库
  ssh_target text,                         -- user@host for P2 exec-ssh
  status     text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','online','offline','degraded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS dsh_db_nodes_agent_idx ON dsh_db_nodes (agent_id) WHERE agent_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dsh_users','dsh_agents','dsh_db_groups','dsh_db_nodes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'tenant_isolation') THEN
      EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (current_setting('app.tenant_id', true) IS NULL OR current_setting('app.tenant_id', true) = '' OR tenant_id = current_setting('app.tenant_id', true))$p$, t);
    END IF;
  END LOOP;
END $$;
