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
| W1 ✅ | 数据面打底 | `storage-pg`、`attachment-s3`、`spill-s3`（MinIO）；`tenant-context`（全表 `tenant_id`，RLS 建不 FORCE）；迁移工具；Helm chart 骨架（host/runtime/collector/postgres+timescaledb+pgvector/minio） |
| W2 ✅ | 注册表 + agent 工作区 | `registry`（tenants/users/agents/db_nodes/db_groups + RPC + slots 页）；`directory-picker-agent`（真实目录）；`ui-agent-workspace`；`instructions-pg` |
| W3 ✅（2026-08-18） | 数据库能力 + 采集（og） | `db` seam + `db-opengauss`（连接/认证适配：确认 node `pg` 驱动对 openGauss SHA256 的兼容，必要时 `password_encryption_type` 或 og 官方 Node 连接器；`dbe_perf.*`/`gs_*` 视图映射）+ `tool-db`（只读）；`metrics`/`dictionary` seam + `metrics-timescale` + `dictionary-pg` + `collector` class + `tool-metrics`；`scheduler` |
| W4 ✅（2026-08-19，核心链路验收通过；真实类型报告在途） | 任务插件 + 审批 | `tasks` seam + `task-inspection` + `task-sql-audit`；`approval-platform` + `approval-ui` |
| W5 ✅（2026-08-19，核心验收「次日引用昨日巡检结论」通过；KEDA 并入 W6） | 记忆与知识 | `memory`/`knowledge`/`embeddings` seam + `memory-pg` + `knowledge-pg` + `embeddings-openai-compat` + `memory-context` + `tool-memory` + `memory-ingest`；preset ConfigMap；KEDA |
| W5.5 ✅（2026-08-19，产品壳+插件面板全量交付并浏览器行为验证） | 产品壳重设计 + 插件面板 | 侧栏 dsh 原版风格（品牌接管/智能体分组/单滚动条/原生 hover）；主区任务框架 + registerTaskPanel 插槽；**task-inspection/client**、**task-sql-audit/client** 专属大盘；节点监控详情页（波形+字典变更）；**platform-status** 全局资源大盘（k8s 只读 RBAC + pod 拓扑 + token 用量）；**onboarding** 首开向导（命名默认智能体） |
| W6 | 收口 | e2e、conformance、`--dump-config` 快照 CI、文档、演示 |
- 验收：100 节点 / 5 agent 排程巡检跑通；SQL 审核每日出报告；审批端到端；随机杀 pod 不丢会话不丢采集；次日对话能引用昨日巡检结论。
- G1：任务插件契约 ✅ 已冻结（2026-08-19，设计 §8.5：task_report 工具提交、审批=P1 报告签收、dsh_schedules 收编）；embedding 来源 ✅ 已定（Ollama+bge-m3）；认证不提前（P2）。
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

## 7. 插件地图（万物皆插件——每个节点的插件交付清单，2026-08-19 增补）

### 插件界定原则（CLAUDE.md 同步）
- 一切功能落为 cordis 插件；**任务类型 = 双半边插件**（server 半边注册 TaskType，client 半边 registerTaskPanel 注册专属大盘）。
- 领域 UI 面板独立成 client 插件；`ui-harness`（产品壳）与 `ui-opendb`（通用 RPC 通道）只做平台底座，不吸领域功能。
- seam（Definition）先行，provider 可替换：db/metrics/dictionary/tasks/approvals/memory/embeddings 均已成 seam。

### 已交付插件（26 个，P0–W5.5）
| seam/层 | 插件 |
|---|---|
| 内核适配 | session-persistence-pg · agent-loop-dispatch · runtime-worker · bundle-host/runtime/collector |
| 存储 | storage-pg · attachment-s3 · spill-s3(+read_spill) · tool-read-spill |
| 平台 | registry · tenant-context · directory-picker-agent · instructions-pg |
| 数据库能力 | db(seam+pg基线) · db-opengauss · tool-db |
| 采集 | metrics-timescale · dictionary-pg · collector · tool-metrics |
| 任务/审批 | tasks(引擎+契约) · approvals · task-inspection · task-sql-audit · tool-task-report · tool-task-admin |
| 记忆 | embeddings-openai-compat · memory-pg · memory-ingest · memory-context · tool-memory |
| UI 底座 | ui-opendb(RPC) · ui-harness(壳) |

### 剩余节点 → 插件交付
| 节点 | 需开发插件 |
|---|---|
| W5.5·任务大盘 ✅ | task-inspection/client、task-sql-audit/client（双半边补全：registerTaskPanel 专属面板——findings 分组/severity 徽标/SQL 建议卡片） |
| W5.5·节点监控 ✅ | ui-node-monitor（先内聚 ui-opendb+ui-harness 交付 ✅，W6 拆独立 client 插件还债） |
| W5.5·资源大盘 ✅ | platform-status（Host：k8s 只读 RBAC + pod 拓扑 RPC + 模型 token 用量统计[今日/近7日/Top会话]；client 半边经 registerResourcePanel 进驻资源页；已完成 Job Pod 灰点标注） |
| W5.5·首开向导 ✅ | onboarding（client-only：零 agent 空态全屏欢迎页——命名默认智能体+可选纳管节点，复用 /opendb RPC，`#onboarding` 调试入口；空态判定失败 fail-safe 不挡人） |
| W6·扩缩 | KEDA ScaledObject（k8s 配置，PG scaler 直查 thread_queue，无需插件）；**规模验收环境=独立 og k8s 集群**（user 2026-08-19 定案：数据库 pod 不与平台同集群——新 OrbStack VM 起第二套 k3s，~20 真 og-lite pod + 930 逻辑别名=950 节点，mac 128G 内存；平台跨 VM 网络接入） |
| W6·收口 | conformance 测试资产（非插件）；ui-node-monitor 拆包还债；**UI 视觉集中优化**（user 2026-08-19：内容可以，UI 难看——任务/资源/节点详情/向导四页统一打磨：间距/层次/图表质感/空态，对齐 dsh 原版质感） |
| P2 W1-2 | **exec-ssh**（gsql/gs_ctl/gs_om 白名单）· **tool-db-actions**（动作类，经审批）· **db-postgres**（含 pgrac 方言）· **preset-change-execution** · **token-issuer**（一次性令牌） |
| P2 W3 | **subagent-queue** · **workflow-sandbox-job** |
| P2 W4 | **task-monitor-dashboard**（双半边：runMode:'service' 首个实践）· **task-incident**（双半边）· **alert-ddl** |
| P2 W5 | **connection-auth** · **approval-im-feishu** / **approval-im-dingtalk**（ApprovalProvider seam 首批外部 provider）· **agent-presets-pg** · **session-query-pg** · **knowledge-ingest** · **ui-memory** / **ui-knowledge** · **storage-redis** · **skill-pg** · **mcp-db**（tool-db 以 MCP 对外） |
| P3 | **memory-graph** · **knowledge-vector** · **metrics-victoria** · **host-notify-bridge**（多 Host NOTIFY 桥）· **terminal-ssh** / **code-runtime-sandbox-job**（回归） |
