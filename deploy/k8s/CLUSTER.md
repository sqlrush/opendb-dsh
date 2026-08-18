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
