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
| W6 ✅（2026-08-19，全项完成；文档演示见 CLUSTER.md 各复盘节） | 收口 | 韧性债务（stale-claim 重放/sessionIds 根治/agents-dir PVC）；杀 Pod e2e PASS；KEDA 扩缩实测（含 maxConcurrent 关键修复）；**950 节点/5 agent 规模验收超额通过**（独立 og k8s 集群，P95=66s，覆盖率 100%）；GitHub Actions CI 门全绿（build+patch lint+dump-config PENDING+PG 单测）；UI 视觉第一轮+数据库页规模化；ui-node-monitor 拆包还债 |
- 验收：100 节点 / 5 agent 排程巡检跑通；SQL 审核每日出报告；审批端到端；随机杀 pod 不丢会话不丢采集；次日对话能引用昨日巡检结论。
- G1：任务插件契约 ✅ 已冻结（2026-08-19，设计 §8.5：task_report 工具提交、审批=P1 报告签收、dsh_schedules 收编）；embedding 来源 ✅ 已定（Ollama+bge-m3）；认证不提前（P2）。
- user 提供：3–5 个测试 **openGauss** 节点（mac docker `opengauss/opengauss` 镜像即可，含一主一备拓扑）；embedding 服务；MinIO/S3。

### P2 · 观测闭环与平台面（user 2026-08-19 重排：「能动手」/IM 审批/mcp-db 先不做，进暂缓池）
| 周 | 主题 | 交付 |
|---|---|---|
| W1 ✅（2026-08-19，全链路演练通过） | 事件驱动运维 | alert-ddl（水位扫描→按 agent 触发，冷却+判重+任务自举）+ task-incident 双半边（诊断 prompt+事故面板）+ 引擎报告催交补救；演练：真实 DDL→检出→5 agent 并发诊断→报告全 ok→签收单自动补建 |
| W2 ✅（2026-08-19，service 契约落地+技能实战验证） | 常驻监控 + 技能 | runMode:'service' 引擎生命周期（reconcile/指纹重启/跨重启存活实证）+ task-monitor-dashboard 双半边（60s 阈值快照+实时大盘：状态大牌/水位条/24h 色带/异常榜）+ skill-pg 四技能（模型实战加载并严格循 SOP） |
| W3 ✅（2026-08-19，会话灌入→检索引用 e2e 通过） | 知识与检索 | knowledge-pg（切块+pgvector+source 幂等）+ tool-knowledge（knowledge_ingest/search 会话主路径）+ ui-knowledge/ui-memory 设置管理段（双半边自有通道）+ session-query-pg 会话全文检索+侧栏内容命中区 |
| W4 ✅（2026-08-19，P2 收官） | 平台面收尾 | connection-auth 简版上线（traefik basicAuth 护全入口，三态 401/401/200 实测；凭据 mac 本地不进 git；e2e/puppeteer 工具链适配）；agent-presets-pg 顺延（dsh preset 强绑文件树，ConfigMap 已等效）；storage-redis 顺延（PG 无瓶颈实证）；UI 二轮等 user 反馈 |
- 验收：DDL 告警→自动诊断→报告→签收闭环端到端；常驻监控任务跨重启存活；知识库可灌可查可管；控制台需登录。
- 扇出（`subagent-queue`/`workflow-sandbox-job`）暂缓：950 节点验收未暴露单代理瓶颈，出现瓶颈时再激活。

### 暂缓池（user 2026-08-19 决策：先不做，条件成熟再解冻）
| 组 | 内容 | 解冻条件 |
|---|---|---|
| 「能动手」远端执行 | `exec-ssh`（gsql/gs_ctl/gs_om 白名单）· `tool-db-actions`（动作类，经审批）· `token-issuer`（一次性令牌）· `preset-change-execution` · `tool-fs-search-ssh` · `db-postgres`（含 pgrac 方言） | user 拍板启动 + SSH 账号策略（原 G2 门） |
| IM 审批 | `approval-im-feishu` / `approval-im-dingtalk`（ApprovalProvider seam 外部 provider） | user 拍板 + IM 应用凭据 |
| MCP 对外 | `mcp-db`（tool-db 只读能力以 MCP server 暴露给 Codex/Claude Code） | user 拍板 |
| 扇出编排 | `subagent-queue` · `workflow-sandbox-job` | 单代理出现实际瓶颈 |
| 审批签收（2026-08-21 下线） | `approvals` 服务 + 引擎 createPendingAcks + 控制台待签收区 + task_create 签收参数（代码保留在 packages/approvals，装配已拆） | user 解除只读定位（平台重新引入变更/操作类功能时） |

### P3 · 规模与多租户 ✅（2026-08-19/20 全项收官，详见 CLUSTER.md P3 复盘节）
- 规模 ✅：2001 节点采集覆盖率 100%（60s 零滑期，collector 5m CPU/118Mi）；舰队巡检 5/5 P95=91s；
  metrics 7 天保留策略；KEDA 弹性字面达成（2026-08-20 负载实测：稳态段 2→4→6→9 平台、突发顶格 20、全自动回落——「稳态 4-6/峰值 20」全区间穿越）；
  LISTEN/NOTIFY 判定不需要（2s poll 无感）。
- 多租户 ✅：009 动态 FORCE RLS（16 表+WITH CHECK）+ 连接级 app.tenant 注入 + 配额表与三创建口检查；
  越权用例 3/3 绿（跨租户零行/写拒绝/无 GUC fail-closed）。**生产多租户检查单：平台须以非超级角色连 PG**
  （superuser 无条件绕过 RLS）。
- Host 水平扩 ✅：3 副本 + sticky cookie + session 级 advisory leader（引擎/告警/图抽取三处）；
  杀 leader 6 秒接管、切换零中断。HPA-by-WS 以固定 3 副本满足验收；NOTIFY 桥经架构复核无消费场景
  （产品面全部 PG 直查）。
- 记忆升级 ✅：memory-graph（G3 判定=PG 原生边表+两跳查询，不引图库）e2e 通过；
  knowledge-vector / metrics-victoria 判定不需要（pgvector/Timescale 实证够用）。
- 关闭项回归：terminal-ssh / code-runtime-sandbox-job 与「能动手」共享 SSH/执行前提 → 随暂缓池解冻。
- G3 ✅ 已决：图库=PG 原生；专用向量库=不需要。

## 2. 横切工作
CI 门（`--dump-config` 快照、真实 Loader e2e、`assertEntriesActivated`、patch lint、conformance）；dsh 升级（钉版，只重对齐 13 个替换 provider + 1 个改造包）；文档随决策更新；安全（Runtime 零本地执行、Secret/env、NetworkPolicy、遥测默认关）。

## 3. 依赖与 user 提供
| 时点 | 需要 |
|---|---|
| P0 前 | mac SSH 授权；node 22 / pnpm / docker / k8s；`DEEPSEEK_API_KEY` |
| P1 W3 前 | 3–5 个测试 openGauss 节点（含一主一备） |
| P1 W5 前 | embedding 服务（OpenAI 兼容）；MinIO/S3 |
| P2 前 | 无硬依赖（知识库如需灌真实文档，届时提供文档来源即可） |
| 暂缓池解冻时 | 「能动手」→ SSH 账号策略；IM 审批 → 飞书/钉钉应用凭据；connection-auth 升级 → IdP |
| P3 前 | 图数据库选型；压测环境 |

## 4. 主要风险
P0 不确定点（备选已备）；dsh rc 升级（钉版 + conformance）；dsh Web UI 定制受限（seam 绕开/自研 slots）；上千节点连接数（连接池 + collector 独立池）；选型拖延（seam 留槽不阻塞）；单人带宽（每周可演示 + 门上裁剪）。

## 5. 度量
P0：接力 100%、回灌延迟 < 1s、PENDING=0；P1：100 节点巡检成功率 ≥ 99%、P95 < 3 min、杀 pod 零丢失、审批端到端 < 5s（实测 950 节点 P95=66s）；P2（重排版）：DDL 告警→报告延迟 < 15 min、常驻监控任务重启存活率 100%、知识检索命中可用；P3：2000 节点副本 ≤ 6、越权 0 通过、Host 切换无感。

## 6. 不在范围
MySQL 等非 PG 系数据库；k8s 内数据库（operator）；公有云 SaaS 化；移动端。

## 7. 插件地图（万物皆插件——每个节点的插件交付清单，2026-08-19 增补）

### 插件界定原则（CLAUDE.md 同步）
- 一切功能落为 cordis 插件；**任务类型 = 双半边插件**（server 半边注册 TaskType，client 半边 registerTaskPanel 注册专属大盘）。
- 领域 UI 面板独立成 client 插件；`ui-harness`（产品壳）与 `ui-opendb`（通用 RPC 通道）只做平台底座，不吸领域功能。
- seam（Definition）先行，provider 可替换：db/metrics/dictionary/tasks/approvals/memory/embeddings 均已成 seam。

### 已交付插件全量清单（2026-08-20 · 自研 51 包 + dsh 原样约 150 + 配置级改动约 10；dsh 源码零修改，钉版 rc.6）

**来源分类**：A=完全继承 dsh（原样加载）；B=继承 dsh 只改配置/禁用（patch 行，不改源码）；C=继承 dsh 的 seam（接口保留，Provider 自研）；D=全新开发（自有 seam 与功能）。

#### A · 完全继承 dsh（约 150 包，代表项）
| 代表包 | 作用 |
|---|---|
| cordis · cosmokit · schemastery | 插件内核框架、schema 校验 |
| dsh-agent-loop（Runtime 侧） | 真正的 agent 执行循环（Host 侧才换派发） |
| dsh-llm · llm-deepseek | 模型接入（DeepSeek 直连，key 走 Secret→env） |
| dsh-web-app 全套（30+ 包） | 控制台 UI：会话视图/工具树/设置页/schema 表单 |
| dsh-tools · dsh-skills · dsh-agent-presets | 工具注册表、技能注册表、预设机制 |
| dsh-permission-presets · dsh-subagents · plan-mode · compaction | 权限档、子代理、计划、上下文压缩 |

#### B · 继承 dsh、只改配置或禁用（patch 方式，约 10 行）
| dsh 行 | 改动 |
|---|---|
| webserver / connection | 端口 env 化；trust fence 加部署地址名单 |
| storage-domain | backend=pg + 低敏 domain（projcache/feedback）路由 redis |
| agent-loop(Host) · session-persistence-jsonl · storage-json · attachment-local · hmr · ui-workspace · directory-picker | 禁用，由 C/D 类插件替换 |

#### C · dsh seam 的自研 Provider（9 个）
| 插件 | 作用 |
|---|---|
| session-persistence-pg | 会话事件持久化 → PG（平台真相源基石） |
| agent-loop-dispatch ⭐ | Host 侧 agent 工厂槽位 → PG 队列派发（P0 核心架构件） |
| runtime-worker ⭐ | Runtime 侧领取/接力/心跳/stale 重放/NOTIFY 即时唤醒（P0 核心架构件） |
| storage-pg / storage-redis | dsh kv 存储 → PG / Redis 双后端 |
| attachment-s3 / spill-s3 | 附件、大文本溢出 → MinIO |
| directory-picker-agent | "选目录"语义改造为"选智能体" |
| agent-presets-pg | 预设落库：PG 真相物化到 dsh 原生 preset 目录 |

#### D · 全新开发（42 个）
| 域 | 插件 |
|---|---|
| 数据库能力与采集（7） | db（方言 seam+只读三防线）· db-opengauss（dbe_perf 诊断）· tool-db · metrics-timescale（hypertable+舰队聚合+7d 保留）· dictionary-pg（字典快照 diff）· collector（无 LLM 采集树，2001 节点 60s）· tool-metrics（含 metrics_fleet_overview） |
| 任务与审批（10，任务功能重做中逐个重审） | tasks（G1 契约+引擎：cron/CAS/催交/service 生命周期/leader 竞选）· approvals（报告签收）· tool-task-report · tool-task-admin（create/update/list/propose）· alert-ddl（水位告警器）· task-inspection · task-sql-audit · task-incident · task-monitor-dashboard（四个双半边任务类型）|
| 记忆与知识（9） | embeddings-openai-compat（Ollama+bge-m3）· memory-pg · memory-context（会话注入）· memory-ingest（报告自动入库）· tool-memory · memory-graph（实体共现图+两跳查询）· knowledge-pg（切块+pgvector）· tool-knowledge · knowledge-vector（Qdrant 加速层，pgvector 兜底） |
| 产品面 UI（8） | ui-opendb（/opendb RPC+管理段）· ui-harness（产品壳：侧栏/主区/task-resource-node 三面板桥）· ui-node-monitor · platform-status（资源大盘+HPA 指标路由）· ui-memory · ui-knowledge · onboarding · session-query-pg（会话全文检索） |
| 平台与基建（8） | registry（租户/agent/节点注册表）· tenant-context（RLS 越权用例）· instructions-pg（常驻指令注入）· host-notify-bridge（NOTIFY 总线+毫秒唤醒链）· tool-read-spill · skill-pg（四运维技能）· bundle-host/runtime/collector（三 profile 组合包） |

### 剩余节点 → 插件交付
| 节点 | 需开发插件 |
|---|---|
| W5.5·任务大盘 ✅ | task-inspection/client、task-sql-audit/client（双半边补全：registerTaskPanel 专属面板——findings 分组/severity 徽标/SQL 建议卡片） |
| W5.5·节点监控 ✅ | ui-node-monitor（先内聚 ui-opendb+ui-harness 交付 ✅，W6 拆独立 client 插件还债） |
| W5.5·资源大盘 ✅ | platform-status（Host：k8s 只读 RBAC + pod 拓扑 RPC + 模型 token 用量统计[今日/近7日/Top会话]；client 半边经 registerResourcePanel 进驻资源页；已完成 Job Pod 灰点标注） |
| W5.5·首开向导 ✅ | onboarding（client-only：零 agent 空态全屏欢迎页——命名默认智能体+可选纳管节点，复用 /opendb RPC，`#onboarding` 调试入口；空态判定失败 fail-safe 不挡人） |
| W6·扩缩 ✅ | KEDA ScaledObject（postgresql scaler 查队列深度，扩 2→5 缩回实测；runtime-worker maxConcurrent=2 防信号失真）；独立 og k8s 集群 950 节点验收通过（20 真 og-lite+930 别名，og-k8s VM） |
| W6·收口 ✅ | CI 门（.github/workflows/ci.yml：build+patch lint+dump-config PENDING 零容忍+PG 单测）；ui-node-monitor 拆包 ✅（registerNodePanel 桥）；UI 视觉第一轮 ✅（Sparkline 渐变/Empty 空态/数据库页 950 节点适配/侧栏限量/表格 hover）——后续微调随 user 反馈 |
| P2 W1（事件驱动） | **alert-ddl** · **task-incident**（双半边） |
| P2 W2（常驻监控+技能） | **task-monitor-dashboard**（双半边：runMode:'service' 首个实践）· **skill-pg** |
| P2 W3（知识与检索）✅ | knowledge-pg · tool-knowledge（实际交付名，代 knowledge-ingest）· ui-memory / ui-knowledge（双半边）· session-query-pg |
| P2 W4（平台面收尾） | **connection-auth**（简版）· **agent-presets-pg** · **storage-redis**（可选） |
| 暂缓池（user 决策先不做） | exec-ssh · tool-db-actions · token-issuer · preset-change-execution · tool-fs-search-ssh · db-postgres ｜ approval-im-feishu / -dingtalk ｜ mcp-db ｜ subagent-queue · workflow-sandbox-job |
| P3 判定项（2026-08-20 user 复议全落地） | host-notify-bridge ✅（opendbNotify 总线+58ms 唤醒链）· HPA-by-WS ✅（KEDA metrics-api）· storage-redis ✅（低敏域路由）· knowledge-vector ✅（Qdrant 加速层回退 pgvector）· agent-presets-pg ✅（PG 真相物化 .agent-presets）｜ metrics-victoria 维持跳过 |
| P3 ✅ | memory-graph ✅（PG 原生图）；knowledge-vector/metrics-victoria 判定不需要；host-notify-bridge 架构复核无消费场景；terminal-ssh/sandbox-job 随暂缓池 |
