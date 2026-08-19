#!/usr/bin/env bash
# 镜像构建防呆：Dockerfile 只 COPY lib/，改动任何包都必须先全量编译再 bake。
# 教训（2026-08-19）：漏 build db 包 → 镜像带旧 lib → 950 节点钻取认证失败（'*' 回退没生效）。
set -euo pipefail
cd "$(dirname "$0")/../.."
pnpm -r --filter './packages/*' build
docker build --platform linux/arm64 -q -t localhost:5050/opendb-dsh:dev -f deploy/docker/dsh.Dockerfile .
docker push -q localhost:5050/opendb-dsh:dev
echo "image built & pushed: localhost:5050/opendb-dsh:dev"
