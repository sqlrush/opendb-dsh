-- P3 补齐：租户→Host 池映射（人工治理字段——值=该租户路由的 host deployment 名；
-- 单租户 lab 全部 default 池。真正的池路由在多 Host 池部署形态时经 ingress/租户身份接线）。
ALTER TABLE dsh_tenants ADD COLUMN IF NOT EXISTS host_pool text NOT NULL DEFAULT 'opendb-dsh-host';
