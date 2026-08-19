-- P2 W3: 知识库（文档 → 切块 → pgvector 语义检索；与记忆同构，域不同：知识=外部资料，记忆=经历事实）。
-- agent_id 可空 = 全局知识（所有智能体可检索）；source 唯一支撑同源文档重灌幂等（替换旧版本）。
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS opendb_knowledge_docs (
  id         text PRIMARY KEY,
  tenant_id  text NOT NULL DEFAULT 'default',
  agent_id   text REFERENCES dsh_agents(id),
  title      text NOT NULL,
  source     text,
  chunks     integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS opendb_knowledge_docs_source_uniq
  ON opendb_knowledge_docs (tenant_id, coalesce(agent_id, ''), source) WHERE source IS NOT NULL;
CREATE TABLE IF NOT EXISTS opendb_knowledge_chunks (
  id         text PRIMARY KEY,
  doc_id     text NOT NULL REFERENCES opendb_knowledge_docs(id) ON DELETE CASCADE,
  seq        integer NOT NULL,
  content    text NOT NULL,
  embedding  vector(1024)
);
CREATE INDEX IF NOT EXISTS opendb_knowledge_chunks_doc_idx ON opendb_knowledge_chunks (doc_id, seq);
DO $$ BEGIN
  BEGIN
    CREATE INDEX IF NOT EXISTS opendb_knowledge_chunks_embedding_idx ON opendb_knowledge_chunks USING hnsw (embedding vector_cosine_ops);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;
