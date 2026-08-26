#!/usr/bin/env bash
# 构建 + 滚动 + 发布后自动验收（在 mac 上跑）。以后一律用它，不再手打 kubectl rollout。
#   deploy/k8s/rollout.sh                 # 全量：构建镜像 → 等运行中的用户轮次归零 → 滚 Runtime+collector+Host → 验收
#   deploy/k8s/rollout.sh --host          # 只滚 Host（纯前端/Host 改动）
#   deploy/k8s/rollout.sh --runtime       # 只滚 Runtime + collector
#   deploy/k8s/rollout.sh --helm ...      # 先 helm upgrade（chart 改了）
#   deploy/k8s/rollout.sh --no-build ...  # 跳过构建（镜像已构建好）
# 验收项（任一失败即非零退出）：迁移台账无失败、各 pod 无 ERR_MODULE_NOT_FOUND、插件包全 200、
#   滚动期间每秒探插件包非 200 次数=0（Host 就绪探针改过之后应恒为 0）、无头 Chrome 任务页是专属大盘且 console 零错误。
set -uo pipefail
cd "$(dirname "$0")/../.."
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.orbstack/bin:$HOME/.local/bin"
NS=opendb-dsh
DO_BUILD=1; DO_HELM=0; TARGETS="opendb-dsh-runtime-default opendb-dsh-runtime-collector opendb-dsh-host"
for a in "$@"; do case "$a" in
  --no-build) DO_BUILD=0 ;; --helm) DO_HELM=1 ;;
  --host) TARGETS="opendb-dsh-host" ;; --runtime) TARGETS="opendb-dsh-runtime-default opendb-dsh-runtime-collector" ;;
  *) echo "未知参数 $a"; exit 2 ;; esac; done
pq() { kubectl -n $NS exec pod/opendb-dsh-postgres-0 -- psql -U dsh -d dsh -Atc "$1"; }
fail=0; note() { echo "  ✖ $1"; fail=1; }

if [ $DO_BUILD -eq 1 ]; then
  echo "## 构建镜像"; bash deploy/k8s/build-image.sh > /tmp/build-image.log 2>&1 || { grep -E "error TS|ERR_" /tmp/build-image.log | head -5; echo "构建失败（/tmp/build-image.log）"; exit 1; }
fi
if [ $DO_HELM -eq 1 ]; then echo "## helm upgrade"; helm upgrade opendb-dsh deploy/charts/opendb-dsh -n $NS | grep -E "STATUS|REVISION"; fi

echo "## 等运行中的用户轮次归零（最多 8 分钟）"
for i in $(seq 1 96); do n=$(pq "SELECT count(*) FROM dsh_threads WHERE status = 'running'"); [ "$n" = "0" ] && break; sleep 5; done
[ "$n" = "0" ] || echo "  ⚠ 仍有 $n 个轮次在跑，Runtime 会用新 id 重投它们"

echo "## 滚动：$TARGETS"
( bad=0; total=0; codes=""; for i in $(seq 1 240); do c=$(curl -s -o /dev/null -m 3 -w "%{http_code}" "http://127.0.0.1:18080/plugins/@opendb-dsh/task-health/client.js"); total=$((total+1)); [ "$c" != "200" ] && { bad=$((bad+1)); codes="$codes $(date +%H:%M:%S)=$c"; }; sleep 1; done; echo "$total $bad$codes" ) > /tmp/rollout-window.txt 2>&1 &
PROBE=$!
for d in $TARGETS; do kubectl -n $NS rollout restart deploy/$d; done
for d in $TARGETS; do kubectl -n $NS rollout status deploy/$d --timeout=600s | tail -1; done

echo "## 验收"
for pod in $(kubectl -n $NS get pods -o name | grep -E "host|runtime"); do
  n=$(kubectl -n $NS logs $pod --all-containers 2>/dev/null | grep -c "migrations\] FAILED\|ERR_MODULE_NOT_FOUND"); [ "$n" = "0" ] || note "$pod 有 $n 条迁移失败/模块缺失"
done
ok=0; for i in $(seq 1 40); do c=$(curl -s -o /dev/null -m 5 -w "%{http_code}" http://127.0.0.1:18080/); if [ "$c" = 200 ]; then ok=$((ok+1)); else ok=0; fi; [ $ok -ge 3 ] && break; sleep 2; done
[ $ok -ge 3 ] || note "入口 18080 未连续 200"
for e in $(curl -s http://127.0.0.1:18080/ | grep -o "/plugins/[^\"]*client.js[^\"]*" | sort -u); do c=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:18080$e"); [ "$c" = 200 ] || note "插件包 $e -> $c"; done
echo "  台账: $(pq "SELECT count(*) FROM opendb_schema_migrations") 条迁移 · pods: $(kubectl -n $NS get pods --no-headers | grep -E "host|runtime" | grep -c Running) Running"
# 等探针循环跑完（最长 4 分钟）再读窗口统计
wait $PROBE 2>/dev/null; read -r total bad codes < /tmp/rollout-window.txt
codes="${codes:-}"   # mac 自带 bash 3.2：多字节字符紧挨着变量展开会被啃坏，这里只用 ASCII
echo "  滚动窗口：$total 次探测，非 200 = $bad${codes:+ ($codes)}"; [ "$bad" = "0" ] || note "滚动期间插件包有 $bad 次非 200——就绪探针/preStop 失效？"
if curl -s -m 3 127.0.0.1:9333/json/version >/dev/null; then
  echo "  浏览器验收（无头 Chrome）："; node scripts/browser/task-panel-check.mjs 2>&1 | grep -v WATCHDOG | sed 's/^/    /' || fail=1
else
  note "无头 Chrome 9333 不在，跳过浏览器验收（见 CLUSTER.md 重拉命令）"
fi
[ $fail -eq 0 ] && echo "ROLLOUT OK" || { echo "ROLLOUT 有验收失败项"; exit 1; }
