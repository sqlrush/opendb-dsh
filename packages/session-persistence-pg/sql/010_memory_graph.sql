-- P3 记忆图谱（G3 选型判定：PG 原生做图——实体共现边 + 递归查询；不引入图数据库）。
-- 实体 = 记忆内容中出现的平台对象名（节点名/agent 名）；边 = 记忆↔实体隶属。
-- 两跳查询（实体→记忆→共现实体→记忆）覆盖「某节点相关历史事件链」这类关联推理。
CREATE TABLE IF NOT EXISTS opendb_memory_entities (
  memory_id  text NOT NULL REFERENCES opendb_memories(id) ON DELETE CASCADE,
  entity     text NOT NULL,
  kind       text NOT NULL DEFAULT 'node',   -- node | agent
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, entity)
);
CREATE INDEX IF NOT EXISTS opendb_memory_entities_entity_idx ON opendb_memory_entities (entity);

-- 抽取水位（memory-graph 插件的增量扫描游标；多 Host 副本由 leader 锁保护）
CREATE TABLE IF NOT EXISTS opendb_graph_state (
  key        text PRIMARY KEY,
  watermark  timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
