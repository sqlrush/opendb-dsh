#!/usr/bin/env bash
# Run the Host profile locally (dsh web UI on 0.0.0.0:3080). Requires: pnpm install && pnpm build; dev PG; DEEPSEEK_API_KEY.
set -euo pipefail
cd "$(dirname "$0")/.."
export DSH_HOME="${DSH_HOME:-$PWD/.dsh-home}"; mkdir -p "$DSH_HOME/profiles"
[ -L "$DSH_HOME/profiles/host" ] || ln -sfn "$PWD/profiles/host" "$DSH_HOME/profiles/host" 2>/dev/null || true
export OPENDB_PG_URL="${OPENDB_PG_URL:-postgres://dsh:dsh@127.0.0.1:5434/dsh}"
export DSH_TELEMETRY_DISABLED=1 DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-read-only}" OPENDB_DEBUG_LOG="${OPENDB_DEBUG_LOG:-/tmp/opendb-dispatch.log}"
export OPENDB_HOST_PORT="${OPENDB_HOST_PORT:-3090}"   # 3080 is often taken by a personal dsh web on the dev machine
exec pnpm exec dsh --profile host "$@"
