-- W5: 记忆层（设计 §8.3 MVP：PG 真相 + pgvector 语义检索；bge-m3 1024 维）。
-- embedding 可空：embedding 服务不可用时先落文本（真相优先），检索回退 ILIKE。
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS opendb_memories (
  id         text PRIMARY KEY,
  tenant_id  text NOT NULL DEFAULT 'default',
  agent_id   text NOT NULL REFERENCES dsh_agents(id),
  kind       text NOT NULL CHECK (kind IN ('episodic','fact','preference','report')),
  content    text NOT NULL,
  source     text,                         -- 来源标识（run id / session id / manual）；报告记忆用它做幂等
  embedding  vector(1024),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opendb_memories_agent_idx ON opendb_memories (agent_id, kind, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS opendb_memories_source_uniq ON opendb_memories (agent_id, source) WHERE source IS NOT NULL;
DO $$ BEGIN
  BEGIN
    CREATE INDEX IF NOT EXISTS opendb_memories_embedding_idx ON opendb_memories USING hnsw (embedding vector_cosine_ops);
  EXCEPTION WHEN OTHERS THEN NULL;   -- hnsw 不可用（极老 pgvector）时纯顺扫，MVP 数据量无碍
  END;
END $$;
