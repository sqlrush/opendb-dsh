#!/usr/bin/env bash
# 2026-09-06 磁盘压力事故：把 k3s 四节点 kubelet 硬驱逐线从默认（nodefs<10% / imagefs<15%）降到 5%（826G 视图 ≈ 41G）。
# 背景：OrbStack 各 VM 共用 mac 数据盘，默认 15% = 124G 保留量被 pgracbench 等大 VM 挤掉后全节点 disk-pressure 污点、postgres 4 小时 Pending。
# 在 mac 上执行：bash deploy/k8s/k3s-eviction-5pct.sh   （auto 分类器不让 Claude 直接改节点 /etc，需 user 在 /permissions 放行或亲自跑；
# 2026-09-06 已在四节点执行过，幂等：已设置的节点会跳过）
# 回退：删掉四节点 /etc/rancher/k3s/config.yaml 里的 kubelet-arg 段，再重启 k3s / k3s-agent。
set -euo pipefail
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.orbstack/bin"
ARG='eviction-hard=memory.available<100Mi,nodefs.available<5%,nodefs.inodesFree<5%,imagefs.available<5%,imagefs.inodesFree<5%'
for n in k8s-cp k8s-w1 k8s-w2 k8s-w3; do
  if orb -m "$n" sudo grep -q eviction-hard /etc/rancher/k3s/config.yaml 2>/dev/null; then echo "$n: 已设置，跳过"; continue; fi
  orb -m "$n" sudo sh -c "mkdir -p /etc/rancher/k3s && printf '%s\n' '# 2026-09-06 磁盘压力事故：OrbStack VM 共用 mac 数据盘，默认 imagefs<15% 即 124G 保留量，降到 5%（见 CLUSTER.md）' 'kubelet-arg:' '  - \"$ARG\"' >> /etc/rancher/k3s/config.yaml"
  echo "== $n /etc/rancher/k3s/config.yaml"; orb -m "$n" sudo cat /etc/rancher/k3s/config.yaml
done
echo "== 重启 k3s（cp）与 k3s-agent（w1-w3）"
orb -m k8s-cp sudo systemctl restart k3s
for n in k8s-w1 k8s-w2 k8s-w3; do orb -m "$n" sudo systemctl restart k3s-agent; done
kubectl config use-context opendb-dsh
for i in $(seq 1 30); do
  bad=$(kubectl get nodes -o jsonpath='{.items[*].spec.taints[*].key}' 2>/dev/null | tr ' ' '\n' | grep -c disk-pressure || true)
  echo "$(date +%T) 带 disk-pressure 污点的节点数 = $bad"; [ "$bad" = "0" ] && break; sleep 10
done
kubectl -n opendb-dsh get pods
echo "污点清了之后：deploy/k8s/rollout.sh --no-build   （dev 镜像 11:11 已含当前代码，别全量重建再吃几十 GB 缓存）"
