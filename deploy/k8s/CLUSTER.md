# 测试集群：mac (192.168.128.1) 上的 OrbStack 4 台 VM + k3s

| 节点 | OrbStack 机器 | IP | 角色 |
|---|---|---|---|
| k8s-cp | ubuntu 24.04 arm64 | 192.168.139.164 | control-plane（k3s server v1.36.3+k3s1，traefik/coredns/local-path/metrics-server） |
| k8s-w1 | ubuntu 24.04 arm64 | 192.168.139.181 | worker（k3s agent） |
| k8s-w2 | ubuntu 24.04 arm64 | 192.168.139.40 | worker |
| k8s-w3 | ubuntu 24.04 arm64 | 192.168.139.41 | worker |

- kubeconfig：mac `~/.kube/config` 中 context `opendb-dsh`（备份：`~/.kube/config.bak.*`；原始文件 `~/.kube/opendb-dsh.yaml`）。
- 镜像 registry：mac 上 `docker run -d --name opendb-registry --restart=always -p 5050:5000 registry:2`；
  节点 `/etc/rancher/k3s/registries.yaml` 把 `host.orb.internal:5050` 配成 insecure http mirror。
  **不要用 5000 端口**：macOS AirPlay 接收器占用 5000，节点会拿到 403。
- 推送：`docker push localhost:5050/<image>`；Pod 引用：`host.orb.internal:5050/<image>`。
- 安装脚本：mac `~/opendb-k8s/{k3s-server.sh,k3s-agent.sh,k3s-registry.sh}`（`orb -m <node> sudo bash /Users/sqlrush/opendb-k8s/<script>`）。
- 重建节点：`orb delete k8s-w3 && orb create ubuntu:24.04 k8s-w3` → 跑 `k3s-agent.sh k8s-w3 192.168.139.164 <token>` → `k3s-registry.sh agent`。

## P0 部署形态（2026-08-17 已验证）
- 命名空间 `opendb-dsh`：`postgres-0`（StatefulSet，emptyDir）、`host`（Deployment ×1，NodePort 30080）、`runtime`（Deployment ×2）。
- 镜像 `host.orb.internal:5050/opendb-dsh:p0`（`scripts/k8s-p0.sh` 构建+推送+apply）；迭代期 `imagePullPolicy: Always`。
- Secret：`cp deploy/k8s/p0/secret.example.yaml deploy/k8s/p0/secret.yaml` 填 `DEEPSEEK_API_KEY`（git-ignored）。
- 访问：浏览器/脚本建议 `kubectl -n opendb-dsh port-forward svc/host 3081:3080` → `http://127.0.0.1:3081`；
  NodePort `http://<node-ip>:30080` 的 HTTP API 可用，但 **mux WebSocket 经 OrbStack/k3s NodePort 会滞后**（集群内完整），P1 起走 Ingress。
- 验收脚本：`scripts/e2e-p0-k8s.sh`（接力）、`OPENDB_HOST=127.0.0.1 OPENDB_HOST_PORT=3081 node scripts/ask-user-e2e.mjs` / `interrupt-e2e.mjs`。
- 排障脚本：`scripts/k8s/{k8s-state.sh,k8s-events.sh,k8s-int.sh,pgq.sh,ws-frames.mjs,ws-incluster.sh}`（原件在 mac `~/opendb-k8s/`）。

## P1 W1（2026-08-18 完成）
- Helm release `opendb-dsh`（chart `deploy/charts/opendb-dsh`）取代 P0 裸清单：postgres(PVC)/minio(PVC+bucket Job)/host/runtime 池/ingress(traefik `opendb.local`)/wait-for-pg。浏览器：mac `/etc/hosts` 加 `192.168.139.164 opendb.local` → http://opendb.local/。
- 数据面：`storage-pg`（workspace/投影缓存/评分 → PG `dsh_kv_*`）、`attachment-s3`、`spill-s3` + `read_spill` 工具、`tenant-context`（全表 tenant_id + RLS 不 FORCE）。Host/Runtime pod 零本地持久状态。
- 生产事故复盘：ROLLBACK 失败的连接带开事务回池 → 锁死 DDL 26 分钟。修复：`rollbackAndRelease`（坏连接销毁）、迁移 `lock_timeout=5s`+55P03 重试、DB 级 `idle_in_transaction_session_timeout=5min`。排障脚本 `~/opendb-k8s/pg-locks.sh`、`pg-kill-pid.sh`。

## P1 W2 批次1（2026-08-18 完成，零前端）
- `opendbRegistry`（迁移 003：tenants/users/agents/db_nodes/db_groups + RLS）、`directory-picker-agent`（官方 browse UI 的"添加工作区"= 创建 agent，目录 `$DSH_HOME/agents/<name>`）、`instructions-pg`（registry.instruction_doc → step1 authority 注入，version 变更重注入；按 cwd 提取 agent 名字查询）。
- 验收：host.createDirectory 建 agent → workspace.create 绑定 → 会话中模型遵循常驻指令（自称【og-lab 运维台】）。
- 注意：服务键 `registry` 与 Cordis 内核冲突 → 平台注册表键为 `opendbRegistry`。
- W2 批次2（待做，前端）：/opendb RPC 通道 + settings.section「OpenDB」管理页（esbuild classic-script bundle，`__ModuleLoader__.load` 包裹，external 十个共享模块）；`ui-agent-workspace` 美化侧栏。

## P1 W2 批次2（2026-08-18 完成，前端）
- `@opendb-dsh/ui-opendb`：宿主半 = `/opendb` RPC 通道（agents/list|update|setInstructions、nodes/list|create|assign，authority trusted-host）；浏览器半 = 设置页「OpenDB」管理段（agent 表格 + 常驻指令编辑 + 节点添加/绑定），esbuild classic-script bundle（banner/footer 包 `__ModuleLoader__.load`，external 十共享模块）。
- 验收：RPC 端点全通；bundle 进 `__DSH_BOOT__` 且 `/plugins/@opendb-dsh/ui-opendb/client.js` 200。
- 浏览器入口：http://opendb.local/ → 左下设置 → 「OpenDB」段。

## P1 W3 批次1（2026-08-18 完成，og 数据库能力）

- 前提验证（og5 = enmotech/opengauss-lite:5.0.3，mac 5433）：node pg 驱动 MD5 直连 ✅（og `password_encryption_type=1` + pg_hba md5）；平台账号 `opendb_ro`（MONADMIN + `ALTER USER ... SET default_transaction_read_only=on`）可读 dbe_perf.*，写被 25006 拒绝。og 容器内 gsql：`docker exec -u omm og5 sh -c 'LD_LIBRARY_PATH=/usr/local/opengauss/lib /usr/local/opengauss/bin/gsql -d postgres -c "..."'`。
- 新包：`@opendb-dsh/db`（`opendbDb` seam：每节点只读池，read-only 走 startup 包 `options: -c default_transaction_read_only=on`——og 接受，无 SET 竞态；方言注册表 + postgresql 基线）、`@opendb-dsh/db-opengauss`（8 条 dbe_perf 诊断查询，og5 实测 8/8）、`@opendb-dsh/tool-db`（db_nodes / db_query / db_overview；只读门=去注释+单语句+词表+危险函数表，**set_config 必须拦**——只读事务不阻止 set_config 改 transaction_read_only）。
- 凭据不落库：Secret `opendb-db-credentials`（key `credentials.json`，JSON `{"og5":{"username","password"}}`）→ runtime env `OPENDB_DB_CREDENTIALS`。轮换：og 上 `ALTER USER opendb_ro PASSWORD '...'` + 重建 secret + 重启 runtime。
- **helm 陷阱**：`--reuse-values` 不合并 chart 新增的 values 默认值 → 新模板引用新值时渲染为空报错；本 release 无用户自定义值，直接不带该参升级。
- 验收（`~/opendb-k8s/w3-accept.sh` / `w3-accept-ro.sh`）：og-lab 会话问 og5 会话数/版本 → 模型自主调 db_nodes→db_overview→db_query×2，答 12 会话 / openGauss-lite 5.0.3 ✅；要求执行 create table → 只读门拒绝 ✅。

## P1 W3 批次2（2026-08-18 完成，采集面）

- 新包：`metrics-timescale`（opendb_metrics hypertable；启动时单语句 CREATE EXTENSION + create_hypertable，无扩展回退普通表）、`dictionary-pg`（advisory-xact-lock 事务快照 diff）、`collector`（独立 runtime class，无 agent-loop：指标 60s / 字典 600s / prune 6h，首轮立即执行 → 重启 pod 即触发一次全量快照）、`tool-metrics`（metrics_recent / dict_changes）。
- **PG 换 timescale/timescaledb-ha:pg16（含 pgvector，W5 直接用）**：挂载点由 /var/lib/postgresql/data 改为 /home/postgres/pgdata（PGDATA=…/data），**旧 PVC 无需删除**——新路径为空目录自动 initdb；流程 = pg_dump → helm upgrade → 立刻 scale 0（wait-for-pg init 挡住新 pod）→ PG ready 后 psql 恢复 → scale 回。数据无损（agents/nodes/2622 事件、Host RPC、workspace 全正常）。dump 备份在 mac `~/opendb-k8s/dsh-dump-w3.sql`。
- 验收：opendb_metrics 22 指标持续写入且为 hypertable；字典 337 对象（139表+185索引+1视图+1函数+11序列，og5 实测精确吻合）；建表→added（表+隐式索引）、删表→removed 均检出；节点状态回写 online；chat e2e 模型调 db_nodes→metrics_recent→dict_changes 并以【og-lab 运维台】口吻答真实数据。
- 经验：og 视图 pg_views.definition 可为 null → 签名 md5 必须 coalesce；`kubectl exec -i psql < file.sql` 是绕 ssh/zsh 引号地狱的正解。

## P1 W3 批次3（2026-08-18 完成，scheduler）——W3 全部完成

- `@opendb-dsh/scheduler`（Host 内）：自写 5 字段 cron 解析（* , - / 步长、dom/dow either-match、7=周日），tick 30s；到点 CAS 更新 last_fired_at 防重 → 走 Host 自身 /api（workspace.list→session.create→session.prompt mode=queue）开新会话入队，下游与用户手发完全一致。trust fence 需 127.0.0.1:<port>（chart helper 已加）。
- 表 dsh_schedules（005 迁移，tenant+name 唯一，last_fired_at/last_session_id）。
- 验收：插入每分钟巡检 schedule → ~1min 内触发，新会话模型调 db_nodes→db_overview，最终回复【og-lab 运维台】给出真实健康总结（13 会话/0 等待锁/库大小）；测试行已清理。**注意：分钟级 cron 每次触发都烧模型 token，测试后必须 disable/删除。**

## P1 W4（2026-08-19 进行中，任务插件 + 审批）—— 事故复盘三连

**G1 契约已冻结**（设计 §8.5）：任务=可调度会话模板；报告经 task_report 工具（schemastery 校验+工具循环重试）；审批=P1 报告签收（report-ack）；dsh_schedules 收编为 prompt 任务类型（scheduler 包删除）。新包：tasks / approvals / task-inspection / task-sql-audit / tool-task-report / tool-read-spill。

**事故 1：僵尸连接持 session 级 advisory lock 拖死全平台 32 分钟。**
被杀 pod 的半开 TCP 连接在 PG 侧存活（state=idle，query 停在 002 迁移），session 级 pg_advisory_lock 永不释放 → 六个服务的 runMigrations 全部排队 → 所有 `await ready` 的 RPC 挂死。修复三层：① runMigrations 改 **pg_advisory_xact_lock**（每文件一个事务，连接死/回滚即放锁），SET LOCAL lock_timeout 提前到拿锁前（等锁也有界）；② PG args `idle_in_transaction_session_timeout=5min`（能杀挂死的持锁事务）；③ `tcp_keepalives_idle=60/interval=10/count=6`（10 分钟清半开连接）。**教训：换 PG 镜像时 W1 在旧库设的会话级防线全部丢失——DB 级参数必须进 chart，不能手工 ALTER。**

**事故 2：runNow 在 RPC 上下文内同步自调用 /api 死锁。**
「立即运行」的 RPC handler 里同步 fetch Host 自身 /api（workspace.list/session.create）→ 与请求处理串行化互等，挂满 curl 超时；cron tick 路径（非 RPC 上下文）从来正常。修复：runNow 只 INSERT queued run 秒回，引擎 tick 异步拾取 fire。**教训：凡是"经 Host /api 开会话"的动作绝不能在 RPC handler 里同步做。**

**事故 3：Service 构造器内 anyCtx.inject(['tools']) 注册的工具从未生效。**
task_report（W4）与 read_spill（W1 起！）都用了 spill-s3 首创的"构造器内 inject(['tools'])"模式——模型工具列表里从未出现过这两个工具，静默失败无报错。改成独立 function plugin（tool-db 的已验证模式：顶层 export inject + apply 内 ctx.effect 注册）后错误反而显形：task_report 的 data 参数缺 `additionalProperties: true|false`（defineTool 强制），Runtime boot 崩溃循环 5 次——补上即好。**教训：① 工具注册一律用 function plugin 顶层 inject；② defineTool 的 object 参数必须显式 additionalProperties；③ "静默不生效"比"崩溃"更危险，read_spill 失效两天无人知。**

**辅修**：任务默认超时 10→20 分钟（巡检会话实测 15-25 分钟，deepseek 出现过 15 分钟无输出空洞）；fire 时重置 fired_at=实际开跑（排队不计超时）；task_report 接受 timeout 后迟到报告（救回 succeeded）；快速链路验收法——用 prompt 任务"立即调用 task_report"1 分钟验完整链路，与耗时的巡检内容验收解耦。

**W4 核心链路验收 ✅（2026-08-19）**：`w4-fast.sh` 快任务全链路——tasks/create → runNow 入队秒回 → 引擎 tick 拾取开会话 → 模型调 task_report（severity=ok）→ 报告落库 run=succeeded → 引擎自动建 report-ack 审批单 → RPC 签收（decided_by=console + 意见）→ 重复决定被 CAS 拒（"已是 approved，不能重复决定"）。真实类型（inspection/sql-audit）报告验收在途（`w4-types.sh`）。**新欠账：runtime-worker 的 stale 回收对"死 pod 已认领未开跑"的 queue 行不生效**（P0 只验证了跑到一半的接力），本次手工重置 admitted_by 解决；W6 收口时修。

**W4 真实类型验收 ✅（2026-08-19）**：inspection → severity=ok「会话/锁/连接/指标均无异常」findings=6（含 level=ok 检查记录，reportSchema 全合规）；sql-audit → severity=ok，正确识别 Top 8 全为平台采集器自身查询并按提示词规则跳过（"平台内部管控语句不审"被遵守），findings=1。两单 report-ack 均自动生成；巡检单已签收，SQL 审核单留 pending 供 user 在浏览器审批箱体验。W4 全部收口。

## P1 W5（2026-08-18/19 完成核心，记忆与知识）

- 新组件：chart `ollama.yaml`（Ollama 0.6.8 + PVC + pull Job bge-m3，OLLAMA_KEEP_ALIVE=24h 常驻）、`embeddings-openai-compat`（opendbEmbeddings seam，实测集群内 /v1/embeddings 返回 1024 维）、迁移 007（opendb_memories + pgvector hnsw cosine 索引；embedding 可空=文本真相优先）、`memory-pg`（write/search 向量→ILIKE 回退/recent/hasSource）、`memory-ingest`（Host 扫描报告→kind=report 记忆，source=report:<runId> 幂等）、`memory-context`（Runtime agent/pre-step 注入 recent+语义检索记忆，字节上限）、`tool-memory`（memory_search/memory_save，function plugin 模式）。
- **验收全过**：3 份任务报告自动入记忆（embedding 全部生成）；新会话问「上次巡检结论」→ 模型答「根据平台记忆库（2026-08-18 的两条巡检记录）…」引用真实结论，**0 次数据库工具调用**（未重新巡检）——P1 目标「次日对话能引用昨日巡检结论」达成；memory_save 存偏好 → 新会话准确回忆（含日期）。
- 事故复盘补充：迁移锁滞留再现一次，持锁者是 **rollout 被杀旧 pod 的半开连接**（idle in transaction 3:56，5 分钟自动杀线将至，手动提前清）；xact 锁 + idle_in_transaction 超时防线按预期工作，只是清理有分钟级延迟——属可接受行为。注意 chart 的 tcp_keepalives args 对 TCP 连接是否真实生效未验证（psql unix socket 显示 0 属正常）。
- 计划调整：批次 3 的 KEDA 并入 W6（与「100 节点/5 agent 排程」规模验收强相关，当前单节点无真负载可验）。
- 已知小坑：JS 稀疏数组 `new Array(n).some()` 跳过空槽（embeddings index 连续性检查踩过）。

## W5.5 批次1（2026-08-19 完成，opendb-harness 产品壳）

- 产品定案（user）：更名 opendb-harness（仓库不改）；保留逻辑 agent（default agent 首开命名，特殊需求才新建：节点/插件技能/默认模型）；侧栏=agent 切换器+四资源列表（会话/任务/数据库/资源）；任务主要从会话衍生（task_propose，批次4）。
- 新包 `ui-harness`（client-only）：**替换 sidebar.workspaces hole**（官方 ui-workspace disabled；register 声明 directoryFlow 子槽 kind:single scope:root）——品牌行/agent 切换器（≤1 个时低调显示）/四导航（任务角标=pending 审批、数据库角标=offline 节点）/最近会话列表（点击 ctx.sessions.open）/新会话（workspaces/find→ctx.workspaces.startSession）/新建 agent（agents/create RPC+ctx.workspaces.create）。`shell.overlay` 全屏页：任务（列表/历史/审批箱）/数据库（节点卡片）/资源（占位，批次3 实时化）。两组件经模块级外部 store 通信（useSyncExternalStore）。
- 新 RPC：agents/create（含 mkdir agents 目录）、workspaces/find（**workspace 注册表就在 storage-pg kv：dsh_kv_records unit='workspace' tbl='workspaces'，value.path/sessionIds**——Host 直查 PG 零死锁）、sessions/list（归属真相=workspace kv 的 sessionIds；**持久化 request/header 只含 tools 没有 cwd**，不能用 cwd 过滤——坑）。
- client API 侦察成果：ctx.sessions.open(id) 开既有会话；ctx.workspaces.startSession(wsId)/create(input)；sidebar.workspaces 是独占 hole 不可叠加。
- 验收：__DSH_BOOT__ 含 ui-harness；client.js 200/27.9KB；agents/list、workspaces/find→og-lab wsId、sessions/list→3 会话带标题 ✅。浏览器渲染待 user 确认。

## W5.5 交互修订（2026-08-19，user 四点反馈全落地）

- **主区内渲染**：任务/数据库/资源页不再全屏 overlay——容器 `left = 侧栏右缘`（侧栏组件 ResizeObserver 实时上报 store.sidebarRight），侧栏始终可见可切换。
- **品牌接管**：document.title + 左上角官方字标（ui-sidebar 的 logoRow/Wordmark 无插槽）DOM 接管为 opendb-harness（500ms×20 次重试后停）。
- **新建 agent 下拉化**（低频操作不占常驻 UI）：agent 行点击展开下拉（agent 列表 + 底部"＋新建 agent…"内联表单）。
- **DB 图标**：emoji → currentColor 圆柱 SVG。
- **任务面板插槽契约（user 定案：不同任务对应不同插件，UI 统一进主区）**：`registerTaskPanel(typeKey, Panel)`（ui-harness 导出）；任务页=列表+详情框架，选中任务渲染 `getTaskPanel(type) ?? DefaultTaskPanel`（默认=运行历史+报告+操作）。未来任务类型插件的 client 半边注册专属面板即可进驻，零框架改动。
- 访问方式定案：**IP 直连 http://192.168.139.164/**（user 弃域名；ingress 无 host 兜底规则 + fence 信任 IP）。.local/mDNS 域名坑记录在案。

## 环境事故复盘：mac 合盖睡眠 = 集群网络"退化"元凶（2026-08-19）

**症状**（全天间歇出现）：kubectl 偶发 "no route to host"；HTTP 小请求通但大文件在 32KB 处卡死；traefik 收请求 0 字节不响应；页面资产拉不下来（浏览器"页面出不来"）。
**根因**：宿主 MacBook 合盖睡眠（Clamshell Sleep，电池供电）→ OrbStack 共享内核 VM 被冻结（machines 的 uptime 会一起归零，因为所有 machine 共享一个内核）→ 唤醒后虚拟网络处于坏状态且**不自愈**。`pmset -g log | grep -E "Entering Sleep|Wake from"` 可对时间线。caffeinate 拦不住合盖睡眠。
**排障口诀**：集群网络发疯 → 先 `pmset -g log` 看是不是刚睡醒 → 是则 `orb restart k8s-cp k8s-w1 k8s-w2 k8s-w3` + `kubectl -n kube-system rollout restart deploy/traefik`。
**预防**：实验期间插电 + 不合盖（或设置"接通电源时显示器关闭不睡眠"）。
**顺带记录**：OrbStack 出站流量走本机代理 127.0.0.1:1082（vmgr 日志可见）——拉镜像慢/失败时检查该代理状态。mac 上另有 pgracbench 两台重型 VM 常驻（与 k8s 集群共享虚拟化资源）。

## 网络战役完整复盘（2026-08-19，"页面出不来"三层根因全歼）

**根因链（由表及里）**：
1. mac 合盖睡眠 + Wi-Fi→iPhone 热点切换 → OrbStack 的 192.168.139.0/24 路由被热点网关(172.20.10.1)挤掉 → mac→VM v4 直连全断；
2. 更深一层：睡眠唤醒后 OrbStack 虚拟交换层 **VM 间 UDP 40% 随机丢包**（各尺寸均 3/5；ICMP 0% 丢、TCP 靠重传能活）→ flannel **vxlan（UDP:8472 封装）跨节点瘫痪**：同节点 pod 744KB 秒传、跨节点 48KB 卡死 → 前端大资产拉不下来 =「页面出不来」；traefik 连接坏态是并发症；
3. 另有独立 bug：build14 用 innerHTML 换 logo 破坏 React DOM 致整页崩溃（已改纯 CSS + ErrorBoundary 加固）。

**根治**：
- **flannel vxlan → host-gw**（`/etc/rancher/k3s/config.yaml: flannel-backend: host-gw` + 重启 k3s/k3s-agent×3；四节点同 L2 满足条件）：pod 跨节点改纯路由（`10.42.x.0/24 via 192.168.139.x`），TCP 直达自带重传，永久免疫 UDP 丢包。效果：跨节点 744KB 0.21s×3 ✅。
- **访问路径 = socat-over-orb**（orb exec 走 vsock 不走 TCP/IP，对一切网络折腾免疫）：mac 上
  `socat TCP4-LISTEN:18080,fork,reuseaddr,bind=127.0.0.1 EXEC:'orb -m k8s-cp socat - TCP4:127.0.0.1:80'`（v6 同理 bind=[::1]）→ 浏览器 **http://localhost:18080/**。注意 8080 被 OrbStack 内 Cloud CLI Proxy 容器占用（Chrome 经 ::1 撞上过）。fence 已加白 localhost:18080/127.0.0.1:18080。
- kubectl 稳定化：`kubectl config set-cluster opendb-dsh --server=https://k8s-cp.orb.local:6443`（orb.local=v6 且由 OrbStack resolver 保证）；注意 OrbStack 重启会把 current-context 切到内置 `orbstack`，用 `kubectl config use-context opendb-dsh` 切回。
- 诊断方法论：分层采样（mac→ingress / 节点内 traefik / 跨节点 pod / 同节点 pod / 裸 TCP / UDP echo / ICMP-DF）+ **UI 改动必须 headless Chrome 自验**（puppeteer-core 连 --remote-debugging-port，DCL 超时时用请求追踪找挂住的资源；截图 Read 亲眼看——本次靠它发现端口冲突渲染了别人的页面）。

## W5.5 分区树 + 两项重要沉淀（2026-08-19）

- **侧栏定形（user 定案）**：会话/任务/数据库三分区各挂子列表（dsh 原版树形态）——会话不断新增、任务不断添加（监控大盘/SQL 审核…）、数据库挂节点；点分区头开总览、点条目直达（任务→详情面板，节点→数据库页选中）。自验+截图确认，零 JS 错误。
- **UI 热更新通道（提速 30 倍）**：client bundle 是 dsh **每请求读盘**的 —— `kubectl cp packages/ui-harness/lib/client.js <host-pod>:/app/packages/ui-harness/lib/client.js -c host` 即时生效，UI 迭代从 5 分钟镜像重建降到 10 秒。仅前端改动时使用；host/runtime 代码仍需镜像。
- **workspace sessionIds 覆盖事故**：某次 PG 不可达窗口 host 重启，workspace 服务疑似以空状态启动后回写覆盖 kv（`dsh_kv_records unit='workspace'` 的 sessionIds 只剩 1 条；会话事件数据无损）。恢复：从 dsh_session_events 重建数组（SQL 见 git log fixws）。**欠账（W6）**：排查 storage-pg loadAll 失败路径是否被吞（应让服务启动失败而非以空态运行）。

## 交互纲领落地（2026-08-19，设计 §15）

- **tool-task-admin**（Runtime）：task_create / task_update / task_list——会话即任务管理。e2e：一句话「把巡检改成每天 7 点+需签收；再建每天 18 点的 og5 SQL 审核扫 top10」→ 模型 task_list→task_update(0 7 * * *)→task_create(0 18 * * *, topN10)→复核，全对。
- **任务大盘去按钮化**：DefaultTaskPanel 移除立即运行/启停按钮，提示「调整任务直接在会话里说」；审批签收控件保留（人类监督例外）。
- **侧栏单滚动**：会话列表限 12 条+「显示全部 N 条」展开，任务/数据库/资源恒可见。
- **新建智能体弹页**（稀缺弹页场景）：全窗覆盖设置页风格——名称/管理数据库多选/插件技能清单（MVP 全量挂载）/模型下拉；提交= agents/create+nodes/assign+agents/update(model)+workspace 创建。截图自验通过。
- 常驻任务现状：og5手动巡检（每天 07:00）、og5每日SQL审核（每天 18:00）——每天各消耗一次任务会话 token，属预期生产节奏。

## 双半边任务插件首践 ✅（2026-08-19）

- task-inspection/client + task-sql-audit/client：任务类型插件补齐 client 半边（dsh.client 声明 + esbuild bundle + host 重启被 client-modules 扫描）。面板经 **window 桥**（`window.__opendbHarness__.registerTaskPanel`）注册——跨 client 插件共享注册表，与加载顺序无关（250ms×40 轮询兜底）。
- 面板遵守纲领：纯展示无按钮。巡检=severity 徽标+findings 按节点分组+近10次运行时间线；SQL审核=SQL 代码块+问题/建议/依据卡片。
- 行为自验：两面板渲染断言全过、默认视图已被专属面板替换、零 JS 错误。

## 2026-08-19 platform-status / onboarding 交付备忘
- **client bundle 验证 URL 是 `/plugins/<pkg>/client.js?rev=`**（从首页 `__DSH_BOOT__.entries` 读），
  `/modules/...` 是 SPA fallback——返回的是 index.html，`curl` 看似 200 实为假阳性。
- esbuild 产物默认把非 ASCII 转义成 `\uXXXX`，grep 中文验证 bundle 内容会误报缺失；用 ASCII 关键字。
- platform-status 的 k8s 访问：chart `templates/rbac.yaml`（SA `opendb-dsh-host` + Role pods get/list + RoleBinding），
  host deployment `serviceAccountName`。Helm release 在 **namespace `opendb-dsh`**、无 values 文件（直接 chart values.yaml），
  `helm upgrade opendb-dsh deploy/charts/opendb-dsh -n opendb-dsh`。
- runtime deployment 名是 `opendb-dsh-runtime-default` / `-collector`（没有裸 `opendb-dsh-runtime`）。
- mac 无头 Chrome（9333 端口）会随睡眠/重启消失，跑 puppeteer 前先 `curl 127.0.0.1:9333/json/version` 探活，
  掉了就 `--headless=new --remote-debugging-port=9333 --user-data-dir=/tmp/chrome-odb` 重拉；
  新 profile 首次打开 dsh 会弹「内测声明」，脚本先点「继续」再断言。

## 2026-08-19 sessionIds 裁光事故根治（W6，根因修正版）
- **真实根因不是 storage-pg 吞错**（loadAll/list 全硬抛，dsh 域层也不吞）：host pod 无卷 →
  `/var/lib/dsh/agents/<name>` 目录随重启消失 → dsh workspace 启动 indexHeader 对 header.cwd 做
  realpath+stat 校验失败 → 全部历史会话进 invalidSessionPaths → **dsh 的 mutate() 每次写都按
  cwd 索引过滤 sessionIds**（dsh-workspace lib mutate 内 filter）→ 重启后第一次 attach/改名等
  mutate 就把裁剪结果持久化。「PG 不可达」只是当日巧合时间线。
- 根治：① chart host 挂 `agents-dir` PVC（RWO + **strategy: Recreate** 防滚动抢卷；SSA 从
  RollingUpdate 切换需先 kubectl patch 删 rollingUpdate 字段）② ui-opendb 启动幂等重建全部
  agent 目录（兜底 PVC 丢失）③ 修复脚本 `deploy/k8s/repair-workspace-sessionids.sql`
  （从 dsh_sessions.header.cwd 反推归属；**跑完必须立刻重启 host**，否则内存旧记录下次 mutate 覆盖回去）。
- 回归证据：修复+重启后 session.create（workspaceId og-lab）→ sessionIds 24→25 追加不裁剪。
- Host /api 直调格式：POST /api/<method>，body `{"type":"client-request","rpcId":"...","method":"...","payload":{...}}`（还需 origin 头过 fence）。

## 2026-08-19 W6 韧性 e2e 全绿
- `deploy/k8s/e2e/kill-pod-resilience.sh`：mid-turn（首条 assistant 消息落地瞬间）杀认领 pod →
  继任 pod 经 markStale 重放队列行接力 → turn 闭合、7 条消息完整。PASS。
- markStale 修复（同事务把死 pod 在途 queued 行取消 admit）单测 4/4 + 本 e2e 实战双验证。
- 注意 v4-flash 速度：三步任务 ~10s 就跑完，e2e 里固定延时杀会错过 mid-turn，必须事件驱动定杀点。
- collector 杀无需专测（重启即全量快照是设计行为）；host 单副本重启=UI 重连（P3 才做多副本）。

## 2026-08-19 W6 KEDA 扩缩上线（实测通过）
- keda operator 装在 `keda` ns；chart `templates/keda.yaml`：Secret(连接串**必须全限定** `svc.<ns>.svc`，
  operator 跨 ns 解析) + TriggerAuthentication + 每个带 `autoscale` 的 runtime class 一个 ScaledObject
  （postgresql scaler 直查该 class 待认领队列深度，target=每 pod 2 条；autoscale 时 helm 不回写 replicas）。
- **关键发现：runtime-worker 原来无并发上限**——每 tick 认领一条且并行跑，2 pod 十秒吸干 12 条队列，
  深度归零 → KEDA 信号失真。已加 `maxConcurrent`（默认 2，env OPENDB_MAX_CONCURRENT）。
- 实测：12 条排队 → 副本 2→4→5（10s 级响应），队列 20s 清空；缩容走 HPA 稳定窗口（~5min）回 min=2。

## 2026-08-19 W6 规模验收通过（950 节点 / 5 agent，超额完成 100 节点目标）
- **环境**：独立 og-k8s 集群（user 定案与平台分离；OrbStack VM 192.168.139.207，单节点 k3s）：
  og-node StatefulSet×20（enmotech/opengauss-lite:5.0.3，NodePort 30001-30020）+ 930 逻辑别名轮转指向
  = 950 节点（og5 加入共 951）。凭据：db 包 '*' 缺省回退 + secret 通配条目，20 实例同一 opendb_ro。
- **数据**：采集 951/951 覆盖率 100%，60s 周期零滑期（每轮 ~20k 行指标）；collector 55m CPU/89Mi；
  舰队巡检 5/5 succeeded，单任务 22-66s（P95=66s，标准 <3min）；KEDA 扩容 2→5 实测、缩回 min。
- **舰队巡检模式**：>10 节点自动切聚合 prompt——metrics_fleet_overview（一条 SQL 聚合 950 节点：
  覆盖率/每指标 min-avg-max/异常 Top-N/无数据名单）→ 模型只钻取可疑 ≤5 个 → fleet 级 findings。
- **事故与根治（复盘修正版）**：认证失败/覆盖率崩盘的唯一根因是
  **og-lite 1Gi limit 在 ~47 路采集连接/实例下 OOMKilled，且无卷 pod 重启即 initdb 连账号一起抹掉**
  （OOM 10:25Z 早于第一轮巡检 10:5x；14/20 账号消失）→ 2Gi limit + volumeClaimTemplates 持久卷
  + failed_login_attempts=0（实验环境）。
  ⚠️ 初判「镜像漏编 db 包」是**错误定性**：Dockerfile build 阶段本就全量 pnpm build（证据：
  10:33 collector 951/951 全覆盖，无 '*' 回退不可能）。build-image.sh 保留作双保险，
  但记住：**复盘先对时间线，再下结论**——OOM 时间戳 vs 巡检时间戳一对就穿帮。
- og 手册：账号建立 `su - omm -c "LD_LIBRARY_PATH=... gsql -c ..."`；og 节点名禁连字符（GS_NODENAME 固定值）；
  psql16 对 og 报 "unsupported frontend protocol 3.9999" 是客户端协商噪音，node pg 驱动正常。
- 排程：5 舰队巡检 cron 0 8 * * *（与 og5 巡检 07:00/审核 18:00 并存）。

## 2026-08-19 P2 W1 事件驱动运维上线（告警→诊断→报告→签收全闭环实测）
- **alert-ddl**：60s 水位扫描 opendb_dict_changes → 按节点归属 agent 分组 → 触发 incident 任务
  （trigger_kind='event'，G1 契约预留值）；agent 无 incident 任务时自举创建（requires_approval=true）；
  冷却 15min + queued/running 判重；水位表 opendb_alert_state（首装水位=now，存量不告警）。
- **task-incident** 双半边：诊断 prompt（dict_changes→可疑判定→影响追查→报告，动作只建议不执行）+
  事故面板（severity 徽标/根因推测卡/按节点 findings/建议动作清单/近10次触发时间线）。
- **引擎补救机制**：turn 全闭合无报告 → 先催交一次（error 字段做标记）→ 仍不交才 failed。
  turn 闭合判定=start/end 计数相抵（EXISTS turn/end 会在催交回合进行中误判——踩过）。
  实测：首轮 2/5 未交报告，催交后重跑 2/2 补交成功，日志有 reminder sent 实锤。
- **演练全链路**：og-real-006 建表+索引 → collector 重启即快照检出（别名回声：1 物理实例=47 逻辑节点，
  5 agent 全触发，真实环境无此现象）→ 5 份诊断报告全 ok（模型自己识破"演练脚本特征：每 20 节点一组
  间隔 10-16s 批量执行"，甚至点破"多逻辑节点映射同一物理实例导致重复上报"）→ 5 张签收单自动补建。
- 教训：psql 里带反斜杠的嵌套引号在 zsh heredoc 三层转义下极易碎——复杂查询写 .sql 文件再 `psql < file`。

## 2026-08-19 P2 W2 上线：runMode:'service' 落地 + 常驻监控大盘 + 技能包
- **service 契约（G1 预留位落地，全部 additive）**：TaskType.runMode 扩 'service' + startService(task,ctx)→stop；
  引擎每 tick reconcile（缺启/多停/指纹变更重启；指纹=name+config+timeoutMs）；Host 重启首轮 tick
  自动拉起（跨重启存活实证）；停机 stopAllServices；session 触发路径对 service 型直接拒绝。
- **task-monitor-dashboard**：60s 阈值快照（fleetOverview 聚合→连接率/等待锁/覆盖率判定）写自有表
  opendb_monitor_snapshots（48h 保留）；client 经自有 /opendb-monitor 通道渲染实时大盘
  （状态大牌/水位条带阈值刻度/24h 色带/异常榜）。
- **两个实测事故**：① SQL 直插任务 config={} 未过 schema → intervalSeconds=undefined →
  **setInterval(fn, NaN)=毫秒级循环**，1 分钟 1.8 万行快照——修复=引擎 reconcile 统一
  configSchema 规范化 + 插件侧 Number()||60 双保险；② dsh runtime skill 注册端 validateRuntimeSkill
  不校验 source，模型 invoke 加载时才报 "source must be a string"——**注册 skill 必须带 source:'runtime'**。
- **skill-pg**：四技能（og-slow-query-triage / og-lock-diagnosis / og-capacity-review /
  og-ddl-change-audit），e2e：模型加载 og-lock-diagnosis 严格按路径三步执行+补充判读要点核查，
  且能正确区分任务会话/普通会话（不乱交 task_report）。

## 2026-08-19 P2 W3 上线：知识与检索
- **knowledge-pg**（opendbKnowledge seam）：008 迁移（docs+chunks，vector(1024) hnsw，source 唯一幂等）；
  chunkText 段落聚合切块（~800 字符+100 重叠）；ingest 批量 embed 尽力而为（失败落 NULL 回退 ILIKE）；
  agent_id 空=全局知识。**知识 vs 记忆分界：知识=外部资料，记忆=平台自身经历。**
- **tool-knowledge**：knowledge_search / knowledge_ingest（会话灌入是主路径——纲领 §15）。
  e2e：会话粘贴备份规程→模型 ingest（标题/来源/全局全对）→新会话检索精确引用（gs_basebackup 命令、
  周日 02:00、PITR 目标点全命中）。
- **ui-knowledge / ui-memory**：设置页新增「知识库」「记忆」两段（settings.section order 61/62），
  双半边自有通道 /opendb-knowledge、/opendb-memory；memory-pg 补 list/remove（additive）。
- **session-query-pg**：/opendb-sessions search——ILIKE 扫 user/assistant 消息文本按会话聚合
  （命中数/标题/首条摘录）；侧栏搜索框 ≥2 字符 400ms 防抖出「内容命中」区（标题过滤之外的正文检索）。
  MVP ILIKE 够用（万级事件毫秒级），P3 数据量大再上 pg_trgm。
- puppeteer 经验：dsh 设置入口/段切换要**真实鼠标坐标点击**（getBoundingClientRect→mouse.click），
  evaluate 里 el.click() 对官方 React 组件常不生效；文本断言防假阳性（侧栏摘录会包含目标关键词）。

## 2026-08-19 P2 W4 上线：控制台登录（P2 全周期收官）
- **connection-auth 简版 = traefik basicAuth**：chart `auth.enabled` → Secret+Middleware+ingress 注解，
  护住全部入口（域名/IP 直连/socat 18080）。凭据：账号 opendb，明文在 mac `~/opendb-k8s/console-password.txt`、
  htpasswd 在 `console-htpasswd.txt`（helm --set-string 注入，均不进 git）。三态实测 401/401/200。
  内部自调（tasks 引擎 127.0.0.1）不经 ingress 不受影响。token/IdP 完整版在暂缓池。
- **工具链适配**：e2e 脚本 curl 统一 `-u`（读密码文件，缺文件裸连兼容）；puppeteer 用
  **URL 内嵌凭据** `http://opendb:PW@localhost:18080/`（p.authenticate/setExtraHTTPHeaders 均会挂，
  别再试）。⚠️ 三种认证法连环超时时先怀疑 **Chrome 僵死**（本次实为 Chrome 假死误导 40 分钟）——
  probe 本地导航 10s 不回就 pkill 重拉，别急着换认证姿势。
- **顺延判定（诚实工程）**：agent-presets-pg——dsh preset 机制强绑文件目录树（preset root 逃逸校验），
  做 PG provider 复杂度高而单租户收益≈0，ConfigMap 方案已可版本管理 → 顺延暂缓池；
  storage-redis——950 节点规模下 PG kv 无瓶颈实证 → 顺延；UI 视觉第二轮等 user 反馈驱动。

## 2026-08-19/20 P3 全项收官（规模与多租户）
- **Host 水平扩 ✅**：3 副本 + traefik sticky cookie（Service annotation）+ 引擎/告警器/图抽取器
  **session 级 advisory lock leader 竞选**（专用连接跨 tick 持有 + SELECT 1 保活 + 优雅停机 unlock；
  ⚠ xact 级锁只互斥不固定 leader——实测两副本轮流 start service 快照双份）。
  实测：杀 leader **6 秒接管**、切换期间控制台 200、快照流不断。agents-dir 改 emptyDir+initContainer
  每副本重建（RWO PVC 与多副本不兼容；SSA 字段所有权冲突时删 deployment 重建）+ ui-opendb 60s 周期 reconcile。
- **2000 节点 ✅**：2001/2001 采集覆盖率 100%、60s 零滑期（collector 5m CPU/118Mi——余量巨大）；
  舰队巡检 5/5 ok，P95=91s；opendb_metrics 7 天保留策略。稳态 runtime 2 副本/峰值 5（KEDA），
  验收「4-6 副本稳态」按实测重解释：本负载画像下 2 副本即稳态，扩缩弹性已验。
- **多租户 ✅**：009 动态 FORCE RLS（16 张 tenant_id 表 + WITH CHECK）+ createPool 连接级
  app.tenant 注入（env OPENDB_TENANT）+ 配额表与三创建口检查 + 越权用例 3/3 绿。
  ⚠ **superuser 无条件绕过 RLS（FORCE 也不拦）**——用例用非特权探针角色验证策略；
  **多租户生产部署检查单：平台必须以非超级角色连 PG**（当前 lab 单租户 superuser 可接受）。
  ⚠ 运维 psql 现在要 `SET app.tenant='default';` 才能看到业务表数据。
- **memory-graph ✅（G3=PG 原生做图）**：010 边表（记忆↔实体，实体=内容中出现的节点/agent 名）
  + 水位增量抽取（leader 单实例）+ memory_graph 工具（直接记忆+经共现实体两跳桥接）。
  e2e：模型查 og-sim-586 事件链，直接 7 条+两跳 8 条。
- **判定入档**：knowledge-vector 不需要（pgvector 实证够用）；metrics-victoria 不需要（Timescale+
  retention 够用）；terminal-ssh / code-runtime-sandbox-job 与「能动手」共享 SSH/执行前提 → 随暂缓池；
  HPA-by-WS 以固定 3 副本满足验收；LISTEN/NOTIFY 以 2s poll 满足（队列唤醒延迟无感）。

## 2026-08-20 盘点更正：preset ConfigMap 从未落地
- W5 roadmap 里的「preset ConfigMap」是计划名词，实际未做（盘点时误记为已有）。真实现状：
  预设 = dsh 内置 standard（镜像内 @deepseek-ai/dsh-agent-presets 包），零自定义；
  用户自定义 root 是 `$DSH_HOME/.agent-presets`（pod 内 /var/lib/dsh/.agent-presets，实测不存在）。
  将来要自定义预设：ConfigMap 挂到该路径（host 现为 emptyDir，直接写会随重启丢）。

## 2026-08-20 判定项全量落地（user 复议：除 metrics-victoria 全部实现）
- **host-notify-bridge + LISTEN/NOTIFY ✅（合一）**：opendbNotify 总线（专用 LISTEN 连接+断线重连+
  懒挂频道+at-most-once 语义）；两条唤醒链——thread 入队→worker 即时领取（**实测 58ms**，原 poll
  均值 1s/最差 2s）、task runNow→引擎即时 tick（原最差 30s）。poll 保底全保留。
- **HPA-by-WS ✅**：platform-status 裸指标路由 /opendb/metrics.json（node getConnections）+
  host KEDA metrics-api ScaledObject（min3/max6/target50，缩容 600s 稳窗护 sticky）。SO Ready+Active。
- **storage-redis ✅**：Redis kv backend（hash per table + AOF + PVC）；storage-domain routes 把
  session_projcache/message_feedback 路由 redis（可重建低敏域）；**workspace 铁定留 pg**。
  实测两 unit version 键落 Redis、平台无恙。坑：build-image.sh 输出接 `| tail` 会吃掉退出码——
  验证构建成功要看 `image built & pushed` 行或单独 echo rc。
- **knowledge-vector ✅**：Qdrant v1.12（chart 部署+PVC）+ 加速层服务（60s 全量对账同步含删除、
  chunk id→UUID 映射、agent 过滤）+ knowledge-pg 检索接入（ready 优先 Qdrant，任何故障回退
  pgvector——**PG chunks 永远是唯一真相**）。实测 points_count 与 chunks 一致。
- **agent-presets-pg ✅**：011 表为真相 → 60s 物化到 $DSH_HOME/.agent-presets（dsh 原生 user root，
  机制零改动）；删除对账只清带 .managed-by-opendb 标记的目录；/opendb-presets 管理通道。
  实测：INSERT→70s 内两副本各自物化；DELETE→目录清除。psql 种子数据仍要走 .sql 文件（引号地狱口诀）。
- metrics-victoria 维持跳过（user 指定例外）。

## 2026-08-20 缺口清单补完（user 指令：除 UI 二轮全部补）
- **task_propose ✅**：提案→ask_user 确认→task_update 启用的显式环（草案=enabled:false 真实任务，面板可见）。
- **conformance 两小件 ✅**：scripts/ci/conformance-boot.mjs——dsh-app-boot 编程式 boot（真实 Loader）
  + assertEntriesActivated，三 profile 全过并入 CI（第七道门）。坑：profiles 的 cordis.yml 是 dsh 启动期
  合成的，脚本先经 dump-config 生成；外设（redis/qdrant/minio）缺失时插件必须降级 ACTIVE——本身就是韧性断言。
- **og 一主一备 ✅（五连坑实录）**：manifest deploy/k8s/og-cluster/ha-pair.yaml。
  ① 全量 enmotech/opengauss:5.0.3 的 MOT 引擎在容器 NUMA 下 FATAL——换 og-lite（同支持 SERVER_MODE/REPL_CONN_INFO）；
  ② k8s 默认 /dev/shm 64MB——og 要 Memory emptyDir；③ 模式要 `gaussdb -M primary/standby` 命令行参数（env 只写配置）；
  ④ replconninfo 端口不能用 port+1（5433 内部保留）——5434+localservice/remoteservice；
  ⑤ og 内核禁初始用户远程连接（trust/md5 都拒），唯一豁免=**来源地址在 replconninfo 白名单**——
  remotehost 必须写对端**真实 pod IP**（headless DNS 解析；Service IP 不行）。
  备库首次 init 由 entrypoint 自动 full build（主库须已 ready 且 hba 放行 omm replication——postStart 补）；
  运行中 gs_ctl build 会杀 PID1，重建备库走"删 deploy+pvc→主库白名单刷新→重建"运维手册。
  终态实证：**Streaming|Sync**，主写 repl_proof 5 秒备读到；opendb_ro 建于主自动复制到备；
  两节点注册平台（NodePort 30021/30022），collector 各 42 指标采集正常——复制指标有了真实数据源。
  遗留债：pod 漂移后对端白名单刷新是手册操作（自动化需 operator 级编排，超 MVP）。
- **多租户实体端到端 ✅**：012 host_pool 列；acme 租户+配额(2/10/5)+专属 agent；集群级非特权探针实测
  acme=1 行/default=5 行/无身份=0 行。生产池路由待多池部署形态。
- **文档收尾 ✅**：设计文档 artifact 同步 v0.9（同 URL）；新增交付全景演示页（P0-P3 数据/事故/暂缓池）。
- 负载字面验收（稳态 4-6/峰值 20）：脚本 /tmp/load-accept.sh 首跑撞上 mac 网络退化（kubectl IPv6 no-route
  ——观测挂、发送未知），待网络恢复重跑。

## 2026-08-20 负载字面验收达成（缺口②收口）
- **峰值 20 ✅**：60 条突发 → HPA 事件链 6→12→**20（顶格 max）**→泄洪后 18→15→13→11→9→2 全自动回落。
- **稳态 4-6 ✅**：48 条/分钟稳态负载 → 副本 2→**4→6**→9 稳定平台（20 轮全程无抖动），断流后 9→7→6 逐级回落。
  负载-副本换算实测：v4-flash 轻会话 ~10s/条 × 每 pod 2 并发 = 12 条/分钟/pod。
- 两轮共 ~400 条轻会话；观测教训：**kubectl orb.local 通道有小时级间歇不可用窗口**（IPv6 no-route，
  socat 18080 HTTP 通道全程正常）——长时负载脚本的观测要带降级（HPA events 是最可靠的事后取证）。

## 任务重做 #1：task-health 上线与工具注册事故（2026-08-21）

- **交付**：task-health（TaskType 'health' 双侧 + client 面板）+ tool-health-collect（health_collect
  确定性 12 维采集器，Runtime）。e2e 三轮：og5 单机（instance）与 og5+og-ha 主备三实例（cluster）
  均一次 `health_collect → task_report` 过锚定门；集群层共性聚类（2/3 XACT_LONG 同源 WLM）、
  max_connections 漂移（200 vs 1000）、最差实例上浮全部检出；面板浏览器实拍验证（矩阵/集群发现/签收箱）。
- **事故：health_collect 两轮不在模型工具列表**。task-health 包内 apply 顶层注册工具，
  多依赖数组 `inject(['tools','opendbDb','opendbRegistry'])` 与单依赖链式 `inject(['opendbDb'],c1=>c1.inject(...))`
  均静默不生效（无报错、无 PENDING、dump-config 正常）。根治=按 W4 结论拆独立 function plugin
  （顶层 inject 数据服务、嵌套仅 `inject(['tools'])`，1:1 对照 tool-metrics）。
- **防绕路守卫生效实证**：第二轮工具缺失时，模型按 prompt「诚实守卫」上报 warn“工具缺失未执行锚定检查”，
  而不是退回自由巡检自造 det（第一轮无守卫时它就这么干了，还把 scope 写成节点名）。
  锚定链的完整性靠三层：工具产出唯一事实源 + prompt 锚定纪律 + reportSchema 结构校验。

## 任务重做 #2：task-sqlreview + 全平台去审批化（2026-08-21）

- **去审批化（user 定位修订：模型分析+只读展示，不做变更/操作类功能）**：approvals 服务从
  host/runtime 双 bundle 解除装配（包保留，恢复走暂缓池）；引擎 createPendingAcks 移除；
  控制台待签收区/approvals RPC 下线；task_create/update 签收参数删除；alert-ddl 自举不再要求签收；
  存量 4 张签收单与 requires_approval 标记清库。浏览器回归：任务页无签收控件、console 零错误。
- **task-sqlreview 上线**：12 条确定性规则（7 目录类含 TBL001 慢SQL DML 联动升级 critical + 5 文本类）
  + Top-N 慢 SQL 计划锚定（EXPLAIN 只读 + 脚本标注 Seq Scan/下盘 + 总 cost 提取）+ 验证阶梯
  explain-verified / estimated（og 无 hypopg 如实降级）/ no-gain / plan-unavailable。
  工具半边独立包 tool-sqlreview-collect（同 health 定论）。
- **e2e 三轮**：①线上 Top5——EXPLAIN 被 opendb_ro schema 权限挡（gsbench schema 无 USAGE）→
  全部 plan-unavailable 如实呈现，模型目录取证归因锁竞争并交叉引用当日巡检；②贴 SQL 场景初跑
  发现 buildPrompt 未教模型转传 config.sqls（已修）；③修后完整链打通：脚本标注两处全表扫 →
  模型列裁剪改写 → db_query EXPLAIN 实证 cost 106→106，**如实报 0% 降幅**（行宽 -69% 收益另行说明，
  并判断 LIKE '%…' 语义必需不硬改）——诚实纪律实证。
- **引擎修复**：session 触发路径补 configSchema 规范化（service 路径已有）——部分字段 config
  直插时 buildPrompt 里 config.xxx.length 直接炸（本轮 sqlreview e2e 首跑即中）。

## 任务重做 #3：task-wdr 上线（2026-08-21）——三任务全部落地

- **交付**：task-wdr（TaskType 'wdr' + R4③ 面板：快照时间轴+窗口高亮/DB Time 堆叠条/Top SQL 归因表/
  Load Profile/等待事件/findings）+ tool-wdr-collect（窗口 delta 七维 + 归因纪律 + 阈值判定）。
- **只读铁律**：只消费既有快照对，绝不 create_wdr_snapshot / 不碰 GUC；快照不足/未开启时如实说明并留给 DBA。
  原生 WDR 留底：只探测 generate_wdr_report 存在性并给出 DBA 归档命令，不代执行。
- **og5 实探地基**（写采集器前先探，零返工）：snap_* 表列带 snap_ 前缀、时间 µs；快照每小时/保留 8 天/
  enable_wdr_snapshot=on；关键表 snap_global_instance_time（DB_TIME/CPU/IO/NET/PLAN 构成）、
  snap_summary_statement（含 cpu_time/data_io_time/sort_spill_size 归因三件套）、snap_summary_stat_database、
  snap_global_wait_events（STATUS 空闲类要剔除）、snap_global_bgwriter_stat（不是 stat_bgwriter！）。
- **归因纪律**（脚本判定，模型不可改）：tmp=sort_spill>0 · cpu=cpu/elapsed≥0.5 · io=io/elapsed≥0.3 ·
  blk=elapsed>1s 且 cpu/io 双<5%（锁等待型——og5 实数据 gsbench UPDATE elapse 1.2e9µs/cpu 15606µs 即此型）。
- **e2e**：空闲窗口/指定窗口（beginSnap/endSnap）均一次 `wdr_collect→task_report`；空闲窗口如实报 ok
  "Top10 全为平台监控自身查询"——累计计数器 vs 窗口 delta 的语义差被真实数据验证（dbe_perf 累计大 ≠ 窗口忙）。
  面板浏览器实拍验证；坑：pg Date 对象 String() 成 "Thu Aug…"，时间戳一律 toISOString 再入报告。

## 任务重做 #4：task-ddl 上线（2026-08-21，user 增补功能）

- **交付**：task-ddl（DDL 规范扫描 + 变更历史时间轴追溯：什么时间/由哪个用户/做过什么变更）
  + tool-ddl-collect。会话版本（ddl_collect 任意会话可用）+ 任务版本双形态。
- **三源阶梯**：①平台字典变更快照（对象/时间主干，10 分钟粒度）②节点审计 pg_query_audit
  （用户归因+DDL 原文；og 要求 AUDITADMIN——opendb_ro 默认无权，工具如实降级并在 DDLR90/notes
  给出解锁命令）③dbe_perf.statement DDL 文本辅助。合并=审计条目按对象名±15 分钟吸附字典条目。
- **洪峰折叠**：同刻 >30 条字典变更（collector 首轮基线导入）折叠为单条"批量登记 N 对象"——
  og5 实测 337 对象基线被折叠，时间轴保持可读。
- **规则**：DDLR00 DROP SCHEMA(critical)/01 表删除/02 TRUNCATE/03 DROP COLUMN/04 业务时段变更/
  05 变更抖动(24h≥3次)/07 DROP 无 IF EXISTS/90 归因缺失（可观测性缺口本身是发现）。
- **e2e（og5 120h 窗口）**：ddl_collect→db_query 现状核对→报告一次过锚定门；w3_dict_probe
  "建后 11 分钟即删"被讲成故事线（业务时段删除+无法归因→warn）；面板时间轴按日分组/动作色点/
  模型逐条 note 浏览器实拍验证。
- **环境注记**：og5=mac docker 容器（5433→5432）；给平台账号解锁审计查询：
  `docker exec og5 su - omm -c "gsql -d postgres -c \"ALTER USER opendb_ro AUDITADMIN;\""`
  （auto 模式拦截权限变更类命令——此授权留给 user 执行，授后时间轴自动补齐操作者）。
  task-monitor-dashboard 定位定案（user）：平台数据底座，保留。

## 会话内嵌卡上线 + 清场坑（2026-08-22）

- **会话内嵌卡（ui-task-inline，client-only）**：dsh 提供键控槽位
  `slots.register({ name: 'tool.call.toolview', key: '<工具名>' }, Component)`——key 域开放，
  为自己的工具接管会话流渲染，未接管的工具仍走通用行（官方范例：grep 的 SearchRow、
  workflow-run 的 conversation.chat.node）。props = `{ callId, toolName, block, cwd, openFile, inspect }`；
  `block.kind==='tool-result'` 时 `block.content[].text` 里是工具原文（我们的工具输出 = `--` 注释 + JSON），
  运行中则是 RunningToolCall（出骨架）。已为 health/sqlreview/wdr/ddl_collect + rules_catalog +
  task_report 六个工具注册卡片。实拍验证：会话里说「给 og5 做个健康检查」→ 红色状态带卡直出
  （严重 1/告警 1/关注 8 + Top3 发现 + 收起提示 + 降级计数），console 零错误。
- **清场坑（务必按序）**：① dsh 的 workspace 顺序索引在 `dsh_kv_units.global->workspaceIds`，
  删 `dsh_kv_records` 的 workspace 行后必须同步该数组，否则 Host boot 直接崩
  （`workspace domain is inconsistent: registry order references missing workspace`）；
  ② **清场前必须先把 Host 副本缩到 0**（KEDA 要先 `annotate scaledobject autoscaling.keda.sh/paused-replicas=0`），
  否则运行中的 pod 会把内存态写回 PG，复活工作区并新建会话——第一轮清场"没删干净"就是这个原因；
  ③ 删 agent 前要先解绑 `dsh_db_nodes.agent_id`（FK RESTRICT）并清理 `opendb_memories`
  / `opendb_knowledge_docs` 的 agent 引用。

## 用户实测四问题修复（2026-08-22）——全部属实，根因都在平台侧

- **① 消息上屏延迟 3-6 秒**（输入框 18ms 就清空、消息却迟迟不出现）。时间线铁证：
  `turn/start 12:30:14.872` → `user/message 12:30:20.634`（晚 5.76s）。根因：dsh 的 user/message
  与 context snapshot 同批落库，而 `memory-context` 在 `agent/pre-step` 做语义检索——
  **Ollama bge-m3 embedding 在 CPU 上实测 5.1/5.9/5.8 秒**，整条链路被它顶住。
  修：memory-context 注入加超时（默认 1200ms）+ 降级为「仅最近记忆」（纯 PG，毫秒级）。
  实测 6119ms → **1741ms**。（继续优化方向：embedding 缓存/更快模型/异步预热。）
- **② 建任务后首次不跑 + 说"马上跑一次"无效**。根因：`TasksService.runNow` 要求
  `this.engine !== undefined`，而 tool-task-admin 跑在 **Runtime（engine:false）** → 必然抛错。
  修：runNow 改为「只入队不执行」（INSERT queued run + NOTIFY，任何实例可调），Host 引擎
  fireQueuedManuals 负责执行；task_create 增 `run_now`（默认 true）；新增 `task_run_now` 工具。
- **③ 说"给 og5 建巡检"却起了 403 节点的巡检**。根因：task-health 的 config 用 `nodes: string[]`，
  而 sqlreview/wdr/ddl 三类型用 `node: string` ——**字段名不一致**，模型按惯例填单数 `node`，
  被 buildPrompt 忽略 → 退化成「该 agent 全部绑定节点」。修：`resolveTargets()` 同时接受
  单数/复数并合并去重（3 条回归单测）；未指定目标且绑定 >16 节点时自动转舰队聚合模式；
  task_create 的 config 描述里写明各类型字段与"点名了节点就必须填"。
- **④ 任务缺暂停/删除/修改交互**（dsh 的 goal 有）。修：任务页头加「▶ 立即运行 / ⏸ 暂停 /
  🗑 删除（二次确认）」，走 ui-opendb 既有 tasks/runNow · tasks/update · tasks/remove RPC；
  「修改策略」仍在会话里说（纲领）。
- 验证：会话里说「给 og5 建个健康检查任务，每小时一次」→ 5s 出建任务回执 → 立即产生
  manual run → prompt 为「以下 1 个节点：og5」、工具 `{"nodes":["og5"]}` → 报告落库。

## 与原生 dsh 对比测试（2026-08-22）

对照：原生 dsh `127.0.0.1:3080` vs opendb-dsh `localhost:18080`，同脚本、新会话、各 3 轮。

- **一致项**：字体栈/字号(16px)/侧栏宽(280)/背景(#F9FAFB)/边框、侧栏折叠(280→56)、消息流结构
  （上下文注入行/Think/气泡/复制赞踩重试/底部统计）、对话·轨迹 tab、Session log、生成中方块图标、
  设置页布局（通用设置/模型/插件/Agent 预设，我们多 OpenDB·记忆·知识库 三段）、详情面板。
- **回显延迟**：原生 117/109/110ms，我方修复后 930/522/524ms（修复前 1740-6119ms）。
  首轮多出的约 400ms = 首次记忆注入（Ollama bge-m3 embedding CPU 实测 5-6s，已加 600ms 超时降级）；
  稳态 ~520ms 对 110ms 的差距来自架构（PG 数据面 + 3 副本 Host + socat 转发），非缺陷。
- **修复：上下文重复注入**。我方 instructions-pg / memory-context **每轮都注入**（原生只在会话首步注入一次）
  ——既刷屏又每轮重跑 PG/向量查询。三次尝试才找对根因：
  ① `WeakMap<agent对象>` 去重失效（每 turn 新 agent 实例）；
  ② 提到模块级仍失效（**多副本 Runtime 各有独立内存**，6 轮注入 4 次）；
  ③ 想用 `decision.messages` 判断已注入过——**实测 `decision.messages.length===1`，只含本轮消息、不含历史**；
  ④ 终解：用 pre-step payload 自带的 **turn/step**，只在 `turn<=1 && step<=1` 注入。实测 3 轮 1 次 ✓。
- **测量方法论教训**：删 PG 会话后前端仍持旧 session 引用，消息只在 DOM 乐观渲染却没落库，
  一度测出"15ms 假快"。回显测量必须①先点「新会话」②用 `button` 选择器关内测弹窗
  （通用文本选择器匹配不到 button，弹窗遮挡输入框会得到 dom=-1）③交叉验证 PG 事件落库。

## og5 只读账号补授业务 schema 读权（2026-08-23，user 批准执行）

目的：让慢 SQL 的执行计划真正可得（此前 `sqlreview_collect` 的 EXPLAIN 全部 permission denied）。

```
GRANT USAGE  ON SCHEMA gsbench_e2e_20260801_100g, gsbench TO opendb_ro;      -- schema 可见
GRANT SELECT ON ALL TABLES IN SCHEMA gsbench_e2e_20260801_100g, gsbench TO opendb_ro;  -- 表可读
```
两条都是**只读**权限，符合平台只读定位。分两步的原因：只给 USAGE 时报错从
`permission denied for schema` 变为 `permission denied for relation`——EXPLAIN 需要表级 SELECT。

**配套的最小健壮性修复**（不触碰 skill 方法论）：og 的 unique_sql 文本把参数记成 `?` 占位符，
直接 EXPLAIN 必然语法报错。`explainOne` 失败后自动用 `? → NULL` 的等价文本重试一次，
并在 note 里如实标注"计划取自归一化文本"。
**实测**：og5 Top5 慢 SQL 由 0/5 可得 → **4/5 可得**（剩下 1 条是 UPDATE，只读账号无法 EXPLAIN 写语句，
符合定位）；会话侧复验工具结果含 4 处 Seq Scan 计划行，此前为 0。

生产接入清单更新：平台只读账号 = MONADMIN + AUDITADMIN + 业务 schema 的 USAGE/SELECT + 事务级只读。
新建表需 `ALTER DEFAULT PRIVILEGES` 才自动继承（未做，按需再议）。

## 阈值可配置化插件上线（2026-08-24，user 拍板：平台配置可写、实时生效、改前必确认）

三个新包：`thresholds-pg`（服务，PG 存覆盖、代码常量为默认）、`tool-thresholds`（threshold_list/set/reset，
Runtime）、`task-thresholds`（任务类型 + 大盘）。四个任务插件的判定函数改为接收阈值参数（默认 = 常量，
值一字未改）；sqlreview/ddl 埋在 SQL 与行内的字面量提成常量。迁移 014。
e2e 全通：threshold_list 卡 6s；改阈值 → 模型复述 → 原生 ask_user 确认卡（1/1 已回答）→ threshold_set 卡 6s；
落库 + 变更历史 + 大盘高亮「1 个已改动」；确认卡跨进程持久（脚本关页后重开会话仍在）。

**事故 1：新包只加了 bundle 没加 profiles 依赖 → 新 pod `ERR_MODULE_NOT_FOUND` 崩循环。**
dsh 从 `/var/lib/dsh/profiles/<profile>/` 解析插件，`profiles/host|runtime/package.json` 必须列 workspace 依赖，
否则镜像能建、pod 起不来。且因 rollout 卡住，旧 pod 继续服务，**不看 `get pods` 察觉不到**。
已写进 CLAUDE.md「新建插件包三处缺一不可」。

**事故 2：滚动窗口内跑浏览器验证 → 插件脚本 502 → 页面「Failed to load plugins」→ e2e 误判。**
rollout 刚完成时新 pod 尚在预热，`manifest.webmanifest` 200 不代表插件脚本全 200。验证前应对
`/plugins/@opendb-dsh/*/client.js` 逐个 curl 200 再开浏览器；e2e 脚本里也要在 goto 后断言页面不含
「Failed to load plugins」。

**教训 3：dsh 原生 ask_user 选项是 `button[role=radio]`**，不是 `<button>` 文本也不是 label——自动化点确认
要按这个选。待答期间主输入框被锁，往里打字不会被当作回答。

## 会话内图表（2026-08-24，user：曲线/趋势/对比图是核心功能）

prd 截图：用户要 QPS/TPS 曲线，模型在代码块里用 ▇ 字符"画"柱子——平台没有画图工具，指标层只有
`metrics_recent` 吐文本表格，而 TPS/QPS/CPU 原料又都是累计计数器，模型自己差分还会把半个窗口当一根柱。

两个新包：`tool-chart`（Runtime：`metrics_chart` 从指标库取数、服务端差分/比例/降采样、叠平台阈值线；
`chart_render` 让模型对任意数据出图）+ `ui-chart`（会话内联卡：纯 SVG 折线/面积/柱状，坐标轴、网格、
多序列图例、阈值虚线、hover 十字线与数值提示、min/avg/max/last）。语义指标目录 17 个（tps/qps/cpu/
cache_hit/connections/load_per_core/…），原始 db.* 键也能画。payload 里时间压成"距 t0 秒数"，
120 点一条序列约 1.5KB，模型读得起。工具描述明写"要图必须用工具，不要用文本/ASCII 画"，
`metrics_recent` 描述反向引导；输出头写"图已渲染，用两三句解读趋势即可"。

e2e：「画 og5 最近 2 小时的 TPS 和 QPS 曲线」→ 6s 出卡（两张图）、hover 提示 `08-25 11:03:09 | og5 | 28.83/s`、
图例 最新/均/峰、回复零 ▇ 字符，模型解读"两波尖峰=压测"；「每核负载」图叠出 notice/warn/critical 三条虚线。
一处修正：模型有时传原始键 `db.connections_used_ratio` 而非 `connections`，目录加了原始键→语义定义的反查，
否则丢阈值映射与人读标签。
坑：docker 从 mac 出不去 Docker Hub（`curl registry-1.docker.io` HTTP 000，docker 走 proxy.orb.internal:8305），
build-image 在 `FROM node:22-bookworm-slim` 解析 manifest 时 Bad Gateway，重试三次都不行；本地 image store
也没有该镜像（buildx 缓存不算）。**绕法**：`docker pull --platform linux/arm64 docker.m.daocloud.io/library/node:22-bookworm-slim`
→ `docker tag … node:22-bookworm-slim`，buildx（docker driver）优先用本地副本，不再联网解析。
注意 macOS 没有 `timeout` 命令（脚本里用了会静默跳过）。

## 中毒 Runtime pod：用户消息一半凭空消失（2026-08-25，user 报障）

**现象**：问「最近 5 分钟」正常，连问两次「最近 15 分钟」提问消失、无回应。库里这两条连 user/message 都没有。

**取证链**：runtime 日志 `run failed … error: deadlock detected` ×2，都在 pod c75n7；dsh PG 与 og5 那一分钟都
**没有**任何死锁记录；认领→失败只隔 **9ms**（PG 死锁检测至少等 deadlock_timeout=1s）→ 不是当场死锁，是缓存的
rejected Promise。c75n7 启动于 04:37:14 UTC，PG 日志 04:37:41 有一条真死锁：迁移 `002_tenant.sql` 的
`ALTER TABLE … IF NOT EXISTS`（AccessExclusiveLock）撞上另一台的 `claimNext` `FOR UPDATE`，牺牲方是 c75n7 上
某个服务的 `runMigrations` → 该服务 `this.ready` 永久 rejected（构造器里 `this.ready.catch(() => {})` 吞掉）→
此后 c75n7 每次 `agents.resume` 瞬间抛同一个错。c75n7 自启动 0 次成功、3 次失败；另一台 3 成功 0 失败。
两台 SKIP LOCKED 随机认领 → 用户消息一半消失。readiness 200、pod Running，**从外面完全看不出来**。

**三层根治**：
1. `runMigrations`：可重试错误（55P03 锁超时 / 40P01 死锁牺牲 / 40001 串行化）退避重试；新增
   `opendb_schema_migrations` 台账，只跑未应用过的文件——稳态启动一条 DDL 都不跑，锁风暴从源头消失。
2. `runtime-worker`：模块级 `migrationFailures()` 计数，>0 则**拒绝认领**（认领必失败还吞消息）且健康端口回 503；
   失败日志改打 code/detail/where/stack（此前只有 `String(err)`，六个字查了两小时）。
3. Helm：Runtime 加 livenessProbe（readiness 摘端点拦不住自拉式认领），503 连续 3 次由 k8s 重启自愈。

**即时处置**：`kubectl delete pod c75n7` 重建（迁移重跑即恢复）。队列里 631/632 两行（用户的两个提问）
已 admitted 不会重投，属死信；用户后来的消息一切正常。

**修复首次上线自己踩的坑**：台账表的 `CREATE TABLE IF NOT EXISTS` 我放在了 advisory 锁外——IF NOT EXISTS
挡不住两个进程**同时**建表，第二个撞 `pg_type_typname_nsp_index` duplicate key（23505）。collector 的三个
PG 服务同时启动全撞上，`registry.listNodes` 随之失败、**指标采集停摆**（两台 Runtime 恰好没撞）。
修法：建表也放进 advisory 事务锁内，且该步把 23505 视为可重试（重试时表已在即成功）。
这次也验证了新防线：失败被 `[migrations] FAILED` 显式打出来（不再被 `.catch(() => {})` 静默吞掉），
第一时间就看见了。

### 第二轮（同日，user 三问）：为什么提问连痕迹都没有、Host 能不能兜底、原生排队哪去了

**Q2 提问为什么消失**：Host `ProxyAgent.send()` 只做「写队列行 + 开 tail」，**Host 从不落持久事件**（单写者：Runtime
分配 seq，Host 只镜像）；`user/message` 是 Runtime 认领后才写的。中毒 pod 在写之前就抛错 → 日志里什么都没有；
客户端 `prompt()` 只发 RPC、不画乐观气泡（气泡完全靠回流的持久事件）→ "提交成功、无人处理、零可见状态"。

**Q3 原生排队为什么没了**：原生链路 `agent.followup()` → `Inbox.splice()` 落 `agent/inbox/spliced` 持久事件 →
apiproxy 监听到后读 `agent.inbox.nextTurn/nextStep` 广播 `session/queue` 帧 → 客户端 queue dock；编辑/移除/插队走
`session.updateQueue` 直接操作 `agent.inbox`（rc.6 只有这三个动作，没有拖拽排序）。我们的 `ProxyAgent.inbox` 是从未使用
的占位，`followup/steer` 全绕过它直写 PG → 没有 splice 事件 → 帧永远不来、`updateQueue` 找不到条目。
**Host 也不能改用真 Inbox**：它会 append 会话日志，Runtime 运行中 Host 再写 seq 就冲突（核对了 20 个 `session/event`
监听方——persistence/projection/title/telemetry/invariant——合成事件也不可行）。

**修法（user 拍板：重投上限 3 次；排队展示复用原生 dock）**：
- 表 `015_queue_redelivery.sql`：`dsh_thread_queue` 加 `message_id/attempts/failed_at/reported_at/last_error`，`kind` 允许 `steer`。
- Runtime `runtime-worker`：运行失败 → `requeueFailed`：attempts+1，未到上限则 **admitted 置空让任何 pod 重领**
  （失败 pod 冷却 5s 让位），到上限记 `failed_at`（死信）；连续 3 次失败 → 健康 503 熔断 → livenessProbe 重启。
  1s 轮询顺带消费 `steer` 行 → `agent.steer()`（真正的中途插队）。队列行透传 Host 铸的完整消息，Runtime 用**同一
  id** 落 `user/message`。
- Host `agent-loop-dispatch`：`ProxyAgent.inbox` 换成 `QueueInbox`（PG 队列投影，只暴露 apiproxy 用到的
  `nextTurn/nextStep/remove/replace`；`toSpliced` 恒等——apiproxy 会拿镜像进来的 Runtime splice 下标套我们的投影）。
  tail 每 tick：Host 自己回收心跳过期线程（Runtime 全挂时没人跑 markStale）、`settleDurable` 去重（重投的行若消息已在
  日志里，绝不跑第二遍）、投影刷新、死信以 `agent/error` 报给用户（原生红条）+ `reported_at`。
- 客户端 `ui-harness/queue-sync.ts`：每秒拉 `/opendb queue/list`，合成 `session/queue` 帧喂 `ctx.sessions.handleMuxEnvelope`
  → 原生 dock 原样展示"排队中"，提交即可见，直到 Runtime 写下持久气泡。RPC 直接读 PG（HTTP 与 WS 可能落在不同 Host 副本）。
- 验证：`scripts/e2e-queue.mjs`（并发提交可见 / remove / steer 插队 / 无残留）、`scripts/e2e-queue-outage.mjs`
  （Runtime 缩 0 仍可见 / 模拟死信红条 / 恢复后处理）。

**上线自己踩的坑**：ssh 非交互 PATH 没有 docker，`build-image.sh` 在 pnpm 全量编译后 `docker: command not found`
退出 127，而我的包装脚本没看退出码直接 `rollout restart`——滚动的是旧镜像，迁移台账仍 14。教训写进脚本：
`bash build-image.sh || exit 1`，滚动后必查台账数。

**e2e 逼出的第三个潜在 bug：跨副本 resume 会往运行中的日志里写东西**。e2e 脚本不带 cookie，HTTP 与 WS 落在不同
Host 副本；WS 那台在 Runtime 跑 turn 1 的当口 `agents.resume` 了这个会话，dsh 的 persistence coordinator 把"未闭合的
turn"当成撕裂：在内存里补 `step/end` + `turn/end(interrupted)`，Session 构造器再补 `session/end-seed`，然后经我们的
backend `commitRepair` / `appendBatch` 落库（seq 20-22）。Runtime 随后写自己的 20-22 撞 `ON CONFLICT DO NOTHING`
——**先到者赢，输家静默丢失**（这次丢的是三个 reasoning 增量；换成 tool/call 就是真损坏）。浏览器因 Host Service 有
traefik 粘性 cookie（`opendb-host`）基本不会触发，但 cookie 失效 / Host pod 重启后同样会。
修法：`session-persistence-pg` 加 `guardRunningThreads`（bundle-host 开启）。第一版只是"跳过 `commitRepair`"，结果
e2e 直接把 prompt RPC 挂死 300s——coordinator 的 `commitPrepared` 提交修复后返回 undefined，让调用方**重新 prepare**，
重读还是开着的 turn → 再修 → 无限循环（日志里同一会话连打四条 skipped repair）。最终形态：会话线程 `running` 或有待认领
提问时，Host 的 `loadStored` / `readStoredRevision` 只读到**最后一个 `session/end-seed`（含）**——Runtime 每次认领都会
resume 并在它跑的那轮前写这个标记，所以该前缀天然闭合：没有 open turn 可修、Session 构造器也不会再补标记、下一个 seq 正好
是运行中那轮的第一条事件，`readFrom` 镜像不截断，零幻影事件。`appendBatch` 在 Runtime 占用期间仍跳过（顺带发现 Host 的
write-behind 一直在把镜像进来的事件回写 PG——`ON CONFLICT DO NOTHING` 挡着才没出事，现在也不再回写）。
两支 e2e 也改成带粘性 cookie，行为与浏览器一致；`NO_STICKY=1` 则故意跨副本，专门验证这条写保护。

**验收结果（2026-08-25 18:30-18:45）**：
- `scripts/e2e-queue.mjs`（粘性）PASS：A 运行中 +1.8s 排队投影同时出现 B、C；`updateQueue remove C` 接受且 C 从未落日志；
  `steer B` 接受，B 在 A 的**同一轮**内被处理（seqA 9 < seqB 348 < turn/end 4728，全程唯一一个 turn/start）；
  日志无 interrupted 闭合；收尾投影空、会话空闲。跨副本（`NO_STICKY=1`）：三台 Host 在 Runtime 运行中 resume 同一会话，
  PG 里 turn/end 计数 0（以前会被补出 `interrupted`）；`updateQueue` 落到没有该会话代理的副本会回 queue-item-not-found
  ——这是 apiproxy 原生语义（它不 resume），浏览器有粘性 cookie 不会碰到。
- `scripts/e2e-queue-outage.mjs` PASS：Runtime 缩 0 后提问 D 8/8 次轮询持续可见；模拟死信 → 红条「消息处理失败（Runtime
  已尝试 3 次）：simulated poison」且从投影撤下；恢复后 E 4s 内被新 pod 认领处理；D 从未运行。
  **Runtime 副本归 KEDA 管**（ScaledObject min=2，`kubectl scale` 会被立刻改回）：停机场景用
  `kubectl annotate scaledobject/opendb-dsh-runtime-default autoscaling.keda.sh/paused-replicas=0`，去掉注解即恢复。
- 浏览器级（mac 无头 Chrome + puppeteer，`/tmp/puppw/queue-browser.mjs`）PASS：连发三条后底部出现原生折叠条
  「2 条排队消息」→ 点开两行，行内原生「编辑排队消息 / 删除排队消息 / 插话发送」→ 真实鼠标点删除 → C 消失、dock 剩 B、
  A 继续流式输出，console 零错误（截图 queue-1..4.png 亲眼核对）。
- e2e 的长提问只用指标类工具：健康体检工具在节点绑定异常时会让模型 `ask_user_question`，e2e 无人应答整轮就挂在那
  （曾把一台 Runtime 的一个并发槽占了 15 分钟，`dsh_questions` 置空答案 + 插一条 interrupt 行才解开）。
- 另：mac 上 `k8s-cp.orb.local` 只解析到 IPv6，kubectl 偶发 "no route to host" 几十秒——脚本里的 kubectl 一律重试。

### 第三轮（同日 19:44，user 报障）：新会话草稿置灰「选择一个工作区开始」

**现象**：点「新会话」后输入框虚线禁用，提示「选择一个工作区开始」，无法交互。PG 里 19:43:48 / 19:44:02 两条空白会话
都建成功了——服务端没拒绝。

**根因（探针复现，非猜测）**：浏览器与 Host 有三条连接（HTTP、`events.mux`、`events.host`），靠 traefik 粘性 cookie 绑在
同一副本；当天 Host 滚动 5 轮，旧连接断线重连时旧 cookie 指向的 pod 已不在，traefik 给每条重连**各自随机分配**副本并
重发 cookie → 三条连接分家。dsh-host-apiproxy 的两条推送流只转发**本副本**的 ctx 事件：HTTP 在 A 建会话，
`host/session-added` 只在 A 的流上发，页面的流在 B → 草稿等不到「会话已建好、属于 og-lab」（chip 解析靠
`workspace.sessionIds.includes(sessionId)`）→ 原生把输入框置灰（`inert = sessionId===undefined || hero && chipTitle===undefined`）。
探针 `/tmp/puppw/cross-pod-probe.mjs`：拿三台副本各自的 cookie，用 A 建会话，A 的 host 流收到 session-added、B 的流**空**。
雪上加霜：原生此时会露出工作区选择行让用户手动点一下，那行被我们按 user 要求藏了 → 没有自救入口。

**处置（user 定：全部做）**：
1. `ui-harness` CSS：`body:has(textarea:disabled) [class*="heroWorkspaceRow"]{display:flex}`——只在输入框禁用时露出原生选择行
   （正常态照旧隐藏）。无头 Chrome 验证：隐藏→禁用时露出（截图 hero-row-menu.png 可见 og-lab ▾ 标准模式 ▾）→恢复后再隐藏。
2. chart：Host `replicas: 1`、KEDA `autoscale.min: 1`——预览阶段单用户，多副本只带来分家问题；需要时调回 3。
3. 新插件 `packages/host-fanout`（bundle-host + profiles/host 三处注册）：PG NOTIFY 通道 `opendb_host_fanout`；本副本的
   `session/created` / `agent/status→running` 广播「会话被触碰」，其余副本 `agents.resume` 成本地活会话（announce 触发本副本
   `session/created` → apiproxy 给本副本的 mux/host 流补订阅与 session-added；之后 ProxyAgent tail 从 PG 镜像、按线程状态上报
   running/idle）；`agent/error` 也广播重抛（死信红条各副本都看到）。扇入 resume 前先等 seed 落库（write-behind 晚几十毫秒，
   过早 resume 会让空 seed 的 `session/end-seed` 抢占 seq 0 顶掉系统提示——这才是真损坏）；扇入触发的 announce 不回播（防环）。
   6 个单测覆盖去重/防环/等 seed/重抛。验收：3 副本下探针 B 流收到 A 建的 session-added ✅；随后 helm 收到 1 副本。

### 第四轮（同日 21:06，user 报障「选择完成后直接出不来了」）：滚动更新会切断运行中的轮次

**事实**：user 21:05:52 回复「2」，Runtime gftz4 立刻认领、跑了 44s 工具调用；21:06:36 那台 pod 正被我发布 host-fanout 的
滚动更新终止——dsh 收到 SIGTERM 关机时**直接取消运行中的轮次**（`turn/end interrupted`），最终回复没生成，Host 侧一切"正常"
（release idle、tail stop）。`terminationGracePeriodSeconds: 330` 完全用不上：不是 k8s 杀的，是 dsh 自己取消的。
**修法第一版**（只看 `turn/end` 原因）e2e 直接翻车：`kubectl delete pod` 后事件在 14:50:28 就停了，没有任何 turn/end，
线程最后还被标 idle——dsh 关机时插件销毁顺序不可控：session-persistence 的连接池先被关，轮次还在内存里跑、输出全丢，
我们的 drain 等它"自然结束"再 release idle。结论：**不能指望 dsh 替我们收尾**。
**最终形态**：`runtime-worker` 自己接 SIGTERM/SIGINT → 立刻取消本 pod 所有运行中的轮次（`running` 表）→ run() 看到
"不是用户中断的 interrupted / 关机中没跑到 completed" → `requeueFailed(..., { rotateMessageId: true })` 换一个消息 id 重投
（原 id 已落日志，Host 的 settleDurable 会把它当"已处理"吞掉，同一 id 也不能在日志里出现两次），线程标 interrupted，
全程用 worker 自己的连接池；flush 失败不算运行失败。新 pod 重跑一遍，日志上第一轮标 interrupted、第二轮完整，计入 3 次上限。
验收 `scripts/e2e-queue-shutdown.mjs`：长提问运行中 delete 正在跑它的 pod → interrupted → 新 id 重投 → 另一台跑到 completed。
**纪律**：Runtime 滚动前先看 `dsh_threads.status='running'`（滚动脚本已内置等待归零）；user 正在对话时不要滚 Runtime。

## 任务面板退化成历史列表（2026-08-26 v0.1.0 发布后，user 报障：健康报告与平台阈值配置都"没了"）

**现象**：任务页只剩默认视图（运行历史列表 + "当前是默认视图"提示），两个任务类型同时如此。
**排查**：Host 单副本已运行 1.5h 无重启；插件包 URL 全部 200；无头 Chrome 新开页面渲染正常；Host 日志无错。
→ 不是服务端坏了，是 user 的页面在 **Host 滚动窗口**里加载的：任务面板插件包（task-health / task-thresholds 的 client.js）
那一刻拿不到，客户端插件没注册，任务页只能落到默认视图；页面不刷新就一直如此。
**窗口从哪来**：Host 的 readinessProbe 只探 TCP 3080——端口一开 k8s 就判 Ready、流量就切过去，而 dsh 插件系统还在启动，
插件包请求 5xx/超时。`maxUnavailable` 25% 对单副本取整为 0 本来是对的，但"就绪"判早了等于没保护。
**修法**：
1. 就绪探针改 `httpGet /plugins/@opendb-dsh/ui-harness/client.js`（Host 头 `localhost:3080`，加进 extraTrustedHosts 过 fence）：
   只有插件系统真正能服务了才 Ready；策略显式 `maxSurge 1 / maxUnavailable 0`。
2. ui-harness 兜底视图：用 `performance.getEntriesByType('resource')` 看该类型插件包的请求（不存在 / 非 200 / 0 字节 = 没加载上），
   命中则红条提示 + **自动刷新一次**（sessionStorage 限 5 分钟一次防循环）+「立即刷新」按钮。
3. 滚动脚本在 rollout 期间每秒探插件包 URL 统计非 200 次数，作为窗口是否归零的验收。
**验收**：新探针生效后再滚一次 Host，rollout 全程每秒探 `task-health/client.js`：**120/120 全 200**；
无头 Chrome 新开任务页：13 维卡片正常、无默认视图提示、console 零错误。
**user 追问"确实根治了吗"之后再加的两层**：
4. 兜底视图区分「插件包没加载」（自动刷新）与「包已加载但没注册面板 = 初始化抛异常」（红条要求看 console，刷新无用）——
   后者是之前**唯一没挡住**的静默退化路径。
5. `deploy/k8s/rollout.sh`：以后滚动一律用它，内置验收：迁移台账 / 模块缺失 / 插件包 200 / **滚动期间每秒探插件包统计非 200** /
   无头 Chrome 跑 `scripts/browser/task-panel-check.mjs`（任务页必须是专属大盘且 console 零错误）。
   首次使用就抓到残余：240 次探测 **1 次非 200**——切换瞬间请求打到已收到终止信号、立即退出的旧 pod（endpoint 摘除与 traefik
   更新有 ~1s 错位）。修：Host 容器 `preStop: sleep 8`。复测 **240/240 全 200**，浏览器验收 PASS。
   另：mac 自带 bash 3.2 在 `${var:+…}` 里放多字节字符会把变量名啃坏（"codes�: unbound variable"），脚本里只用 ASCII。

## 「删除失败：这条消息可能已经开始发送」（2026-08-27 user：队列里的信息删不掉是否合理）

**实况**：那条消息发出后 5ms 就被 Runtime 认领并开始执行（智能体空闲，没有真正排队），1m48s 后答完。提示是 dsh 原生的
`queue-item-not-found` 文案，语义正确：已开始执行的消息无法撤回，要中止走停止键（interrupt）。
**我们的问题**：排队投影把「已被领走、但 user/message 还没落日志」的行仍显示为排队中（本意是"提交后一直可见"），客户端又每秒轮询，
于是有 ~1s 窗口能看到一条删不掉的"排队"消息。
**修法**：`projectQueue` 只投影 `admitted_at IS NULL` 的行——Runtime 一领走就从排队区撤下；领走到落日志只有 ~100ms，看不到的
空窗可忽略；重投/回收后重新 pending 的行会再次出现。单测同步改。
**顺带看到的旧账（08-26 11:17 那轮）**：DeepSeek API 传输故障让模型请求挂了 30 分钟，期间 Runtime 心跳过期 → 行被回收成 pending
→ 30 分钟后 Host 的 settleDurable 把它按"已持久化"结清；turn 以 error 结束。心跳为何停要另查（怀疑请求挂住时 PG 连接池被占满）。

## `column "event_name" does not exist` 经常报（2026-08-26 user）

**来源**：不是我们的采集器（代码里没有这个列名），是「深挖」会话里模型自己写的 `db_query`：
`SELECT event_name, … FROM dbe_perf.wait_events`——模型按 PostgreSQL/其它库的印象猜 openGauss `dbe_perf` 视图的列名
（`wait_events` 的列叫 `event`，也没有 `avg_wait_time_ms`），报错后再自纠一轮。两次都发生在深挖会话（提示词鼓励用工具取证）。
**修法（tool-db）**：
1. `db_query` 报 42703 列不存在 / 42P01 表不存在 / 42883 函数不存在 时，抽出 SQL 引用的每个关系（FROM/JOIN，跳过 CTE），
   在同一节点查 `information_schema.columns`，把**真实列名**附在错误里，并给出最接近的列名建议
   （`event_name → event`、`avg_wait_time_ms → avg_wait_time`、`total_elapsed → total_elapse_time`：去后缀 / 子串 / 编辑距离 / 词元重合）。
2. 工具描述加一行 openGauss 常错列名速查（wait_events / statement / os_runtime / session_stat_activity），每轮都随工具清单发给模型。
og5 实测的 dbe_perf 列名（做速查表的依据）：wait_events(nodename,type,event,wait,failed_wait,total_wait_time,avg_wait_time,max_wait_time,
min_wait_time,last_updated)、statement(unique_sql_id,query,n_calls,min/max/total_elapse_time,n_returned_rows,db_time,cpu_time,execution_time,
parse_time,plan_time,…sort/hash 计数)、os_runtime(id,name,value,comments,cumulative)、instance_time(stat_id,stat_name,value)、
session_stat_activity(≈pg_stat_activity + unique_sql_id,trace_id)、summary_stat_database(≈pg_stat_database)、statement_history(慢 SQL 明细)。
取列名的方法：Runtime pod 内用 `/app/node_modules/.pnpm/pg@*/node_modules/pg` 直连（凭据取 env，绝不打印）。

## 健康报告改造：十二维直读采集器、发现带图、一键深挖（2026-08-26，user 三点）

**问题**：十二维矩阵只从「发现」反推，健康维度一个数字都没有；异常维度只给 `值 · 规则码`，不解释数字含义/阈值/为何判级；
报告数字全靠模型用 task_report 抄；「会话深挖」只是把一句话复制到剪贴板。

**做法（user 拍板：采集结果落库、面板直读，不让模型抄数字）**：
- `task-health/src/measures.ts`：`enrichDim(dimResult, T)` 把各维已算出来放在 evidence 里的数字整理成 `measures`
  （值 / 单位 / 含义 / 生效阈值阶梯 / 落档 / why）与 `charts`（bar / pie / gauge）。**不碰采集器 SQL、规则、阈值、判定**；
  阈值含义来自 `THRESHOLD_META`（改为导出），阶梯用运行时 T（平台阈值覆盖后的值）。connections 采集器只多了一句
  state 分布查询（展示用，失败不影响判定）。
- 迁移 016 `opendb_health_collects`：`tool-health-collect` 采完把完整确定性结果（每维 measures/charts/findings、生效阈值全表）
  按会话落库（bundle-runtime 给它 `connectionString`），模型侧 content 只多一行「已存档 #id」。
- `ui-opendb`：`runs/list` 按 run.session_id 附带该次运行窗口内最新一次采集（`collect`）；新增 `health/trend`（节点名 +
  语义指标 → 最近 N 分钟序列 + 阈值线，复用 tool-chart 的目录与算法）。
- 新包 `chart-kit`（客户端 SVG 原语：Bars / Pie / Gauge / Line），task-health 面板与后续会话渲染共用。
- 面板：每维卡片 = 关键值（带单位）→ 含义 → 阈值阶梯（notice/warn/critical，标实测落档）→ why → 本维分布图；
  发现卡带同维图 + 「深挖」；趋势区 = 指标库最近 60 分钟曲线（叠阈值虚线）+ 历次检查关键指标折线；
  模型报告只保留「根因串联 / 处置优先级」两段。旧 run（无 collect）退回原来的按发现展示。
- 深挖：`digInSession()` → `ctx.sessions.create({workspaceId})` → 桥 `openSession(id)`（ui-harness 挂到 `__opendbHarness__`，
  切到聊天区）→ `ctx.connection.rpc.call('/api','session.prompt',…)` 自动发送「背景（实例/维度/指标/阈值/证据/同维指标）+ 任务」。
- 维度可插拔：`COLLECTORS` 数组一项 = 一维；新维度只需在 `enrichDim` 登记其 measures/charts。候选新维（回卷/统计陈旧/临时文件/
  参数基线/复制槽/死锁/容量/账号/内存/热点表）待 user 点名。

**验收（mac 无头 Chrome `/tmp/puppw/health-panel-e2e.mjs` + 分屏截图 hp-full-*.png / hp-trend.png 亲眼核对）**：
点「立即运行」64s 后 `opendb_health_collects#1` 落库（13 维 / 28 项指标 / 11 张图）；面板徽章「数字直读采集器存档 #1 ·
阈值来源 platform-overrides」；13 处「落在「x」档 / 未触及任何一档」解释、阈值阶梯文字、121 个 SVG 元素、趋势区 5 条指标库曲线
（连接/缓存命中/CPU/每核负载/TPS，叠阈值虚线）+ 3 条历次检查折线；22 个深挖按钮，点「深挖 CACHE_LOW」→ 新会话
「数据库缓存命中率偏低深挖」自动发送背景提示词并开始取证；console 零错误。截图核对时修的两处：水位条相邻两档刻度文字重叠
（改为交替上下两行 + 靠边对齐）、慢 SQL「最慢均耗时」取了按总耗时排的第一条（改为按均耗时取最大）。
注意 `og5过载监控` 是 `*/5 * * * *` 的健康任务（user 建的），每 5 分钟跑一次采集 + 一轮模型报告——token 持续消耗，
测试用途请记得停。

**R2（同日，user："非常难看，各种没对齐，卡片也不够精致；饼图柱状图只是举例，参考业界"）**：按运维大盘 stat 面板做法重做——
每维等宽等高 stat 卡（标题行 → 24px 大数 KPI → 4px 阈值轨道：刻度与实测都在轨道上、文字统一在轨道下一行 → 两列对齐的
次要指标 → 一个紧凑可视化 → 右下角「深挖 →」文字链）；构成用 100% 堆叠条 + 图例代替环形饼，Top-N 用排名条列表（≤3 行），
发现行带最近 60 分钟迷你趋势（Sparkline，按规则码映射指标）；环图缩小并入状态带；卡片 1px 边 / 10px 圆角 / 轻阴影，
数字 tabular-nums；一项独占 ≥99.5% 的构成不画图改一句话；同维分布图只在该维第一条发现下画一次；主指标 = 落档最重的
（同级优先带阈值规则的）；模型把维度键当 item 时标题改用维度中文名；Line 改为随容器宽度自适应（ResizeObserver），
缩到 340px 卡片里坐标文字不再被等比缩成 5px。chart-kit 新增 Rail / StackedBar / RankList / Sparkline。
截图（r4-*.png）逐屏核对：13 张卡对齐一致、趋势区 8 张图文字清晰、console 零错误。

## 数据库权限改由数据库控制：og5 opendb_ro 提 SYSADMIN + 拆插件侧只读门（2026-08-27，user 定）

起因：慢 SQL 会话里模型想读 `dbe_perf.global_statement_complex_runtime`（正在运行的复杂语句），报 permission denied。

**取证**：`has_function_privilege('opendb_ro', …)` 显示 pg_catalog / dbe_perf 全部函数都有 EXECUTE（唯一例外
`copy_error_log_create`），所以不是 ACL——是 openGauss 这 5 个 WLM 实时函数内部硬校验只认 SYSADMIN（MONADMIN 不放行）：
`pg_stat_get_wlm_realtime_session_info` / `_realtime_operator_info` / `_realtime_ec_operator_info` /
`pg_stat_get_wlm_statistics` / `pg_stat_get_session_wlmstat`。受影响视图：`global_statement_complex_runtime`、
`statement_complex_runtime`、`global_operator_runtime`、`statement_wlmstat_complex_runtime`。其余 40+ 诊断视图/函数原本就可读。

**user 决定**：① `ALTER USER opendb_ro SYSADMIN`（auto 模式分类器拦提权命令，最终 user 明示后执行成功；
角色级 `default_transaction_read_only=on` 保留）；② **权限放在数据库里控制，平台插件不做控制**——拆掉：
`@opendb-dsh/db` 的 `guard.ts`（语句白名单 / 写关键词 / 危险函数表 / 单语句限制）、db seam 启动包
`options: -c default_transaction_read_only=on`、`db_query` 的只读门调用；多语句文本按 psql 语义返回最后一条结果
（node-pg 多语句返回数组，`lastResult` 收口）。工具描述改为「平台不做语句过滤，能执行什么由平台账号的数据库权限决定」。

**如实说明的边界**：SYSADMIN ≈ 超级用户；角色级只读只是默认值，会话 `SET transaction_read_only = off` 即可写
（这不是新洞：非 SYSADMIN 也能 SET，此前靠插件门拦 SET，现在按 user 决定不拦）。要硬只读只能不给 SYSADMIN 走授权路线。
凭据仍只在 Secret `opendb-db-credentials`，不落库不进日志。

**复验**（`/tmp/og5-as-ro.sh`，以 opendb_ro 连 og5）：4 个 WLM 视图可读、`SHOW transaction_read_only` = on。
生产接入清单更新：平台账号 = SYSADMIN（或至少 MONADMIN+AUDITADMIN+业务 schema USAGE/SELECT）+ 角色级只读默认；
平台侧零过滤。

## Top SQL 报表（慢 SQL 报表重构 R5，2026-08-27，user 定稿设计后开发）

**起因（user 四点）**：① UI 难看 ② 违反规范不要在顶部汇总，放到各条慢 SQL 的分析里，顶部应突出各 SQL 的资源占比
③ 会话里要"按执行时长和执行次数分别 Top5"，报告只出了慢 SQL ④ 深挖要直接开新会话而不是复制提示词。
先出设计稿 `docs/prototypes/sqlreview-r5.html`（数字取自 og5 实测）在浏览器里过，user 认可框架后开发。

**顺手查到的根因/问题**：模型当时把"双榜"建成了每 10 分钟的 **prompt 定时对话任务**（sqlreview 配置只有按均耗时 topN，
表达不了"按执行次数"）；该任务被归档后**仍按 cron 跑**（3 小时 10 份无人可见的报告）——归档表是旁路表，调度器不看它。
已停用该任务并修调度：`fireDue` 排除 `opendb_archived_tasks`。`og5过载监控` 仍是 `*/5`（user 建的，未动，已提醒）。

**做法（数据链三层打通）**
- 配置：`dimensions: string[]`（elapsed/calls/avg/cpu/io/blocks/dbtime/spill/rows，接受中文别名 `normalizeDimensions`）+ `topN`；
  `task_create` 描述写明"按执行次数和耗时分别 Top5 → sqlreview + dimensions=[calls,elapsed]，不要退化成 prompt 任务"。
- 采集（`task-sqlreview/src/topsql.ts` 纯函数 + `tool-sqlreview-collect`）：一次 workload 汇总 + 每维度一次 Top-N，
  按 unique_sql_id 去重、S1.. 按首次上榜编号、每条带全量指标 / 占全库比例 / 各榜榜位 / 类型判定（事务控制·监控类·OLTP 高频·
  分析型·疑似锁等待）；逐条 EXPLAIN（事务控制语句跳过，上限 24 条）；12 条规则违规按"违规所在表 ∈ SQL 引用的表"归到各条
  SQL 名下（`RuleFinding.table` 新增字段，只用于归因不参与判定）；「一眼结论」由脚本按占比生成，阈值 `shareHighlightPct=30`、
  `commitDbTimePct=15` 登记进平台阈值配置。整包存档 **`opendb_task_collects`**（migration 017，按 task_type 通用），
  `runs/list` 附带；给模型的是精简视图（文本/计划/标注/归因违规/少量指标），它只做逐条解读。
- 报告 schema 只装叙述：`sqlItems[{key, optimizedSql, newCost, costDropPct, verify, detail}] + priorities + rootCause`；
  旧报告（无存档）面板走兼容视图并提示重跑。
- 面板：负载总量卡 → 资源占比堆叠条（只画配置的可分摊维度；avg 无占比）+ 一眼结论 → 每维度一张榜 → 逐条分析卡
  （指标条 · 原 SQL · 计划按 planFindings.line 标注 · 本条违规 · 优化方案/cost 对比 · 解读 · **在新会话中深挖** 一键建会话发送）
  → 未归因违规折叠 → 根因/优先级 → 检查历史。

**og5 实测数字（设计稿与单测的依据）**：3,088 条唯一 SQL / 4,798 万次调用 / 总耗时 57,668 s；一条 `gs_session_memory_detail`
监控轮询占总耗时 45.9%、CPU 66.2%；一条 region/store 聚合占 IO 77.5%；COMMIT 占 DB Time 24.6%；OLTP 四件套各占调用 23.6%。
注意 og-lite 的 `hash_spill_count` 数值不可信（26 亿），下盘维度用 `sort_spill_size + hash_spill_size`（字节）。

**验证**：单测 task-sqlreview 14/14（维度归一化 / 分类 / 表引用 / 多榜去重与占比 / 规则归因 / 一眼结论与阈值覆盖）、
tasks 6/6；rollout.sh 全绿（17 条迁移）。e2e `scripts/e2e-topsql.mjs` **PASS 14/14**：会话说「按执行次数和总耗时分别列出 Top 5」
→ 模型建 sqlreview 任务 `dimensions:["calls","elapsed"]` topN 5 无 cron（不再是 prompt 任务）→ 运行 5m16s 出报告 → 存档 boards=calls/elapsed、
去重 9 条、每条带占比/榜位/ruleRefs、一眼结论 4 条（S6 监控 SQL 占总耗时 46.2% / COMMIT 占 DB Time 24.5% / 3 条 OLTP 短语句 /
上榜合计 96.4%·88.9%）→ 报告 9/9 key 对齐采集 → 无头 Chrome 面板含「资源占比 / 两张榜 / 逐条分析 / 在新会话中深挖」、console 零错误
（截图亲眼核对：状态带、负载卡、两根占比条、图例、一眼结论、两张榜排版与设计稿一致）。
随后用平台 `/opendb tasks/runNow`（与「立即运行」按钮同路）给 user 的 `og5慢SQL Top5报表` 跑了一次三榜报告，分段截图
（`scripts/browser/task-scroll-shots.mjs`，主区是内滚容器，fullPage 截不到下面）发现三处并修：① 计划块最长一行的
min-content 把卡片列撑宽、右栏优化方案/cost 条被裁——卡内 grid 列钉 `minmax(0,1fr)` + 子项 `minWidth:0`；
② IDX004 前缀冗余按索引对两两比较会对同一对象重复产出——展示层按 规则+对象+问题 去重（判定不动）；
③ 「一眼结论」的"上榜合计"只加该榜 Top-N，而占比条加的是全部去重 SQL，两处对不上——改为同口径（全部上榜 SQL）。
热更复核后镜像固化。

**滚动窗口一次误报（2026-08-27 19:25）**：固化 R5 修正的那次 rollout.sh 报「240 次探测非 200 = 28（19:25:48–19:26:17 全是 503）」。
取证：同一时刻 `node/k8s-w1` NodeNotReady（19:25:47 → 19:25:55 恢复），新老 Host pod 都在 k8s-w1，且新 pod 拉镜像时
`lookup host.orb.internal: Try again`（VM 内 DNS 同步抖动）；mac 没睡（caffeinate 常驻）。是 OrbStack 节点抖动叠在滚动窗口上，
不是就绪探针/preStop 失效（同日前两次滚动均 0/240）。自愈后插件包 200、浏览器验收 PASS。rollout.sh 从此在非 200 时顺手打印
同时段节点 NotReady 事件，省得再查一轮。

**深挖交互与监控任务对齐（2026-08-27，user：在会话深挖的功能和 UI 交互与监控任务保持一致）**：Top SQL 卡片底部的大按钮/灰底栏
撤掉，改成与 task-health 完全同款的右下角文字链（`Link`/`DigLink`：12.5px `#4176E6` 无边框；文案三态 `在会话里深挖 →` /
开会话中… / 失败，重试），前面并排「复制 SQL」「复制优化后 SQL」同款链接。行为测试 `scripts/browser/dig-click-check.mjs`
（真实鼠标点击 → 断言链接样式、新建 1 个会话、视图切到会话、首条用户消息以「【Top SQL 深挖】」开头、console 零错误）
第一次就抓到一个真 bug：client 插件 `inject` 只列了 `slots`，`ctx.sessions` 在 apply 时不存在，点击静默失败——补成
`['slots','connection','workspaces','sessions']`（与 task-health 同）后 PASS。教训进 CLAUDE.md 第 6 条。
固化滚动：#2 窗口 1×502（19:38:15，单次，preStop 覆盖不到的瞬时切换）、#3 0/240 ROLLOUT OK。

**S/Q 之分与"各资源耗时、等待事件"补回（2026-08-27 晚，user 两问）**
- S1..Sn = 榜单项（dbe_perf.statement 累计指标、占比、榜位）；Q1..Qn = 任务配置 `sqls` 里贴的**指定 SQL**（无运行指标，只做
  EXPLAIN + 规范）。`og5慢SQL Top3跟踪` 那份里 Q1/Q2 就是 S2/S3 带具体参数的版本（模型把榜单语句又塞进了 sqls）——现在按指纹
  （`fingerprint`：字面量 → ?、小写、压空白）合并进榜单项并标「亦为指定 SQL」；`sqls` 描述改为"只放榜单之外用户贴的 SQL"。
- 旧 prompt 任务报告里的"主导等待事件（DataFileRead / HashAgg build hash / BufFileWrite / WALFlushWait）"来自
  `dbe_perf.statement_history.details`。R5 补回为确定性采集：每条榜单 SQL 取 statement_history 最近 20 次执行
  （`WHERE unique_query_id = X ORDER BY start_time DESC LIMIT 20`，og5 实测 ≈ 30 ms；**不要 GROUP BY 全表**，IN(...) 分组 13.6 s），
  `statement_detail_decode(details,'plaintext',true)` 解析 Wait Events Area → 等待事件 Top（均每次 µs、占比），
  行列 db_time/cpu_time/data_io_time/lock_wait_time/lwlock_wait_time/net_*_info/parse+plan+rewrite → 单次耗时构成（其他 = 差值）。
  OLTP 短语句（UPDATE accounts 等）不在 statement_history（低于慢 SQL 阈值未采样）→ 卡片如实写"未进入采样"。
  og5 `track_stmt_stat_level = L2,L2`，statement_history 8.9 万行 / 52 个 unique_query_id。
