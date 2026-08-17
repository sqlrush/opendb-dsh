#!/usr/bin/env bash
# k3s agent on a worker VM (run with sudo inside the OrbStack machine)
set -euo pipefail
NODE_NAME=$1; SERVER_IP=$2; TOKEN=$3
export K3S_URL="https://${SERVER_IP}:6443" K3S_TOKEN="${TOKEN}"
export INSTALL_K3S_EXEC="agent --node-name ${NODE_NAME}"
curl -sfL https://get.k3s.io | sh -
