# opendb-harness 项目工作规范

产品名 **opendb-harness**（仓库名保持 opendb-dsh）。基于 DeepSeek Harness (dsh rc.6) 二次开发的
数据库集群自动化管理平台。设计文档 `docs/2026-08-16-opendb-dsh-platform-design.md`（交互纲领见 §15）、
路线图 `docs/ROADMAP.md`、集群手册与事故复盘 `deploy/k8s/CLUSTER.md`。

## 版本管理（user 2026-08-26 定，从 v0.1.0 起）

- 产品版本唯一来源 = 根 `package.json` 的 `version`；chart `version/appVersion`、欢迎页角标「opendb-harness vX.Y.Z」、
  镜像标签 `opendb-dsh:vX.Y.Z` 都由它派生。子包版本不管（内部 workspace 包）。
- 语义化版本，0.x 阶段：**minor = 一批功能**，**patch = 修复/打磨**。每次发布 `CHANGELOG.md` 必须先有 `## [X.Y.Z]` 段
  （Keep a Changelog 格式：Added / Changed / Fixed），日常提交把要点写进 `## [Unreleased]`。
- 发布只走 `scripts/release.sh X.Y.Z`（在 mac 上跑）：校验干净的 main → 改版本号 → `chore(release): vX.Y.Z` → tag → push →
  镜像加打 `vX.Y.Z` 标签 → 用 CHANGELOG 段落建 GitHub Release。禁止手工打 tag。
- 日常滚动仍用 `dev` 镜像；要把集群固定到某个版本：`helm upgrade … --set image.tag=vX.Y.Z`。

## 代码编辑纪律

- **禁止用 sed/perl 批量替换含特殊字符的代码**（样式模板串、正则、含 `$`/`#`/引号嵌套的行）。
  实际事故：perl 替换把 `${T.border}` 吃掉，`border: 1px solid ` 空颜色渲染成黑线上线。
  这类改动一律用精确编辑工具（Edit，唯一匹配整块替换），改完必须 grep 复核结果。
- sed 只用于简单、无特殊字符的单行替换；替换后必须验证命中数。

## UI/前端开发流程（铁律）

1. 改 client 代码 → `pnpm --filter @opendb-dsh/ui-harness build`
2. **热更**（10 秒通道，dsh 每请求读盘）：
   `kubectl -n opendb-dsh cp packages/ui-harness/lib/client.js <host-pod>:/app/packages/ui-harness/lib/client.js -c host`
3. **浏览器级自验后才能交付**：mac 上 headless Chrome + puppeteer-core（脚本在 mac `/tmp/puppw/`，
   交互类改动必须跑行为测试（verify-hover.mjs 模式：真实鼠标轨迹断言 hover/点击/残留），不能只截图；
   CDP 端口 9333），检查 DOM 关键词 + console 零错误 + **截图 scp 回来亲眼看**（`Read` 图片）。
   一次性 `--dump-dom` 会被 SPA 的 WS 挂住，不可用。
4. 热更后必须跟一次镜像构建固化，否则 pod 重启回退。
5. 前端曾因 innerHTML 改 React 管理的 DOM 整页白屏：**绝不直接改官方组件的 DOM**，
   只用纯 CSS 覆盖或自有槽位组件；自研组件一律包 ErrorBoundary。

## 部署与环境要点

- 浏览器访问：`http://localhost:18080/`（mac 上 socat-over-orb 转发，重建命令见 CLUSTER.md；
  8080 被用户的 Cloud CLI Proxy 容器占用，勿用）。
- kubectl server 走 `https://k8s-cp.orb.local:6443`；OrbStack 重启会把 context 切到内置 `orbstack`，
  用 `kubectl config use-context opendb-dsh` 切回。
- 集群网络发疯 → 先 `pmset -g log` 看 mac 是否刚睡醒（合盖睡眠会冻结 VM 且唤醒后不自愈）；
  修复口诀与分层诊断法见 CLUSTER.md。flannel 已固定 host-gw 后端，勿改回 vxlan（OrbStack 对 VM 间
  UDP 有过 40% 丢包事故）。
- dsh 工具注册必须用**独立 function plugin**（顶层 inject 数据服务 + 嵌套仅 inject(['tools'])，
  形状对照 tool-metrics）；在任务插件包内注册工具（apply 里嵌套多依赖数组或单依赖链式 inject）
  实测都静默不生效——2026-08-21 task-health 两轮 e2e 复证，最终拆 tool-health-collect 独立包根治。
  defineTool 的 object 参数必须显式 `additionalProperties`。Runtime 侧改动走镜像 + rollout；仅前端改动走热更。
- 分钟级 cron 任务测试后必须禁用（每次触发都消耗模型 token）。
- **队列/派发纪律（2026-08-25 中毒 Runtime 复盘）**：Host 从不写会话日志（单写者：Runtime 分配 seq，Host 只镜像），
  所以 Host 侧**绝不能用 dsh 真 Inbox**（它会 append `agent/inbox/spliced`）；排队投影走 `QueueInbox`（PG 队列表）。
  用户提问的归属：Host 持有到 `user/message` 落日志为止——Runtime 失败重投（≤3 次）、死信 `failed_at` 由 Host 以
  `agent/error` 报给用户；改队列逻辑必须跑 `scripts/e2e-queue.mjs` 与 `scripts/e2e-queue-outage.mjs`。
  Host Service 无亲和，浏览器的 HTTP 与 WS 可能落在不同 Host 副本：任何"只在收到 RPC 的那台才有"的状态都是 bug
  ——dsh apiproxy 的两条推送流只转发本副本事件，跨副本靠 `host-fanout` 插件（PG NOTIFY 让被触碰的会话在所有副本活起来）；
  预览阶段 Host 定为 1 副本（2026-08-25 user 定），调回多副本前先跑 `/tmp/puppw/cross-pod-probe.mjs`。
- **在 mac 上跑构建/测试的 ssh 命令**：非交互 PATH 缺 `/opt/homebrew/bin`（kubectl/pnpm）与 `/usr/local/bin`（docker），
  且起始目录是 $HOME——命令必须显式 `export PATH` + `cd /Users/sqlrush/dsh-k8s`，并检查 `build-image.sh` 退出码，
  否则会像 2026-08-25 那样拿旧镜像滚动一整轮。此机（Linux VM）没有 node/pnpm/kubectl。
- **滚动一律用 `deploy/k8s/rollout.sh`（2026-08-26 起，禁止手打 kubectl rollout）**：它会构建 → 等运行中的用户轮次归零 →
  滚动 → 自动验收（迁移台账 / 模块缺失 / 插件包 200 / 滚动窗口非 200 次数 / 无头 Chrome 任务页不是默认视图且 console 零错误），
  任一项失败即非零退出。「报告变成历史列表」同一症状出过三次（注册竞态 ×2、滚动窗口 ×1），验收脚本就是为它立的。
- **新建插件包三处缺一不可**：`packages/<pkg>` 本体、`bundle-host/bundle-runtime` 的 cordis.patch.yml 插入行、
  **`profiles/host|runtime/package.json` 的 workspace 依赖**。dsh 从 `/var/lib/dsh/profiles/<profile>/` 解析插件，
  漏第三处 = 镜像能建、pod 启动 `ERR_MODULE_NOT_FOUND` 崩循环（2026-08-24 thresholds 三包实证；
  旧 pod 因 rollout 卡住仍在服务，不会立刻察觉）。加完要 `pnpm install` 更新 lockfile（Docker 用 --frozen-lockfile）。

## 插件纪律

**借鉴成果不得大改（user 2026-08-23 定）**：四个任务插件（health/sqlreview/wdr/ddl）与 skill-pg 的
方法论、SOP 内容、规则集、阈值，均借鉴自 `~/opendb_skill`（原 opencode_skill）与 `~/gh_skill` 两个项目
——**不要对这两个项目的成果做大规模改动**。允许的只是不触碰方法论的健壮性/接口修复（例：EXPLAIN 前
把 `?` 占位符归一化为 NULL）；凡涉及改 SOP 步骤、增删规则、调阈值、改判定语义，先问 user。
（教训：2026-08-23 曾把四份 SOP 改写为"确定性工具优先"以提速，user 要求回滚。）

**确定性数字直读（2026-08-26 健康报告改造）**：任务面板展示的数字一律来自采集器存档（`opendb_health_collects`，
`runs/list` 附带 `collect`），模型报告只贡献叙述（根因/优先级）；新维度 = `COLLECTORS` 加一项 + `measures.ts` 的
`enrichDim` 登记其关键指标/图表数据。图表统一用 `@opendb-dsh/chart-kit`（Bars/Pie/Gauge/Line），不引第三方图表库。

所有功能开发必须落为插件（dsh 核心=万物皆插件）。任务类型=双半边插件（server 注册 TaskType +
client registerTaskPanel）。领域 UI 独立 client 插件；ui-harness/ui-opendb 只做底座。
插件地图与每节点交付清单见 docs/ROADMAP.md §7。

## 交互纲领（产品级，设计 §15）

一切交互尽量在会话完成（task_create/task_update 工具已就位）；主区任务页=无按钮结果大盘
（插件经 registerTaskPanel 注册专属面板）；弹新页面是稀缺品（现仅「新建智能体」）；
**只读定位（2026-08-21）：平台聚焦模型分析+只读展示，不做变更/操作类功能；审批签收链路已整体下线进暂缓池。**
**数据库权限由数据库控制（user 2026-08-27 定）**：平台账号在节点上能做什么，只由该节点的数据库授权决定；
平台插件**不做**SQL 过滤（原 db_query 只读门与 db seam 启动包只读已拆除，勿再加回）。og5 实验库 `opendb_ro` = SYSADMIN
+ 角色级 `default_transaction_read_only=on`（会话可 SET 关掉，这是 DB 侧的选择）。
