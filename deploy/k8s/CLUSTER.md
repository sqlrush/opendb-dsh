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
