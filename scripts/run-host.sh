#!/usr/bin/env bash
# Run the Host profile locally (dsh web UI on 0.0.0.0:3080). Requires: pnpm install && pnpm build; dev PG; DEEPSEEK_API_KEY.
set -euo pipefail
cd "$(dirname "$0")/.."
export DSH_HOME="${DSH_HOME:-$PWD/.dsh-home}"; mkdir -p "$DSH_HOME/profiles"
ln -sfn "$PWD/profiles/host" "$DSH_HOME/profiles/host"
export OPENDB_PG_URL="${OPENDB_PG_URL:-postgres://dsh:dsh@127.0.0.1:5433/dsh}"
export DSH_TELEMETRY_DISABLED=1 DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-read-only}"
exec pnpm exec dsh --profile host "$@"
