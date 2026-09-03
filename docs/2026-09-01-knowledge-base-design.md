# 知识库大盘 + 导入工具 设计文档

> 2026-09-01。承接 `docs/2026-09-01-knowledge-graph-vs-vector.md`（三库分工定论）。
> 本文定两件事：**知识库大盘**（一眼看全记忆/向量/图三类知识）与**导入工具**（把用户各种文本材料分析后分流进三个库）。
> 状态：设计稿，待 user 评审通过后开码。原型 `docs/prototypes/knowledge-r1.html`。

## 1. 目标

- 用户能在一个页面看清平台"懂多少"：**记忆知识**（平台经历）、**向量知识**（非结构化资料）、**图知识**（客户专属关系）三类各有多少、健不健康、覆盖了哪些库/引擎。
- 用户丢进来一批文本（规范/工单/故障总结/预案…），平台**自动分析、分流、结构化，落进对应的库**，且全程可审可回溯。
- 严守平台铁律：**判定/写入归确定性层，模型只提议；降级即发现；引用必有出处。**

## 2. 背景与当前真实状态（og5，2026-09-01 实测）

| 库 | 现状 | 问题 |
|---|---|---|
| 记忆知识 `opendb_memories` | 849 条（report 784 / fact 57 / episodic 7 / preference 1），全部有向量，1 个 agent，08-18→09-01 | 都是**平台自己的经历**，客户侧知识为空 |
| 向量知识 `opendb_knowledge_docs/chunks` | 2 文档 / 7 切块，**仅 1 块有向量（14%）** | ① `ingest` 一次性 embed 全部切块，超时整篇落 NULL 且无补齐任务 → 永久退化成 ILIKE；② 报告未接 `knowledge_search`，"参考不改判"仅停在文档 |
| 图知识 `opendb_memory_entities` | 878 边 / 19 实体（18 node + 1 agent），842 条记忆关联；top 实体 og5(deg 832) | 只是**记忆实体共现**，不是设计里"现象/根因/处置/条款/对象"的客户专属图；边无类型、无来源、无版本 |

现有可复用组件：`knowledge-pg`（PG+pgvector）、`memory-pg`、`memory-graph`（PG 边表+两跳）、`embeddings-openai-compat`（bge-m3 1024 维）、`knowledge-vector`（Qdrant 加速）、`tool-knowledge` / `tool-memory` / `ui-knowledge` / `ui-memory`。

三库分工（详见分工定论文档，此处只列结论）：
- **关系型（PG）= 唯一真相 + 精确过滤 + pgvector**；**向量 = 语义召回**；**图 = 客户专属关系的多跳/可审计推理**（现阶段 PG 边表，规模到 3 跳变长 / 500 万边 / 需图算法再换引擎）。

## 3. 知识库大盘

### 3.1 定位与入口

侧栏新增**一级目录「知识库」**（与「工作区」「资源」同级），下挂两项：**知识库大盘**、**导入知识**。二者都是主区页面，不弹窗（纲领 §15：弹页面是稀缺品）。大盘纯只读展示；导入是主区多步向导。

### 3.2 大盘结构（自上而下）

1. **概览条（4 卡）**
   - 知识总量（三库合计条目数）
   - 覆盖引擎/环境（这些知识覆盖了哪些数据库引擎、环境）
   - 健康度（有多少向量缺失、多少图边待确认、多少采集空窗——**降级项一眼可见**）
   - 最近更新（最后一次导入/沉淀时间 + 24h 新增）

2. **三库分区卡**（并排，各一色，与分工文档一致）
   - **记忆知识**（平台经历）：按类型分布（报告/事实/情景/偏好）· 向量覆盖率 · 时间跨度 · 关联 agent；点开 → 记忆列表（`ui-memory` 已有，复用/接入）
   - **向量知识**（非结构化资料）：文档数 / 切块数 / **向量覆盖率**（红黄绿）· 按来源类型分布（规范/工单/故障/手册）· 覆盖引擎；点开 → 文档列表（`ui-knowledge` 已有）
   - **图知识**（客户专属关系）：实体数 / 边数 / **按关系类型分布**（约束/导致/处置/依赖/引用）· **待确认边数**（人审队列长度）· 已确认占比；点开 → 图浏览（实体搜索 + 两跳邻域，chart-kit/SVG 画，不引图库前端）

3. **健康自检条**（承平台"降级即发现"）
   - 向量缺失 N 块 → 一键"补齐向量"（后台任务）
   - 图待确认 M 条 → 跳"人审队列"
   - 采集空窗 / 过期规范（valid_to 已过仍被引用）→ 列出

4. **知识来源分布**（一张构成图）：按材料来源（规范/工单/故障总结/预案/采集）看各库贡献，回答"我灌进去的东西都去哪了"。

### 3.3 数据来源

大盘所有数字走 **`/opendb-knowledge` 通道新增 `dashboard` 端点**（只读聚合三库；host 侧，参照 task-rules 的 `/opendb-rules`）。取不到某一库时该卡**如实降级**，不编造。

## 4. 导入工具（会话式，2026-09-03 改定：不做页面，一切在会话完成——纲领 §15）

> 原设计是主区四步向导页；user 2026-09-03 要求改为**会话式交互导入**：用户在会话里说「把 xxx 导入知识库」，
> 模型解析材料、**自动逐条提问**让用户确认合理性，确认后才入库，结果在会话里展示。以下为落地形态。

### 4.1 交互流（全在会话里）

```
用户：把这份 X 导入知识库（+粘贴/附上正文）
  → 智能体调 kb_import：向量线确定性切块入库；关系候选暂存(不入图)；返回候选清单 + 待确认问题
  → 智能体用 ask_user_question 逐条提问：分类？适用引擎/环境？低置信关系保留？实体是否合并/改名？
用户：回答 / 指正（如「第 3 条删掉」「环境是生产」）
  → 智能体调 kb_commit(import_id, reject=[编号])：未剔除的候选写入强类型图 confidence=1.0
  → 会话里展示结果：「✅ 导入完成：图 N 条关系入图（剔除 M 条）；向量已入库」
```

- **向量线**：`kb_import` 内部服务端确定性切块 + embed，**不依赖模型是否配合**，调用即入库、可检索。
- **图线**：模型从材料抽候选三元组 `实体—关系—实体`（带 confidence/出处），落**暂存(staging)**，**不直接入图**。
- **提问**：`kb_import` 返回体里列出候选 + 需确认项（分类、适用范围、置信<0.7 的关系、歧义实体），并**明令模型先提问再 commit**；
  模型据此用 dsh 原生 `ask_user_question` 发起结构化问答。
- **入库**：用户确认后 `kb_commit` 把未剔除候选按 canonical 归一节点写入 `kg_nodes/kg_edges`（confidence=1.0，带来源）。
- **展示**：每次导入的解析摘要、候选清单、提问、最终入库结果都在会话消息流里；大盘只读反映三库总量。

### 4.2 关键原则（防止变成"另一个 BIC"）

- **模型 propose，系统 + 人 dispose**：模型只交候选，写库是确定性管线 + 人审。
- **同源重灌出新版本，不覆盖**：规范会改，引用要追到"当时依据哪一版"。
- **拓扑/依赖/变更史不走导入**：那些来自采集器/系统目录/变更单系统，确定性直写图，不经模型（本工具只处理"用户提供的文本材料"）。
- **离线管线**：导入是独立后台流程（参照 memory-ingest 扫描式），诊断会话只读不写。

### 4.3 分析用哪个模型

抽取走 Runtime 编排的大模型（DeepSeek-v4 / Kimi K3）；嵌入走 bge-m3。抽取是离线任务，不占诊断链路。

## 5. 数据模型新增

```sql
-- 图知识：强类型边（替代/升级现有 opendb_memory_entities 的共现边）
CREATE TABLE opendb_kg_nodes (
  id text PRIMARY KEY, tenant_id text NOT NULL DEFAULT 'default',
  kind text NOT NULL,               -- object|symptom|rootcause|action|clause|change|incident
  name text NOT NULL, canonical text,-- 归一名（core_acct / 核心账户表 → 同一 canonical）
  attrs jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE opendb_kg_edges (
  id text PRIMARY KEY, tenant_id text NOT NULL DEFAULT 'default',
  src_id text NOT NULL REFERENCES opendb_kg_nodes(id),
  dst_id text NOT NULL REFERENCES opendb_kg_nodes(id),
  rel_type text NOT NULL,           -- constrains|causes|handled_by|depends_on|references|triggers
  source_kind text, source_id text, -- 出自哪份材料/采集
  confidence real NOT NULL DEFAULT 0,-- 人确认 = 1.0；<1.0 仅召回不入确定性推理
  valid_from timestamptz, valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 导入批次 + 人审暂存
CREATE TABLE opendb_kb_imports (
  id text PRIMARY KEY, tenant_id text NOT NULL DEFAULT 'default',
  filename text, material_kind text, engine text, env text, status text, -- pending|confirmed|imported|rejected
  vector_chunks int DEFAULT 0, edge_candidates int DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE opendb_kb_edge_staging (
  id text PRIMARY KEY, import_id text NOT NULL REFERENCES opendb_kb_imports(id) ON DELETE CASCADE,
  src_name text, rel_type text, dst_name text, source_locator text, confidence real,
  decision text  -- pending|accept|edit|reject
);
```
现有 `opendb_knowledge_docs/chunks`、`opendb_memories` 沿用；`opendb_knowledge_docs` 加 `material_kind / engine / env / valid_from / valid_to / version` 列。

## 6. 检索集成（顺带修两个存量 bug）

- **向量补齐后台任务**：扫 `embedding IS NULL` 分批 embed（修 6/7 缺向量）。
- **报告接知识库**：采集器出确定性发现后，按 `规则码+对象+现象词` 检索三库，命中随存档落库，报告面板每条发现旁显示"贵行规范怎么说 + 历史怎么处置"（引用必有出处，查不到写"无对应规范"）。
- **混合检索编排**：向量 + 词法（pg_trgm/BM25）+ 结构过滤 + 图两跳扩展 → 重排。

## 7. 插件接线

| 包 | 变更 | host/runtime |
|---|---|---|
| `knowledge-pg` | `dashboard` 聚合、向量补齐任务、docs 元数据列 | host+runtime |
| `memory-pg` | 大盘只读聚合 | host+runtime |
| `memory-graph` → 升级/新增 `knowledge-graph` | 强类型 `kg_nodes/edges`、参数化跳数递归查询、图 seam `opendbGraph` | host 抽取 / runtime 查询 |
| 新 `kb-ingest`（离线管线） | 分析分流 + 向量线 + 图候选抽取 + 写暂存 | host |
| 新 `tool-kb-import`（可选，会话触发导入） | 独立 function plugin | runtime |
| `ui-knowledge` | 扩 `/opendb-knowledge` 的 `dashboard` / `imports` / `staging` 端点 | host |
| 新 `ui-kb`（client-only 面板） | 知识库大盘 + 导入向导（空 `apply`，对照 ui-cluster） | host |
| `ui-harness` | 侧栏「知识库」一级目录（`registerResourcePanel` 同款 key 化，或新增 section） | host |

> `connection`/`webServer` 只在 host——注册 RPC 通道走**嵌套 `ctx.inject(['connection'],…)`**，双装包顶层 inject 会让 Runtime 崩循环（v0.3.0 实证，见 CLUSTER.md）。

## 8. 分期与验收

- **P1 大盘（先做，本轮）**：`ui-kb` 大盘面板 + `dashboard` 端点，只读展示三库真实数字与健康自检。验收 `scripts/browser/kb-check.mjs`（三区齐、数字对得上库、降级如实、console 零错误）。
- **P2 导入工具**：向导 + `kb-ingest` 管线 + 人审队列 + 暂存表；e2e：投喂一份样例规范 → 分流 → 人审 → 入库 → 大盘数字变化。
- **P3 强类型图 + 报告接入**：`kg_nodes/edges` + 图 seam + 报告引用 + 向量补齐 + 混合检索。

## 9. 待定问题（评审时定）

1. 大盘的图知识分区，前端画到什么程度——只给统计 + 实体搜索两跳邻域,还是要交互式关系图?(建议先前者,SVG 画,不引前端图库)
2. 人审队列的粒度——逐条边审,还是按材料批量审?(建议：按材料批量呈现、逐条可否决)
3. 导入是否允许纯会话触发(丢文件给智能体说"入库")?还是只走大盘向导?(建议两者都要,向导为主)
4. 「知识库」做成侧栏一级目录,还是并进「资源」下?(建议独立一级目录——它是客户数据资产,比只读资源视图重)
