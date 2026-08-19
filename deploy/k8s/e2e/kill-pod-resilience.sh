#!/usr/bin/env bash
# W6 韧性 e2e：会话运行中杀掉执行它的 runtime pod，断言另一个 pod 接力完成。
# 前置：kubectl context=opendb-dsh；Host 经 http://localhost:18080 可达。
# 用法：bash kill-pod-resilience.sh [sessionId]（缺省新建会话）
set -uo pipefail
NS=opendb-dsh
BASE=http://localhost:18080
WSID=$(kubectl -n $NS exec opendb-dsh-postgres-0 -- psql -U dsh -d dsh -tAc \
  "SELECT key FROM dsh_kv_records WHERE unit='workspace' AND tbl='workspaces' AND value->>'path' LIKE '%/agents/%' LIMIT 1" | tr -d ' ')
api() { curl -s -X POST "$BASE/api/$1" -H content-type:application/json -H "origin: $BASE" \
  -d "{\"type\":\"client-request\",\"rpcId\":\"e2e-$RANDOM\",\"method\":\"$1\",\"payload\":$2}"; }
psq() { kubectl -n $NS exec opendb-dsh-postgres-0 -- psql -U dsh -d dsh -tAc "$1"; }

SID=${1:-}
if [ -z "$SID" ]; then
  SID=$(api session.create "{\"workspaceId\":\"$WSID\"}" | grep -o '"sessionId":"[^"]*"' | cut -d'"' -f4)
fi
echo "session=$SID workspace=$WSID"
api session.prompt "{\"sessionId\":\"$SID\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"请分三步完成并且每步单独输出：1) 用 db_overview 看 og5 概况 2) 用 db_query 查 og5 的 select count(*) from pg_tables 3) 汇总一句话结论。\"}]}" >/dev/null
echo "prompt queued; waiting for a runtime to claim..."

POD=""
for i in $(seq 1 60); do
  POD=$(psq "SELECT running_pod FROM dsh_threads WHERE session_id='$SID' AND status='running'" | tr -d ' ')
  [ -n "$POD" ] && break; sleep 2
done
[ -z "$POD" ] && { echo "FAIL: never claimed"; exit 1; }
echo "claimed by $POD — waiting 10s for the turn to be mid-flight, then killing it"
sleep 10
kubectl -n $NS delete pod "$POD" --grace-period=0 --force >/dev/null 2>&1
echo "killed $POD"

HEIR=""
for i in $(seq 1 90); do
  HEIR=$(psq "SELECT running_pod FROM dsh_threads WHERE session_id='$SID' AND status='running' AND running_pod <> '$POD'" | tr -d ' ')
  [ -n "$HEIR" ] && break; sleep 2
done
if [ -z "$HEIR" ]; then
  ST=$(psq "SELECT status FROM dsh_threads WHERE session_id='$SID'")
  echo "FAIL: no heir claimed within 180s (thread status=$ST)"; exit 1
fi
echo "heir=$HEIR — waiting for completion"

DONE=""
for i in $(seq 1 120); do
  ST=$(psq "SELECT status FROM dsh_threads WHERE session_id='$SID'" | tr -d ' ')
  if [ "$ST" = "idle" ]; then DONE=1; break; fi; sleep 5
done
[ -z "$DONE" ] && { echo "FAIL: session never returned to idle"; exit 1; }

TURNS=$(psq "SELECT count(*) FILTER (WHERE type='turn/start') - count(*) FILTER (WHERE type='turn/end') FROM dsh_session_events WHERE session_id='$SID'" | tr -d ' ')
MSGS=$(psq "SELECT count(*) FROM dsh_session_events WHERE session_id='$SID' AND type='assistant/message'" | tr -d ' ')
QREPLAY=$(psq "SELECT count(*) FROM dsh_thread_queue WHERE session_id='$SID' AND admitted_by='$HEIR'" | tr -d ' ')
echo "turn balance=$TURNS (0=closed) assistant msgs=$MSGS queue rows re-admitted by heir=$QREPLAY"
if [ "$TURNS" = "0" ] && [ "$MSGS" -ge 1 ] && [ "$QREPLAY" -ge 1 ]; then
  echo "PASS: kill-pod resilience — heir=$HEIR completed the turn, queue row replayed"
else
  echo "FAIL: assertions not met"; exit 1
fi
