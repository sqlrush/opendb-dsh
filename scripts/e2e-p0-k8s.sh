#!/usr/bin/env bash
# P0 acceptance on the k8s cluster: relay across two runtime pods.
# Usage: HOST=192.168.139.164 PORT=30080 scripts/e2e-p0-k8s.sh
set -euo pipefail
HOST=${HOST:-192.168.139.164}; PORT=${PORT:-30080}; NS=${NS:-opendb-dsh}
API="http://$HOST:$PORT/api"; ORIGIN="http://$HOST:$PORT"
sql() { kubectl -n "$NS" exec postgres-0 -- psql -U dsh -d dsh -tAc "$1"; }
rpc() { curl -s -m 30 -X POST "$API/$1" -H "content-type: application/json" -H "origin: $ORIGIN" -d "{\"type\":\"client-request\",\"rpcId\":\"e2e-$RANDOM\",\"method\":\"$1\",\"payload\":$2}"; }
SID=$(rpc session.create '{}' | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p'); [ -n "$SID" ] || { echo "session.create failed"; exit 1; }
echo "session=$SID"
rpc session.prompt "{\"sessionId\":\"$SID\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"只回复 OK\"}]}" >/dev/null
for i in $(seq 1 120); do [ "$(sql "select count(*) from dsh_session_events where session_id='$SID' and type='turn/end'")" -ge 1 ] && break; sleep 1; done
POD1=$(sql "select admitted_by from dsh_thread_queue where session_id='$SID' and kind='queued' order by id desc limit 1"); echo "turn1 ran on pod $POD1"
[ -n "$POD1" ] || { echo "turn1 never ran"; exit 1; }
echo "deleting pod $POD1 ..."; kubectl -n "$NS" delete pod "$POD1" --wait=false >/dev/null
sleep 3
rpc session.prompt "{\"sessionId\":\"$SID\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"再回复一次 OK\"}]}" >/dev/null
for i in $(seq 1 120); do [ "$(sql "select count(*) from dsh_session_events where session_id='$SID' and type='turn/end'")" -ge 2 ] && break; sleep 1; done
POD2=$(sql "select admitted_by from dsh_thread_queue where session_id='$SID' and kind='queued' order by id desc limit 1"); echo "turn2 ran on pod $POD2"
if [ -n "$POD2" ] && [ "$POD1" != "$POD2" ]; then echo "RELAY OK"; else echo "RELAY FAILED"; exit 1; fi
sql "select seq, type, left(data::text,80) from dsh_session_events where session_id='$SID' and type in ('assistant/message','turn/end') order by seq"
kubectl -n "$NS" get pods -l app=runtime -o wide
