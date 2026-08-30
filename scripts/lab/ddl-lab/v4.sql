-- ddl_lab v4：删列、加列、删表（破坏性变更 DDLR01）
ALTER TABLE ddl_lab.customers DROP COLUMN email;
ALTER TABLE ddl_lab.products ADD COLUMN price numeric(12,2) NOT NULL DEFAULT 0;
DROP TABLE ddl_lab.audit_log;
