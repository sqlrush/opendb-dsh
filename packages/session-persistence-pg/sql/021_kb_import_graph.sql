-- 021：知识库导入工具（P2）+ 强类型图（P3 落点，导入 commit 的目标表）。
-- 设计见 docs/2026-09-01-knowledge-base-design.md。写入纪律：模型只提议候选边（staging），
-- 人审确认后才写进 kg_edges（confidence=1.0），进入确定性推理。

-- 导入批次
CREATE TABLE IF NOT EXISTS opendb_kb_imports (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL DEFAULT 'default',
  filename      text,
  material_kind text,                       -- 规范 / 工单 / 故障总结 / 手册 / 预案
  engine        text,                        -- 适用引擎（openGauss/…）
  env           text,                        -- 适用环境
  status        text NOT NULL DEFAULT 'pending',  -- pending | committed | rejected
  vector_chunks int NOT NULL DEFAULT 0,
  edge_candidates int NOT NULL DEFAULT 0,
  session_id    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opendb_kb_imports_time_idx ON opendb_kb_imports (tenant_id, created_at DESC);

-- 图候选边暂存（人审队列）
CREATE TABLE IF NOT EXISTS opendb_kb_edge_staging (
  id           text PRIMARY KEY,
  import_id    text NOT NULL REFERENCES opendb_kb_imports(id) ON DELETE CASCADE,
  src_name     text NOT NULL,
  rel_type     text NOT NULL,               -- constrains|causes|handled_by|depends_on|references|triggers
  dst_name     text NOT NULL,
  src_kind     text,
  dst_kind     text,
  source_locator text,                       -- 出自材料哪一段（§4.2 第3页…）
  confidence   real NOT NULL DEFAULT 0,
  decision     text NOT NULL DEFAULT 'pending', -- pending | accept | reject
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opendb_kb_edge_staging_import_idx ON opendb_kb_edge_staging (import_id);

-- 强类型知识图谱：节点
CREATE TABLE IF NOT EXISTS opendb_kg_nodes (
  id         text PRIMARY KEY,
  tenant_id  text NOT NULL DEFAULT 'default',
  kind       text NOT NULL,                  -- object|symptom|rootcause|action|clause|change|incident
  name       text NOT NULL,
  canonical  text NOT NULL,                  -- 归一名（core_acct / 核心账户表 → 同一 canonical）
  attrs      jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS opendb_kg_nodes_canon_uniq ON opendb_kg_nodes (tenant_id, canonical);

-- 强类型知识图谱：边（confidence=1.0 = 人确认，可进确定性推理；带来源与生效期）
CREATE TABLE IF NOT EXISTS opendb_kg_edges (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL DEFAULT 'default',
  src_id      text NOT NULL REFERENCES opendb_kg_nodes(id) ON DELETE CASCADE,
  dst_id      text NOT NULL REFERENCES opendb_kg_nodes(id) ON DELETE CASCADE,
  rel_type    text NOT NULL,
  source_kind text, source_id text, source_locator text,
  confidence  real NOT NULL DEFAULT 1.0,
  valid_from  timestamptz, valid_to timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opendb_kg_edges_src_idx ON opendb_kg_edges (tenant_id, src_id, rel_type);
CREATE INDEX IF NOT EXISTS opendb_kg_edges_dst_idx ON opendb_kg_edges (tenant_id, dst_id, rel_type);

-- 知识文档元数据（分类 / 适用范围 / 版本 / 生效期），ingest 时可选写入
ALTER TABLE opendb_knowledge_docs ADD COLUMN IF NOT EXISTS material_kind text;
ALTER TABLE opendb_knowledge_docs ADD COLUMN IF NOT EXISTS engine text;
ALTER TABLE opendb_knowledge_docs ADD COLUMN IF NOT EXISTS env text;
ALTER TABLE opendb_knowledge_docs ADD COLUMN IF NOT EXISTS valid_from timestamptz;
ALTER TABLE opendb_knowledge_docs ADD COLUMN IF NOT EXISTS valid_to timestamptz;
