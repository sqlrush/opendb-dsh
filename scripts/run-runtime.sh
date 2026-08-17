#!/usr/bin/env bash
# Run one Runtime profile process locally. Set OPENDB_POD_NAME / OPENDB_HEALTH_PORT to run several.
set -euo pipefail
cd "$(dirname "$0")/.."
export DSH_HOME="${DSH_HOME:-$PWD/.dsh-home}"; mkdir -p "$DSH_HOME/profiles"
[ -L "$DSH_HOME/profiles/runtime" ] || ln -sfn "$PWD/profiles/runtime" "$DSH_HOME/profiles/runtime" 2>/dev/null || true
export OPENDB_PG_URL="${OPENDB_PG_URL:-postgres://dsh:dsh@127.0.0.1:5434/dsh}"
export OPENDB_POD_NAME="${OPENDB_POD_NAME:-runtime-$$}" OPENDB_HEALTH_PORT="${OPENDB_HEALTH_PORT:-9090}"
export DSH_TELEMETRY_DISABLED=1 DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-read-only}"
echo $$ > "$DSH_HOME/$OPENDB_POD_NAME.pid"
exec pnpm exec dsh --profile runtime "$@"
