#!/usr/bin/env bash
NS=opendb-dsh
sql() { kubectl -n $NS exec postgres-0 -- psql -U dsh -d dsh -tAc "$1"; }
echo "--- threads ---"; sql "select session_id, status, running_pod, heartbeat_at from dsh_threads order by updated_at desc limit 5"
echo "--- queue ---";   sql "select id, left(session_id,20), kind, admitted_by, admitted_at is not null as adm from dsh_thread_queue order by id desc limit 6"
echo "--- questions ---"; sql "select left(session_id,20), answer is not null as answered, created_at, answered_at from dsh_questions order by created_at desc limit 3"
echo "--- last events of latest 2 sessions ---"; sql "select left(session_id,20), seq, type from dsh_session_events where session_id in (select session_id from dsh_threads order by updated_at desc limit 2) order by session_id, seq desc" | head -12
echo "--- runtime pods/logs ---"; kubectl -n $NS get pods -l app=runtime -o wide | tail -3
for p in $(kubectl -n $NS get pods -l app=runtime -o name); do echo "== $p"; kubectl -n $NS logs $p --tail=6 2>/dev/null | cut -c1-200; done
