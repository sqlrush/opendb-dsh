#!/usr/bin/env bash
# Configure a k3s node to pull from the mac-hosted insecure registry (host.orb.internal:5050). Run with sudo.
set -euo pipefail
ROLE=${1:-agent}   # server | agent
mkdir -p /etc/rancher/k3s
cat > /etc/rancher/k3s/registries.yaml <<'YAML'
mirrors:
  "host.orb.internal:5050":
    endpoint:
      - "http://host.orb.internal:5050"
configs:
  "host.orb.internal:5050":
    tls:
      insecure_skip_verify: true
YAML
if [ "$ROLE" = server ]; then systemctl restart k3s; else systemctl restart k3s-agent; fi
getent hosts host.orb.internal || true
