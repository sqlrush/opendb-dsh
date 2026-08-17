#!/usr/bin/env bash
# k3s server on the control-plane VM (run with sudo inside the OrbStack machine)
set -euo pipefail
NODE_NAME=${1:-k8s-cp}
IP=${2:-}
export INSTALL_K3S_EXEC="server --node-name ${NODE_NAME} --write-kubeconfig-mode 644 ${IP:+--tls-san ${IP}} --tls-san 127.0.0.1"
curl -sfL https://get.k3s.io | sh -
for i in $(seq 1 60); do k3s kubectl get nodes >/dev/null 2>&1 && break; sleep 2; done
k3s kubectl get nodes -o wide
echo "TOKEN=$(cat /var/lib/rancher/k3s/server/node-token)"
