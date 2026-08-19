#!/usr/bin/env bash
# 为 og-node-0..19 各生成一个 NodePort Service（30001..30020）
for i in $(seq 0 19); do
  port=$((30001 + i))
  cat <<YAML
---
apiVersion: v1
kind: Service
metadata: { name: og-node-$i }
spec:
  type: NodePort
  selector: { statefulset.kubernetes.io/pod-name: og-node-$i }
  ports: [{ port: 5432, targetPort: 5432, nodePort: $port }]
YAML
done
