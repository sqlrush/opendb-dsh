# P1 W5：记忆与知识 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans（会话内直接执行）。

**Goal:** 「次日对话能引用昨日巡检结论」——任务报告自动入记忆，会话自动注入相关记忆，模型可主动查/存。

**Architecture:** 设计 §8.3（借鉴 airush 分层：PG=真相 + 向量=语义；Redis/图 P3）。MVP 全在平台 PG（timescaledb-ha 自带 pgvector 0.8.6，1024 维 bge-m3）。embedding 经 `opendbEmbeddings` seam（OpenAI 兼容 /v1/embeddings），集群内 Ollama+bge-m3（mac 128GB，CPU 推理足够）。

**Spec:** docs/2026-08-16-opendb-dsh-platform-design.md §8.3。

## Global Constraints
- embedding 失败不阻塞写入（embedding 列可空，检索 fallback ILIKE）——记忆永远先落文本真相。
- 记忆注入走 agent/pre-step（instructions-pg 同款已验证模式）；工具注册走 function plugin 顶层 inject（W4 教训）。
- 已验证前提：pgvector 0.8.6 + 余弦距离 ✓；ollama arm64 ✓。

### 批次 1: Ollama 部署 + embeddings seam + memory-pg
- chart: ollama.yaml（Deploy+PVC+Svc :11434 + pull Job bge-m3，minio-init 同款模式）；commonEnv 加 OPENDB_EMBEDDINGS_URL/MODEL。
- packages/embeddings-openai-compat: `opendbEmbeddings.embed(texts)->float[][]`（POST /v1/embeddings；超时/重试；单测 mock 解析）。
- 迁移 007: opendb_memories(id, tenant_id, agent_id, kind episodic|fact|preference|report, content, source, embedding vector(1024) NULL, created_at) + hnsw cosine 索引 + agent/kind 索引。
- packages/memory-pg: `opendbMemory.write/search(向量→ILIKE fallback)/recent/prune`。

### 批次 2: memory-ingest + memory-context + tool-memory
- memory-ingest（Host）: 引擎 tick 后扫新报告 → 「[日期][任务名](severity) summary + top findings」→ opendbMemory.write(kind=report, source=runId)，幂等（source 唯一）。
- memory-context（Runtime）: agent/pre-step 注入「相关记忆」system-reminder（recent N=5 + search topK=5 by 用户消息，去重、字节上限）。
- tool-memory（Runtime, function plugin）: memory_search / memory_save。
- bundle-host: embeddings+memory-pg+memory-ingest；bundle-runtime: embeddings+memory-pg+memory-context+tool-memory。
### 批次 3: KEDA + preset + 验收
- KEDA helm 装集群 + ScaledObject（postgresql scaler: thread_queue 未认领数 → runtime-default 1..6）。
- 验收: runNow 巡检 → 报告入记忆（opendb_memories 有 report 行）→ 新会话问「上次巡检结论？」→ 模型引用记忆回答（不重新跑巡检工具）→ tool 主动 memory_save/search e2e。
