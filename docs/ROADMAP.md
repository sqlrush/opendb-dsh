# opendb-dsh Roadmap（v1.2，2026-08-17；MVP 数据库原型 = openGauss；**P0 已通过 G0 门，进入 P1**）

> 配套：设计 `docs/2026-08-16-opendb-dsh-platform-design.md`（v0.6）；P0 计划 `docs/superpowers/plans/2026-08-17-p0-host-dispatch-runtime-relay.md`。

## 0. 总览

```
 2026-08        09              10              11              12             2027-01
 ─┬────────────┬───────────────┬───────────────┬───────────────┬──────────────┬─────
  │ P0 验证    │  P1 MVP：单租户 PG 巡检/诊断平台           │  P2 执行与扇出          │ P3 规模与多租户 …
  │ ~1 周      │  ~5–6 周（含 2 周缓冲）                    │  ~5–6 周                │ ~6–8 周
  ▼            ▼                                           ▼                        ▼
  G0 门：代理   G1 门：任务插件契约冻结 / embedding 来源      G2 门：SSH 账号策略 /     G3 门：图库选型 /
  可行 or 备选   / 100 节点排程巡检跑通                        IM / 经审批变更落地       Host 多副本 / 2000 节点压测
```

假设：主要由 Claude 会话执行开发、user 负责环境/评审/关键决策；每阶段末尾有决策门（G），过门才进下一阶段；估时按"P0 的 4 个不确定点都成立"计，任一不成立走备选会在 P1 加 1–2 周。

## 1. 阶段与里程碑

### P0 · 可行性验证 ✅ 已通过（2026-08-17，实际 1 天）
- 目标：证明"Host 派发 + Runtime 接力"在 dsh rc.6 上成立，不改内核。
- 交付：`session-persistence-pg`、`agent-loop-dispatch`、`runtime-worker`、`bundle-host/runtime` + 2 个 profile + 一个镜像 + mac k8s 上 postgres/host×1/runtime×2。
- 验收：① UI 发消息 → Runtime A 执行并实时显示；② 杀 A → B 接力 resume；③ 跨 pod `ask_user`；④ 中断；⑤ `--dump-config` 无 PENDING。
- G0：代理 Agent 成立 → 进 P1；否则切 §9 备选，P1 范围不变、多 1–2 周。
- user 提供：mac SSH 授权、`DEEPSEEK_API_KEY`、mac 上 node22/pnpm/docker/k8s。

### P1 · MVP：单租户 openGauss（og）巡检/诊断平台（~5–6 周）

> MVP 数据库原型 = **openGauss**（user 2026-08-17）：数据库能力层经 `ctx.db` 方言 seam，MVP provider `db-opengauss`；P2 加 `db-postgres`（含 pgrac）。平台自身存储仍是 PostgreSQL。
| 周 | 主题 | 交付 |
|---|---|---|
| W1 | 数据面打底 | `storage-pg`、`attachment-s3`、`spill-s3`（MinIO）；`tenant-context`（全表 `tenant_id`，RLS 建不 FORCE）；迁移工具；Helm chart 骨架（host/runtime/collector/postgres+timescaledb+pgvector/minio） |
| W2 | 注册表 + agent 工作区 | `registry`（tenants/users/agents/db_nodes/db_groups + RPC + slots 页）；`directory-picker-agent`（真实目录）；`ui-agent-workspace`；`instructions-pg` |
| W3 | 数据库能力 + 采集（og） | `db` seam + `db-opengauss`（连接/认证适配：确认 node `pg` 驱动对 openGauss SHA256 的兼容，必要时 `password_encryption_type` 或 og 官方 Node 连接器；`dbe_perf.*`/`gs_*` 视图映射）+ `tool-db`（只读）；`metrics`/`dictionary` seam + `metrics-timescale` + `dictionary-pg` + `collector` class + `tool-metrics`；`scheduler` |
| W4 | 任务插件 + 审批 | `tasks` seam + `task-inspection` + `task-sql-audit`；`approval-platform` + `approval-ui` |
| W5 | 记忆与知识 | `memory`/`knowledge`/`embeddings` seam + `memory-pg` + `knowledge-pg` + `embeddings-openai-compat` + `memory-context` + `tool-memory` + `memory-ingest`；preset ConfigMap；KEDA |
| W6 | 收口 | e2e、conformance、`--dump-config` 快照 CI、文档、演示 |
- 验收：100 节点 / 5 agent 排程巡检跑通；SQL 审核每日出报告；审批端到端；随机杀 pod 不丢会话不丢采集；次日对话能引用昨日巡检结论。
- G1：任务插件契约冻结；embedding 来源定案；是否提前做认证。
- user 提供：3–5 个测试 **openGauss** 节点（mac docker `opengauss/opengauss` 镜像即可，含一主一备拓扑）；embedding 服务；MinIO/S3。

### P2 · 执行与扇出（~5–6 周）
| 周 | 主题 | 交付 |
|---|---|---|
| W1–2 | 远端执行 | `exec-ssh`（og 工具链 `gsql`/`gs_ctl`/`gs_om` 白名单）、`tool-fs-search-ssh`；`tool-db` 动作类；一次性令牌 + 白名单；preset `变更执行`；`db-postgres` provider（含 pgrac 的 `pg-ops`/`pg-rac` class） |
| W3 | 扇出与编排 | `subagent-queue`、`workflow-sandbox-job`、KEDA 调参 |
| W4 | 任务与告警 | `task-monitor-dashboard`、`task-incident`、DDL 告警 |
| W5 | 平台面 | `connection-auth` + Ingress 认证、`approval-im-feishu`/`-dingtalk`、`agent-presets-pg`、`session-query-pg`、`knowledge-ingest` + `ui-memory`/`ui-knowledge`、`storage-redis` 默认、`skill-pg`、**`mcp-db`**（把 `tool-db` 只读能力以 MCP server 对外暴露，供 Codex/Claude Code 使用；`skill-og` 已可移植） |
- 验收：经审批变更在目标主机执行并审计；扇出 10 子代理跨 pod；告警→诊断→审批→处置闭环；IM 审批可用。
- G2：SSH 账号策略；IM 优先级；IdP。

### P3 · 规模与多租户（~6–8 周）
- 规模：2000 节点压测（KEDA、`LISTEN/NOTIFY`、rollout 分区归档、连接池）。
- 多租户：RLS FORCE、租户配额、租户 → Host 池（人工治理）。
- Host 水平扩：cookie 粘性 + PG 共享注册表 + `NOTIFY` 桥接，HPA 按 WS 连接数。
- 记忆升级：`memory-graph`、`knowledge-vector`（可选）、`metrics-victoria`（可选）。
- 关闭项回归：`terminal-ssh`、`code-runtime-sandbox-job`。
- 验收：2000 节点稳态 4–6 副本、峰值 20；租户越权用例全绿；Host 3 副本无感切换。
- G3：图数据库选型；专用向量库是否需要。

## 2. 横切工作
CI 门（`--dump-config` 快照、真实 Loader e2e、`assertEntriesActivated`、patch lint、conformance）；dsh 升级（钉版，只重对齐 13 个替换 provider + 1 个改造包）；文档随决策更新；安全（Runtime 零本地执行、Secret/env、NetworkPolicy、遥测默认关）。

## 3. 依赖与 user 提供
| 时点 | 需要 |
|---|---|
| P0 前 | mac SSH 授权；node 22 / pnpm / docker / k8s；`DEEPSEEK_API_KEY` |
| P1 W3 前 | 3–5 个测试 openGauss 节点（含一主一备） |
| P1 W5 前 | embedding 服务（OpenAI 兼容）；MinIO/S3 |
| P2 前 | SSH 账号策略；IM 应用凭据；IdP |
| P3 前 | 图数据库选型；压测环境 |

## 4. 主要风险
P0 不确定点（备选已备）；dsh rc 升级（钉版 + conformance）；dsh Web UI 定制受限（seam 绕开/自研 slots）；上千节点连接数（连接池 + collector 独立池）；选型拖延（seam 留槽不阻塞）；单人带宽（每周可演示 + 门上裁剪）。

## 5. 度量
P0：接力 100%、回灌延迟 < 1s、PENDING=0；P1：100 节点巡检成功率 ≥ 99%、P95 < 3 min、杀 pod 零丢失、审批端到端 < 5s；P2：变更成功率 100% 含审计、扇出 P95 < 5 min；P3：2000 节点副本 ≤ 6、越权 0 通过、Host 切换无感。

## 6. 不在范围
MySQL 等非 PG 系数据库；k8s 内数据库（operator）；公有云 SaaS 化；移动端。
