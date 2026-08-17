#!/usr/bin/env bash
# Run the mux frame capture from inside a runtime pod against the host Service (bypasses NodePort).
set -u
NS=opendb-dsh
P=$(kubectl -n $NS get pod -l app=runtime -o 'jsonpath={.items[0].metadata.name}')
kubectl -n $NS cp /Users/sqlrush/opendb-k8s/ws-frames.mjs $P:/tmp/ws-frames.mjs
kubectl -n $NS exec $P -- env OPENDB_HOST=host OPENDB_HOST_PORT=3080 node /tmp/ws-frames.mjs
