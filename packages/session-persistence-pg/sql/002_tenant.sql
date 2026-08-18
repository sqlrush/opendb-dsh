-- opendb-dsh P1 W1: tenant framework (columns + RLS policies, NOT forced yet). Single tenant 'default' in MVP.
ALTER TABLE dsh_sessions      ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'default';
ALTER TABLE dsh_threads       ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'default';
ALTER TABLE dsh_thread_queue  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'default';
ALTER TABLE dsh_questions     ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS dsh_sessions_tenant_idx ON dsh_sessions (tenant_id);
CREATE INDEX IF NOT EXISTS dsh_threads_tenant_idx  ON dsh_threads (tenant_id);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dsh_sessions','dsh_threads','dsh_thread_queue','dsh_questions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'tenant_isolation') THEN
      EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (current_setting('app.tenant_id', true) IS NULL OR current_setting('app.tenant_id', true) = '' OR tenant_id = current_setting('app.tenant_id', true))$p$, t);
    END IF;
  END LOOP;
END $$;
