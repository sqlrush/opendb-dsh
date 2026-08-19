#!/usr/bin/env bash
# patch lint：cordis.patch.yml 里 insert 的每个 @opendb-dsh/* 包必须出现在对应 bundle 的 dependencies，
# 反之 bundle deps 里的 @opendb-dsh/*（去除工具库）也应至少被一个 patch 引用（防挂空）。
set -euo pipefail
fail=0
for bundle in packages/bundle-host packages/bundle-runtime packages/bundle-collector; do
  [ -f "$bundle/cordis.patch.yml" ] || continue
  pkgs=$(grep -oE "name: '@opendb-dsh/[a-z0-9-]+'" "$bundle/cordis.patch.yml" | cut -d"'" -f2 | sort -u)
  for p in $pkgs; do
    grep -q "\"$p\"" "$bundle/package.json" || { echo "LINT FAIL: $bundle patch 引用 $p 但 package.json 无此依赖"; fail=1; }
  done
done
[ $fail -eq 0 ] && echo "patch wiring OK"
exit $fail
