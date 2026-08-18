#!/usr/bin/env bash
# Throwaway MinIO for local development/tests (S3 on 9002, console on 9003). Prints env for tests.
set -euo pipefail
docker rm -f opendb-dsh-minio 2>/dev/null || true
docker run -d --name opendb-dsh-minio -p 9002:9000 -p 9003:9001 -e MINIO_ROOT_USER=opendb -e MINIO_ROOT_PASSWORD=opendb-minio-dev quay.io/minio/minio:latest server /data --console-address ':9001' >/dev/null
for i in $(seq 1 30); do curl -sf http://127.0.0.1:9002/minio/health/ready >/dev/null && break; sleep 1; done
docker run --rm --network host quay.io/minio/mc:latest sh -c "mc alias set m http://127.0.0.1:9002 opendb opendb-minio-dev >/dev/null && mc mb --ignore-existing m/dsh-test >/dev/null && mc mb --ignore-existing m/opendb-dsh >/dev/null"
echo "S3_ENDPOINT=http://127.0.0.1:9002 S3_BUCKET=dsh-test S3_ACCESS_KEY=opendb S3_SECRET_KEY=opendb-minio-dev"
