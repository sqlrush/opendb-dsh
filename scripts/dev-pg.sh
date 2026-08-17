#!/usr/bin/env bash
# Start a throwaway PostgreSQL 16 for local development/tests. Prints PG_URL.
set -euo pipefail
docker rm -f opendb-dsh-pg 2>/dev/null || true
docker run -d --name opendb-dsh-pg -e POSTGRES_USER=dsh -e POSTGRES_PASSWORD=dsh -e POSTGRES_DB=dsh -p 5434:5432 postgres:16 >/dev/null
for i in $(seq 1 30); do docker exec opendb-dsh-pg pg_isready -U dsh >/dev/null 2>&1 && break; sleep 1; done
echo "PG_URL=postgres://dsh:dsh@127.0.0.1:5434/dsh"
