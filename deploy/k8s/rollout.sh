#!/usr/bin/env bash
# 构建 + 滚动 + 发布后自动验收（在 mac 上跑）。以后一律用它，不再手打 kubectl rollout。
#   deploy/k8s/rollout.sh                 # 全量：构建镜像 → 等运行中的用户轮次归零 → 滚 Runtime+collector+Host → 验收
#   deploy/k8s/rollout.sh --host          # 只滚 Host（纯前端/Host 改动）
#   deploy/k8s/rollout.sh --runtime       # 只滚 Runtime + collector
#   deploy/k8s/rollout.sh --helm ...      # 先 helm upgrade（chart 改了）
#   deploy/k8s/rollout.sh --no-build ...  # 跳过构建（镜像已构建好）
# 预检（2026-09-06 起）：任一节点带 disk-pressure 污点或 mac 数据盘可用 < OPENDB_MIN_FREE_G（默认 130G）直接拒绝，构建都不做。
# 必须在**活着的 ssh 会话前台**跑：ssh sqlrush@192.168.128.1 '/tmp/in-repo.sh deploy/k8s/rollout.sh …'。
#   nohup 脱离会话后被 launchd 收养的进程连不上 OrbStack VM 网段（kubectl 全部 no route to host / 超时），2026-09-06 一晚六轮
#   都栽在这上面，见 CLUSTER.md「"API 抖动"的真相」。
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
# ---- kubectl 怎么连 API（2026-09-06 一晚三次滚动被它废掉之后定的）----
# mac 打盹/唤醒后 OrbStack 网络重建，k8s-cp.orb.local 的 IPv4 与 IPv6 会**轮流黑洞几分钟**（18:46 v6 no route to host、22:29 v4 000），
# 而且同一秒里交互 shell 的 kubectl 能通、脚本里的却 context deadline exceeded——各进程解析到的地址不同。
# 对策：① 用 dscacheutil 拿到主机名的全部字面量地址，逐个 curl /healthz 挑一个活的，--tls-server-name 让证书仍按主机名校验；
#       ② 每个请求 20s 硬超时（kubectl 默认 0，僵住的 TCP 连接实测挂 81s 不退）；③ 连接类错误换地址重试最多 8 次；
#       ④ 生成临时 kubeconfig 并 export KUBECONFIG，让验收脚本里的 kubectl（hmr-survive-check 的 get pod / cp）也走活地址。
API_HOST=k8s-cp.orb.local
# k3s 证书的 SAN 只有 k8s-cp / kubernetes.* / localhost，没有 k8s-cp.orb.local——按字面量地址连时 SNI 必须给证书里有的名字
API_SNI=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.tls-server-name}' 2>/dev/null); API_SNI=${API_SNI:-k8s-cp}
API_CANDIDATES=$(dscacheutil -q host -a name $API_HOST 2>/dev/null | awk '/^ipv6_address/{print "https://["$2"]:6443"} /^ip_address/{print "https://"$2":6443"}' | sort -u)
API_CANDIDATES="${API_CANDIDATES:+$API_CANDIDATES
}https://$API_HOST:6443"
API_SERVER=""
pick_api() { local s; for s in $API_CANDIDATES; do if curl -sk -m 3 -o /dev/null "$s/healthz"; then API_SERVER=$s; return 0; fi; done; return 1; }
pick_api || { echo "  ✖ API 的每个地址都不通（$(echo $API_CANDIDATES | tr '\n' ' ')）——先看 OrbStack / mac 是否刚睡醒"; exit 1; }
echo "  API 走 $API_SERVER"
CLUSTER_NAME=$(kubectl config view --minify -o jsonpath='{.clusters[0].name}' 2>/dev/null)
if [ -n "$CLUSTER_NAME" ] && kubectl config view --minify --flatten > /tmp/rollout-kubeconfig 2>/dev/null; then
  kubectl --kubeconfig=/tmp/rollout-kubeconfig config set-cluster "$CLUSTER_NAME" --server="$API_SERVER" --tls-server-name=$API_SNI >/dev/null && export KUBECONFIG=/tmp/rollout-kubeconfig
fi
k() {
  local i
  for i in 1 2 3 4 5 6 7 8; do
    kubectl --server="$API_SERVER" --tls-server-name=$API_SNI --request-timeout=20s "$@" 2>/tmp/rollout-k.err && return 0
    grep -qE "Unable to connect|no such host|no route to host|connection refused|TLS handshake timeout|i/o timeout|unable to decode|context deadline exceeded|Client.Timeout|request timed out|connection reset|EOF" /tmp/rollout-k.err || { cat /tmp/rollout-k.err >&2; return 1; }
    [ $i -lt 8 ] && { pick_api || true; sleep 5; }
  done
  cat /tmp/rollout-k.err >&2; return 1
}
pq() { k -n $NS exec pod/opendb-dsh-postgres-0 -- psql -U dsh -d dsh -Atc "$1"; }
fail=0; note() { echo "  ✖ $1"; fail=1; }

# 2026-09-06 磁盘压力事故预检：OrbStack 各 VM 共用 mac 数据盘，kubelet 默认 imagefs.available<15%（826G 视图 ≈124G）
# 就给全部节点打 disk-pressure 污点，新 Pod 全 Pending、旧 Pod 被驱逐。构建本身还会再吃几十 GB 缓存，
# 所以滚动前先看：任一节点带污点，或 mac 数据盘可用 < OPENDB_MIN_FREE_G（默认 130G），直接拒绝——见 CLUSTER.md「全节点 disk-pressure 污点」。
echo "## 预检：节点污点 / mac 数据盘"
taints=$(k get nodes -o jsonpath='{.items[*].spec.taints[*].key}') || { echo "  ✖ kubectl 连不上 API（k8s-cp.orb.local）——先看 OrbStack 状态与上下文（kubectl config use-context opendb-dsh）"; exit 1; }
tainted=$(printf '%s\n' "$taints" | tr ' ' '\n' | grep -c disk-pressure || true)
if [ "${tainted:-0}" != "0" ]; then
  echo "  ✖ $tainted 个节点带 disk-pressure 污点，滚动只会把新 Pod 全挂成 Pending。先腾 mac 数据盘或降 kubelet 驱逐线（CLUSTER.md），再来"
  kubectl get nodes -o custom-columns="N:.metadata.name,DISK:.status.conditions[?(@.type==\"DiskPressure\")].status" | sed 's/^/    /'
  exit 1
fi
MIN_FREE_G=${OPENDB_MIN_FREE_G:-130}
avail_g=$(df -g /System/Volumes/Data 2>/dev/null | awk 'NR==2{print $4}')
if [ -n "${avail_g:-}" ] && [ "$avail_g" -lt "$MIN_FREE_G" ]; then
  echo "  ✖ mac 数据盘仅剩 ${avail_g}G（< ${MIN_FREE_G}G）：kubelet 15% 线 ≈124G，构建再吃缓存就会把集群压进 disk-pressure。先腾空间；已降驱逐线的话用 OPENDB_MIN_FREE_G=60 放宽"
  exit 1
fi
echo "  节点无 disk-pressure 污点 · mac 数据盘可用 ${avail_g:-?}G"

if [ $DO_BUILD -eq 1 ]; then
  echo "## 构建镜像"; bash deploy/k8s/build-image.sh > /tmp/build-image.log 2>&1 || { grep -E "error TS|ERR_" /tmp/build-image.log | head -5; echo "构建失败（/tmp/build-image.log）"; exit 1; }
fi
# --reuse-values：保住 release 里 --set 注入的 lab 值（auth.htpasswd 等）；chart 新增默认值不会合并进来，代码里都要有兜底
if [ $DO_HELM -eq 1 ]; then echo "## helm upgrade"; helm upgrade opendb-dsh deploy/charts/opendb-dsh -n $NS --reuse-values | grep -E "STATUS|REVISION"; fi

echo "## 等运行中的用户轮次归零（最多 8 分钟）"
for i in $(seq 1 96); do n=$(pq "SELECT count(*) FROM dsh_threads WHERE status = 'running'"); [ "$n" = "0" ] && break; sleep 5; done
[ "$n" = "0" ] || echo "  ⚠ 仍有 $n 个轮次在跑，Runtime 会用新 id 重投它们"

echo "## 滚动：$TARGETS"
( bad=0; total=0; codes=""; for i in $(seq 1 240); do c=$(curl -s -o /dev/null -m 3 -w "%{http_code}" "http://127.0.0.1:18080/plugins/@opendb-dsh/task-health/client.js"); total=$((total+1)); [ "$c" != "200" ] && { bad=$((bad+1)); codes="$codes $(date +%H:%M:%S)=$c"; }; sleep 1; done; echo "$total $bad$codes" ) > /tmp/rollout-window.txt 2>&1 &
PROBE=$!
for d in $TARGETS; do k -n $NS rollout restart deploy/$d || note "deploy/$d rollout restart 失败（API 连不上）"; done
# rollout status 的退出码必须看：新 ReplicaSet 起不来时它非零，但旧 Pod 仍在服务，
# 后面的入口/插件包/浏览器验收全都会打到旧 Pod 而误报 PASS（2026-08-31 ui-cluster 缺 apply 实证）。
# 2026-09-06：长 watch 一断（k8s-cp.orb.local IPv6 路由 / OrbStack DNS 抖动）就干等满超时再报"未完成"，三个 Deployment 其实早滚完了。
# 改为每 10s 起一个新 kubectl 进程短探（--timeout=15s），10 分钟内任一次探到 "successfully rolled out" 即成功。
wait_rollout() {
  local d=$1 deadline=$((SECONDS + 600)) out=""
  while [ $SECONDS -lt $deadline ]; do
    out=$(k -n $NS rollout status deploy/$d --timeout=15s 2>&1 | tail -1)
    case "$out" in *"successfully rolled out"*) echo "$out"; return 0 ;; esac
    sleep 10
  done
  echo "$out"; return 1
}
for d in $TARGETS; do
  wait_rollout $d || note "deploy/$d 未完成滚动（新 Pod 未就绪，旧 Pod 仍在服务——下面的验收结果不可信）"
done

echo "## 验收"
# 目标 Deployment 的每个 Pod 都要就绪；崩溃重启（CrashLoopBackOff / 反复重启）一律算失败
# 只看还活着的 Pod：已结束（Succeeded/Failed，例如驱逐后留下的 Completed 尸体）和正在终止（deletionTimestamp 非空）的不算
# ——2026-09-06 一个上午被驱逐留下的 Completed 旧 Pod 让全绿的一轮报了"1 个 Pod 未就绪"。
plist=$(k -n $NS get pods --no-headers -o custom-columns="N:.metadata.name,P:.status.phase,D:.metadata.deletionTimestamp,R:.status.containerStatuses[*].ready,W:.status.containerStatuses[*].state.waiting.reason") || note "取不到 Pod 列表（API 连不上），下面的就绪/崩溃判定不可信"
live=$(printf '%s\n' "$plist" | awk '$2!="Succeeded" && $2!="Failed" && $3=="<none>"')
for d in $TARGETS; do
  bad=$(printf '%s\n' "$live" | grep "^$d-" | grep -cv "true")
  [ "${bad:-0}" = "0" ] || note "deploy/$d 有 $bad 个 Pod 未就绪"
  crash=$(printf '%s\n' "$live" | grep "^$d-" | grep -c "CrashLoopBackOff\|Error")
  [ "${crash:-0}" = "0" ] || note "deploy/$d 有 $crash 个 Pod 在崩溃重启"
done
pnames=$(k -n $NS get pods -o name) || note "取不到 Pod 名单（API 连不上），模块缺失判定不可信"
for pod in $(printf '%s\n' "$pnames" | grep -E "host|runtime"); do
  n=$(k -n $NS logs $pod --all-containers 2>/dev/null | grep -c "migrations\] FAILED\|ERR_MODULE_NOT_FOUND\|invalid plugin, expect function"); [ "$n" = "0" ] || note "$pod 有 $n 条迁移失败/模块缺失/插件形状错误"
done
ok=0; for i in $(seq 1 40); do c=$(curl -s -o /dev/null -m 5 -w "%{http_code}" http://127.0.0.1:18080/); if [ "$c" = 200 ]; then ok=$((ok+1)); else ok=0; fi; [ $ok -ge 3 ] && break; sleep 2; done
[ $ok -ge 3 ] || note "入口 18080 未连续 200"
for e in $(curl -s http://127.0.0.1:18080/ | grep -o "/plugins/[^\"]*client.js[^\"]*" | sort -u); do c=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:18080$e"); [ "$c" = 200 ] || note "插件包 $e -> $c"; done
mig=$(pq "SELECT count(*) FROM opendb_schema_migrations") || note "迁移台账查不到（API/PG 连不上）"
echo "  台账: ${mig:-?} 条迁移 · pods: $(printf '%s\n' "$live" | grep -E "host|runtime" | grep -c true) 就绪"
# 等探针循环跑完（最长 4 分钟）再读窗口统计
wait $PROBE 2>/dev/null; read -r total bad codes < /tmp/rollout-window.txt
codes="${codes:-}"   # mac 自带 bash 3.2：多字节字符紧挨着变量展开会被啃坏，这里只用 ASCII
echo "  滚动窗口：$total 次探测，非 200 = $bad${codes:+ ($codes)}"
if [ "$bad" != "0" ]; then
  note "滚动期间插件包有 $bad 次非 200——就绪探针/preStop 失效？先看下面有没有同时段的节点 NotReady（2026-08-27 一次 28×503 就是 k8s-w1 抖了 10 秒）"
  kubectl get events -A --sort-by=.lastTimestamp 2>/dev/null | grep -E "NodeNotReady|NodeReady|ErrImagePull" | tail -4 | sed 's/^/    /'
fi
if curl -s -m 3 127.0.0.1:9333/json/version >/dev/null; then
  echo "  浏览器验收（无头 Chrome）："; node scripts/browser/task-panel-check.mjs 2>&1 | grep -v WATCHDOG | sed 's/^/    /' || fail=1
  # 2026-09-06 「大盘报表又没了」两次报障后加的两道门：
  #   ① 页面在后端抖动窗口里加载缺插件 → 必须自愈重载（selfheal-check）；② 开着的页签扛住 ui-harness 热更（hmr-survive-check）
  echo "  自愈验收（缺插件自动重载）："; node scripts/browser/selfheal-check.mjs 2>&1 | grep -v WATCHDOG | sed 's/^/    /' || fail=1
  echo "  热更存活验收（注册表不丢）："; node scripts/browser/hmr-survive-check.mjs 2>&1 | grep -v WATCHDOG | sed 's/^/    /' || fail=1
  # 2026-09-06 数据库大盘重构：每节点专属页八段齐全、数字真实、24h↔7d 切换取数、零错误
  echo "  数据库大盘验收："; node scripts/browser/node-panel-check.mjs 2>&1 | grep -v WATCHDOG | sed 's/^/    /' || fail=1
else
  note "无头 Chrome 9333 不在，跳过浏览器验收（见 CLUSTER.md 重拉命令）"
fi
[ $fail -eq 0 ] && echo "ROLLOUT OK" || { echo "ROLLOUT 有验收失败项"; exit 1; }
