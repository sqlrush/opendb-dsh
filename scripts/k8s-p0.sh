#!/usr/bin/env bash
# Build the image and deploy P0 to the current kube context (kind: pass CLUSTER=<name> to load the image).
set -euo pipefail
cd "$(dirname "$0")/.."
docker build -t opendb-dsh:p0 -f deploy/docker/dsh.Dockerfile .
if [ -n "${CLUSTER:-}" ]; then kind load docker-image opendb-dsh:p0 --name "$CLUSTER"; fi
kubectl apply -f deploy/k8s/p0/namespace.yaml
[ -f deploy/k8s/p0/secret.yaml ] && kubectl apply -f deploy/k8s/p0/secret.yaml || echo "WARN: deploy/k8s/p0/secret.yaml missing (copy secret.example.yaml)"
kubectl apply -f deploy/k8s/p0/postgres.yaml -f deploy/k8s/p0/host.yaml -f deploy/k8s/p0/runtime.yaml
kubectl -n opendb-dsh rollout status deploy/host --timeout=180s
kubectl -n opendb-dsh rollout status deploy/runtime --timeout=180s
kubectl -n opendb-dsh get pods -o wide
