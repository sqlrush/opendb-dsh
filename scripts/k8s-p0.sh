#!/usr/bin/env bash
# Build the image, push it to the mac-hosted registry (localhost:5050 → nodes pull host.orb.internal:5050),
# and deploy P0 to the current kube context (opendb-dsh = 4-node k3s on OrbStack VMs).
set -euo pipefail
cd "$(dirname "$0")/.."
REG=${REG:-localhost:5050}
docker build --platform linux/arm64 -t "$REG/opendb-dsh:p0" -f deploy/docker/dsh.Dockerfile .
docker push "$REG/opendb-dsh:p0"
kubectl apply -f deploy/k8s/p0/namespace.yaml
if [ -f deploy/k8s/p0/secret.yaml ]; then kubectl apply -f deploy/k8s/p0/secret.yaml; else echo "WARN: deploy/k8s/p0/secret.yaml missing (copy secret.example.yaml)"; fi
kubectl apply -f deploy/k8s/p0/postgres.yaml -f deploy/k8s/p0/host.yaml -f deploy/k8s/p0/runtime.yaml
kubectl -n opendb-dsh rollout status deploy/host --timeout=300s
kubectl -n opendb-dsh rollout status deploy/runtime --timeout=300s
kubectl -n opendb-dsh get pods -o wide
