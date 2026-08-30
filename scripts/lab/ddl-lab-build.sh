#!/usr/bin/env bash
# 在 og5 上搭建 ddl_lab 测试 schema（表结构变更追溯 R2 的专用用例），每一步之后让平台字典立刻快照。
#   bash scripts/lab/ddl-lab-build.sh          # v1..v5 全部
#   bash scripts/lab/ddl-lab-build.sh 3        # 只跑到 v3
#   bash scripts/lab/ddl-lab-build.sh clean    # DROP SCHEMA ddl_lab CASCADE（同样会被字典记为一次删除批次）
# 依赖（mac）：/tmp/og5-as-ro.sh <sql文件>（以 opendb_ro 连 og5，密码只在 k8s Secret，脚本不回显）、kubectl（可用 /tmp/kbin 包装）。
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="/tmp/kbin:$PATH:/opt/homebrew/bin:/usr/local/bin"
RUNNER="${OG5_SQL_RUNNER:-/tmp/og5-as-ro.sh}"
NS=opendb-dsh
STEP_SLEEP="${STEP_SLEEP:-20}"   # 每步之间等几秒再快照（让 pg_object.mtime 与快照时间错开，便于看清先后）

# opendb_ro 是 SYSADMIN 但角色级 default_transaction_read_only=on（数据库侧的只读控制）：本会话显式关掉再跑 DDL
run_sql() { { printf 'SET default_transaction_read_only = off;\n'; cat "$1"; } > /tmp/ddl-lab-step.sql; bash "$RUNNER" /tmp/ddl-lab-step.sql 2>&1 | grep -vE "^total time|^Time:|^\s*$|^SET$" || true; }
snapshot() {
  local pod; pod=$(kubectl -n $NS get pods -l app.kubernetes.io/component=runtime-collector -o name 2>/dev/null | head -1)
  [ -z "$pod" ] && pod=$(kubectl -n $NS get pods -o name | grep runtime-collector | head -1)
  kubectl -n $NS exec "$pod" -c runtime -- node -e "fetch('http://127.0.0.1:9090/dict-snapshot?node=og5',{method:'POST'}).then(r=>r.text()).then(t=>{console.log('snapshot',t)})" 2>/dev/null \
    || kubectl -n $NS exec "$pod" -- node -e "fetch('http://127.0.0.1:9090/dict-snapshot?node=og5',{method:'POST'}).then(r=>r.text()).then(t=>{console.log('snapshot',t)})"
}

if [ "${1:-}" = "clean" ]; then
  printf 'DROP SCHEMA IF EXISTS ddl_lab CASCADE;\n' > /tmp/ddl-lab-clean.sql
  run_sql /tmp/ddl-lab-clean.sql; snapshot; echo "ddl_lab 已清理"; exit 0
fi
LAST="${1:-5}"
for i in $(seq 1 "$LAST"); do
  echo "## v$i $(date +%H:%M:%S)"
  run_sql "scripts/lab/ddl-lab/v$i.sql"
  sleep "$STEP_SLEEP"
  snapshot
done
echo "ddl_lab v1..v$LAST 完成"
