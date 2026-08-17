#!/usr/bin/env bash
NS=opendb-dsh; SID_PREFIX=${1:-session-f0109b66}
sql() { kubectl -n $NS exec postgres-0 -- psql -U dsh -d dsh -tAc "$1"; }
sql "select seq, to_timestamp(time/1000.0)::time as t, type, left(data::text,90) from dsh_session_events where session_id like '$SID_PREFIX%' order by seq"
