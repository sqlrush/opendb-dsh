-- P3 多租户：RLS FORCE + 按连接 GUC app.tenant 隔离（createPool 经 startup options 注入）。
-- 覆盖全部带 tenant_id 的表（动态枚举，新表带 tenant_id 需重跑迁移或手工补策略）。
-- dsh_tenants 本身是租户注册表，不做行隔离。
-- ⚠ 运维 psql 注意：FORCE 后裸查询 0 行——先 SET app.tenant='default'（见 CLUSTER.md）。
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT DISTINCT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_name = c.table_name AND tb.table_schema = 'public' AND tb.table_type = 'BASE TABLE'
    WHERE c.column_name = 'tenant_id' AND c.table_schema = 'public' AND c.table_name <> 'dsh_tenants'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant'', true))',
      t.table_name);
  END LOOP;
END $$;

-- 租户配额（P3：无行 = 不限；治理动作在会话/psql 里 UPSERT）
CREATE TABLE IF NOT EXISTS opendb_tenant_quotas (
  tenant_id  text PRIMARY KEY,
  max_agents integer,
  max_nodes  integer,
  max_tasks  integer,
  note       text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
