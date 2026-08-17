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
