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
