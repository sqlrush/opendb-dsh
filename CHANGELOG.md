# Changelog

opendb-harness（仓库 opendb-dsh）的版本记录。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)：0.x 阶段 **minor = 一批功能**、**patch = 修复/打磨**。
产品版本的唯一来源是根 `package.json` 的 `version`（Helm chart 的 `version/appVersion`、UI 角标、镜像标签都由它派生）；
发布流程见 `scripts/release.sh`。

## [Unreleased]

### Added
- **Top SQL 报表（慢 SQL 报表重构 R5）**：榜单维度按会话里的要求生成——任务配置 `dimensions`（总耗时 / 执行次数 / 平均耗时 /
  CPU / IO / 逻辑读 / DB Time / 下盘 / 返回行数，默认前三）每个维度各出一榜，同一条 SQL 可上多榜；采集器产出负载总量、
  各榜单占全库比例、去重 Top SQL 明细（指标·占比·榜位·类型判定·执行计划·归到该 SQL 名下的规范违规）与脚本生成的
  「一眼结论」（阈值可在平台阈值配置里调），整包存档 `opendb_task_collects` 供面板直读；模型只做逐条优化解读。
  面板按 `docs/prototypes/sqlreview-r5.html`：资源占比堆叠条 + 榜单 + 逐条分析卡（违规下沉到各条 SQL，不再在顶部汇总），
  「在会话里深挖 →」与监控面板同款文字链，直接建会话发送。`task_create` 说明补充维度参数，避免再退化成 prompt 定时对话。
- 每条 Top SQL 卡片增加**单次耗时构成**（`dbe_perf.statement_history` 最近 20 次执行均值：CPU / IO / 锁等待 / LWLock 等待 /
  网络 / 解析计划 / 其他，100% 条）与**等待事件 Top**（解码 `details`，按累计时间排序、占比）；未进慢 SQL 采样的语句如实标注。
  任务配置 `sqls` 里贴的 SQL 与榜单按指纹（字面量 → ?）合并，同一条不再出现 S/Q 两份。

### Fixed
- 归档的任务不再按 cron 触发（一个归档的 `*/10` 定时对话任务曾在无人可见的情况下跑了 3 小时）。

### Changed
- **数据库权限只由数据库控制**（user 2026-08-27 定）：平台插件不再过滤 SQL——`db_query` 的只读门（语句白名单 / 危险函数表 /
  单语句限制）与 db seam 启动包里的 `default_transaction_read_only=on` 一并拆除；平台账号能做什么，以它在各节点上的
  数据库授权为准，被拒时原样返回数据库错误。多语句文本按 psql 语义返回最后一条的结果。
  og5 实验库同步把 `opendb_ro` 提为 SYSADMIN（WLM 实时视图 `global_statement_complex_runtime` 等 5 个函数只认 SYSADMIN）。

### Fixed
- Host 滚动更新窗口里加载的页面拿不到任务面板插件包，任务页退化成默认历史列表：就绪探针改探插件包 URL（TCP 端口开了不算就绪）、
  `maxUnavailable 0`；兜底视图检测到插件包未加载会自动刷新一次并给出「立即刷新」；插件包已加载却没注册面板（初始化异常）
  时给出明确红条而不是静默退化。
- 新增 `deploy/k8s/rollout.sh`：构建 → 等用户轮次归零 → 滚动 → 自动验收（含无头 Chrome 任务页检查 `scripts/browser/task-panel-check.mjs`）。
- 排队区只显示尚未被 Runtime 领走的消息：领走即撤下，不再出现「看得见却删不掉（可能已经开始发送）」的 1 秒窗口。
- `db_query` 报「列/表/函数不存在」时附上所引用视图的真实列名与最接近的列名建议（模型常把 openGauss `dbe_perf.wait_events` 的
  `event` 写成 `event_name`），工具描述加 openGauss 常错列名速查。

## [0.1.0] - 2026-08-26

首个正式编号版本：DeepSeek Harness（dsh rc.6）之上的只读数据库集群分析平台，跑在 k3s（Host + Runtime 池 + PG/Redis/MinIO/Qdrant）。

### Added
- **平台骨架**：Host 派发 + Runtime 接力（PG 队列会合、单写者会话日志、镜像 tail）；多副本 Host 扇出（`host-fanout`）；
  KEDA 按队列深度扩缩 Runtime。
- **工作区 UI**（`ui-harness` / `ui-opendb`）：会话 / 任务 / 数据库三级菜单、归档、任务大盘、资源页；欢迎页品牌化；
  排队消息复用 dsh 原生 queue dock（编辑 / 移除 / 插队）。
- **任务插件**：健康检查（13 维确定性采集 → 面板直读存档，含阈值轨道 / 堆叠条 / 排名条 / 迷你趋势，一键深挖开会话）、
  慢 SQL 优化、WDR 报告、DDL 事故响应、平台阈值配置（会话内确认修改、实时生效）。
- **会话内图表**（`tool-chart` + `ui-chart`）：语义指标目录（TPS / QPS / 缓存命中 / 连接 / CPU / 负载 …）、Δ/Δt 计算、
  阈值线；共用图表原语包 `chart-kit`。
- **指标采集**（collector Runtime，Timescale）：openGauss `dbe_perf` 指标每分钟入库；OS 维度（load / iowait）。
- **记忆与知识**：会话记忆、知识库（pgvector + Qdrant 加速）、agent 预设落库。

### Changed
- 健康检查 SOP / 规则 / 阈值沿用 `opendb_skill` / `gh_skill`；仅做接口与健壮性修正（EXPLAIN 占位符归一化、等待事件排除 STATUS 类）。

### Fixed
- 中毒 Runtime 吞消息（迁移死锁 → 拒绝认领 + 503 熔断 + liveness）；提问无痕（Host 持有提问直到落日志，失败重投 ≤3 次，
  死信红条）；滚动更新切断轮次（SIGTERM 自接，换 id 重投）；跨副本 resume 写坏日志（Host 只读到最后一个 end-seed）；
  新会话草稿置灰无自救入口（禁用态露出原生工作区选择行）。

[Unreleased]: https://github.com/sqlrush/opendb-dsh/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sqlrush/opendb-dsh/releases/tag/v0.1.0
