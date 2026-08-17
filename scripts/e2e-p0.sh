#!/usr/bin/env bash
# P0 acceptance: relay across two runtimes. Preconditions: dev PG (scripts/dev-pg.sh), host on :3080,
# runtimes A and B started via scripts/run-runtime.sh with OPENDB_POD_NAME=A / B (health ports 9090/9091).
# NOTE: RPC method names/payloads follow dsh-host-apiproxy/lib/types/api/sessions.d.ts (rc.6); re-check on dsh bumps.
set -euo pipefail
cd "$(dirname "$0")/.."
API=${API:-http://127.0.0.1:3080/api}
ORIGIN=${ORIGIN:-http://127.0.0.1:3080}
DSH_HOME="${DSH_HOME:-$PWD/.dsh-home}"
sql() { docker exec -i opendb-dsh-pg psql -U dsh -d dsh -tAc "$1"; }
rpc() { curl -s -X POST "$API/$1" -H "content-type: application/json" -H "origin: $ORIGIN" -d "{\"type\":\"client-request\",\"rpcId\":\"e2e-$RANDOM\",\"method\":\"$1\",\"payload\":$2}"; }

SID=$(rpc session.create '{}' | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p')
[ -n "$SID" ] || { echo "session.create failed"; exit 1; }
echo "session=$SID"
rpc session.prompt "{\"sessionId\":\"$SID\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"只回复 OK\"}]}" >/dev/null
for i in $(seq 1 90); do
  [ "$(sql "select status from dsh_threads where session_id='$SID'")" = idle ] && \
  [ "$(sql "select count(*) from dsh_session_events where session_id='$SID' and type='turn/end'")" -ge 1 ] && break
  sleep 1
done
POD1=$(sql "select admitted_by from dsh_thread_queue where session_id='$SID' and kind='queued' order by id desc limit 1")
echo "turn1 ran on $POD1"
[ -n "$POD1" ] || { echo "turn1 never ran"; exit 1; }
echo "killing $POD1 ..."; kill "$(cat "$DSH_HOME/$POD1.pid")" || true
sleep 2
rpc session.prompt "{\"sessionId\":\"$SID\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"再回复一次 OK\"}]}" >/dev/null
for i in $(seq 1 90); do
  [ "$(sql "select count(*) from dsh_session_events where session_id='$SID' and type='turn/end'")" -ge 2 ] && break
  sleep 1
done
POD2=$(sql "select admitted_by from dsh_thread_queue where session_id='$SID' and kind='queued' order by id desc limit 1")
echo "turn2 ran on $POD2"
if [ "$POD1" != "$POD2" ] && [ -n "$POD2" ]; then echo "RELAY OK"; else echo "RELAY FAILED"; exit 1; fi
sql "select seq, type from dsh_session_events where session_id='$SID' order by seq" | tail -20
