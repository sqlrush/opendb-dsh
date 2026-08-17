#!/usr/bin/env bash
NS=opendb-dsh; S=${1:-session-53e5bfb4}
sql() { kubectl -n $NS exec postgres-0 -- psql -U dsh -d dsh -tAc "$1"; }
echo "--- queue rows ---"; sql "select id, kind, admitted_by, created_at::time, admitted_at::time from dsh_thread_queue where session_id like '$S%' order by id"
echo "--- events (all types, with time) ---"; sql "select seq, to_timestamp(time/1000.0)::time, type from dsh_session_events where session_id like '$S%' order by seq" | grep -v "assistant/chunk"
echo "--- any agent error-ish data ---"; sql "select seq, left(data::text,300) from dsh_session_events where session_id like '$S%' and (data::text ilike '%error%' or type like '%error%') order by seq" | head -5
