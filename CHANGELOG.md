# Changelog

opendb-harness（仓库 opendb-dsh）的版本记录。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)：0.x 阶段 **minor = 一批功能**、**patch = 修复/打磨**。
产品版本的唯一来源是根 `package.json` 的 `version`（Helm chart 的 `version/appVersion`、UI 角标、镜像标签都由它派生）；
发布流程见 `scripts/release.sh`。

## [Unreleased]

### Added
- **容量与增长报告（新任务类型 `capacity`，user 2026-08-31 通过 `docs/prototypes/capacity-r1.html` 后开发）**：回答现在多大、涨多快、
  还能撑多久、空间花在哪。采集器 `capacity_collect`（tool-capacity-collect）一次采齐库 / 表空间 / schema / Top 表大小、死元组与 analyze
  新鲜度、非表占用（WAL、全量 SQL 追踪 statement_history、WDR 快照、pg_log、pg_audit、core）及决定它们大小的 GUC；采样写
  `opendb_capacity_samples`（migration 019）算增速回归（检测清理悬崖只用其后的段）、满盘估算、对象级 24h 增量与采集空窗，首次运行从
  健康采集存档回填库大小序列；字典建/删批次做趋势图事件标注；判定 CAP_*（磁盘 / 增速 / 非表占用 / 系统表膨胀 / 从未 analyze / 死元组 /
  WAL / WDR 保留 / 日志保留 / 采集空窗，阈值可配）由脚本给出；整包存档面板直读，模型只写解读。面板（task-capacity）：摘要 8 卡 →
  增长趋势（chart-kit Line 新增灰带 / 事件标线 / 断线 / 虚线外推）→ 数据目录与库内构成（点行筛选）→ Top 对象 → 非表占用与保留策略
  → Vacuum 与统计信息 → 发现（深挖）→ 解读与优先级 → 检查历史。**两处如实降级**：主机磁盘容量 openGauss 视图不暴露 →
  标"未接入"、不外推满盘；`pg_ls_dir` / `pg_stat_file` 只允许初始账号（omm，SYSADMIN 也不行）→ WAL 改按 checkpoint_segments
  给上限估算、pg_log 说明"只轮转不清理"、非表占用注明不含 WAL/日志，判定不因此误报。验收 `scripts/e2e-capacity.mjs`（og5 20/20）。
- **表结构变更追溯（DDL 报告重构 R2，user 2026-08-30 定稿 `docs/prototypes/ddl-r2.html`）**：平台字典除签名外存下定义原文
  （表 = 列清单 name:type:notnull，索引 = indexdef，视图 = 定义；migration 018，升级后首次快照回填不记变更），变更记录同时存旧/新定义；
  `ddl_collect` 采集前先做一次字典快照，再把字典变更（含定义）、openGauss `pg_object`（建/改时间、创建者）、审计 DDL 原文合成
  **结构历史**：主干版本（相邻一分钟内的 DDL 批次记一版）、schema 与表的生命线（建立分出 / 删除封口、索引事件挂到所属表）、
  每个对象的定义时间线（从当前定义倒推）；整包存档 `opendb_task_collects`。面板：摘要卡 → **结构演进图**（主干 + 分支线，
  点线段看该生命时段里列/索引怎么变、点节点看那次变更原文与来源、schema 可展开表级子线）→ **版本比较**（GitHub compare 式：
  任选两版逐对象 +/−/~ diff，含窗口起点与当前）→ 按日时间轴 → 规范扫描（含通过项、逐条深挖）→ 故事线/优先级。规则 DDLR 与阈值不变。
  报告 schema 只装解读（situation / versionNotes / findings / rootCause / priorities）。collector 健康端口新增 `POST /dict-snapshot`
  （立即快照，验收脚本用）。测试 schema `scripts/lab/ddl-lab`（og5 上五个版本的 DDL 演进）+ e2e `scripts/e2e-ddl.mjs`。
- 字典门扩到**类型与函数**：`::type` / `CAST(… AS type)` 的类型名对照 `pg_type`、函数名对照 `pg_proc`（标准类型与 coalesce 等语法级构造
  不核对，目录不可知放行），不存在时不执行并附 openGauss 等价写法（`regnamespace` → JOIN pg_namespace、`pg_current_wal_lsn` →
  `pg_current_xlog_location` …，`equivalents.ts` 小表，只在确认缺失时附带）；报错兜底新增 42704（类型不存在）并给同样的等价写法。
- **`db_query` 字典门**（user 2026-08-29："补提示词补不完的，让模型先确认字典再写 SQL"）：执行前把 SQL 解析成 AST，按作用域抽出引用的
  表/列，对照目标库真实字典（`pg_class/pg_attribute`，含 `pg_catalog` 视图；按节点缓存 10 分钟）校验——有不存在的表/列时**不执行**，
  直接返回字典单：该关系的真实列与类型、最接近的列名、全库反查"哪些关系有这一列"（`wait_event` → `pg_thread_wait_status` /
  `dbe_perf.thread_wait_status`）、同名关系所在 schema。SQL 正确时只多一次本地解析（≈1 ms）。方言解析不了、列归属不清、目录不可读
  一律放行（fail-open），数据库自己的错误照旧原样返回。新增 `db_describe(relation)`（查一张表/视图的字典）与 `db_find_columns(keyword)`
  （按列名反查关系）两个工具。起因：模型按 PG 印象在 openGauss 的 `pg_stat_activity` 上查 `wait_event`（openGauss 只有 `waiting`），
  连错三次。

### Changed
- 镜像构建 `deploy/k8s/build-image.sh` 改推**纯 v2 manifest**（`--provenance=false --sbom=false`）。起因：buildx 默认推 OCI image index
  （平台清单 + provenance 证明清单），registry:2 的 `garbage-collect --delete-untagged` 不沿 index 标记子清单，2026-08-31 回收本地
  registry 历史 dev 层时把带标签镜像一并清空（dev / v0.1.0 / v0.2.0 已从源码与 git tag 重建推回，运行中 pod 未受影响）。
  经过与回收规则见 `deploy/k8s/CLUSTER.md`「空间清理第二轮 + registry GC 事故」。

## [0.2.0] - 2026-08-29

四个任务报表里的两个（Top SQL、WDR）按 user 定稿的设计稿重做：数字全部由采集器按确定性口径产出并存档，面板直读，模型只写解读；
默认模型切到 Kimi K3；数据库权限改由数据库控制；调度、队列、Runtime 栅栏一批可靠性修复。

### Added
- `deploy/k8s/rollout.sh`：构建 → 等用户轮次归零 → 滚动 → 自动验收（迁移台账 / 模块缺失 / 插件包 200 / 滚动窗口非 200 次数 /
  无头 Chrome 任务页专属面板且 console 零错误），任一项失败即非零退出。
- **WDR 窗口报告（重构 R2，user 2026-08-29 定稿 `docs/prototypes/wdr-r2.html`）**：采集器 `wdr_collect` 改为窗口全景——摘要卡
  （DB Time / AAS / TPS / 命中率 / 物理读 / 临时文件 / WAL / Checkpoint，每张 vs 上一窗口）、最近 24 个快照窗口的 AAS 趋势
  （CPU / IO / 其他等待堆叠，CPU 核数参考线）、DB Time 构成（含 PL）、等待事件按类 + Top10（次数 / 均耗）、AWR 式 Load Profile
  （每秒 / 每事务 / 合计 / 上窗每秒 / 变化）、实例效率（命中率 / CPU 占比 / 回滚率 / p80 p95 / 主机负载）、Top SQL 多维指标
  （总耗时 / CPU / IO / 次数 / 返回行 / 逻辑读 / 下盘，面板按维度切换排序、行展开、连接探针可隐藏、逐条深挖）、IO 与 WAL /
  Checkpoint 与脏页 / 主机三卡、阈值判定含通过项（每条可深挖）、脚本生成的「一眼结论」；整包存档 `opendb_task_collects`
  供面板直读，模型报告只装解读（situation / topSql[].note / findings[].note / rootCause / priorities）。
  等待事件在 SQL 里剔除 STATUS 类并放开行数上限（旧版 maxRows 400 曾把整段截空）；Top SQL 的下盘改为 sort+hash 合计并按字节计
  （旧版漏了 hash_spill 且把字节当 KB）；Top SQL 增量按 end 快照累计耗时前 300 + 累计次数前 100 的 id 精确取 begin 行。
- **Top SQL 报表（慢 SQL 报表重构 R5）**：榜单维度按会话里的要求生成——任务配置 `dimensions`（总耗时 / 执行次数 / 平均耗时 /
  CPU / IO / 逻辑读 / DB Time / 下盘 / 返回行数，默认前三）每个维度各出一榜，同一条 SQL 可上多榜；采集器产出负载总量、
  各榜单占全库比例、去重 Top SQL 明细（指标·占比·榜位·类型判定·执行计划·归到该 SQL 名下的规范违规）与脚本生成的
  「一眼结论」（阈值可在平台阈值配置里调），整包存档 `opendb_task_collects` 供面板直读；模型只做逐条优化解读。
  面板按 `docs/prototypes/sqlreview-r5.html`：资源占比堆叠条 + 榜单 + 逐条分析卡（违规下沉到各条 SQL，不再在顶部汇总），
  「在会话里深挖 →」与监控面板同款文字链，直接建会话发送。`task_create` 说明补充维度参数，避免再退化成 prompt 定时对话。
- 每条 Top SQL 卡片增加**单次耗时构成**（`dbe_perf.statement_history` 最近 20 次执行均值：CPU / IO / 锁等待 / LWLock 等待 /
  网络 / 解析计划 / 其他，100% 条）与**等待事件 Top**（解码 `details`，按累计时间排序、占比）；未进慢 SQL 采样的语句如实标注。
  任务配置 `sqls` 里贴的 SQL 与榜单按指纹（字面量 → ?）合并，同一条不再出现 S/Q 两份。
- **跟踪模式**：会话里说"跟踪这几条 SQL"→ 任务 `sqls` 填原文、`dimensions=[]`，报表只含这几条（到 `dbe_perf.statement`
  按指纹找运行记录，有则指标/占比/榜位/耗时构成/等待事件齐全，无则只做计划与规范），不出榜单；编号统一 S1..Sn，不再有 Q。
  `task_create` 要求模型先判断对话意图：各维度 Top-N 还是跟踪对象，不混填。

### Removed
- Top SQL 报表大盘不再展示规范规则（违反规范列、榜单上的「规范 N」、底部「其他对象的规范发现」全部去掉，采集器默认不跑
  12 条规则；user 2026-08-27：规范与优化方案没关系）。规则引擎保留给规则总览 / 阈值配置；`sqlreview_collect` 传 `rules=true` 可临时附带。

### Fixed
- 字典门误拦系统列：`pg_namespace.oid` / `pg_class.oid` 等系统列在 `pg_attribute` 里 attnum < 0，按 `attnum > 0` 取列时被当成不存在，
  一条合法的 `JOIN pg_namespace n ON n.oid = c.relnamespace` 被拦下不执行（2026-08-30 两个会话各撞两次，模型随后改用 og 没有的
  `::regnamespace`）。现在 `oid / ctid / xmin / xmax / cmin / cmax / tableoid / xc_node_id` 对任何基表视为存在。
- 任务运行遇到模型调用失败（如 DeepSeek 402 余额不足）时，运行记录直接写明真实原因（「模型调用失败：模型服务余额不足…充值后自动恢复」），
  不再显示误导性的「未提交报告（已催交一次）」；该任务 30 分钟内不再按 cron 开新会话（避免每 5 分钟开一个只会失败的会话），
  30 分钟后自动重试，或点「立即运行」。
- 调度不再"追赶"错过的 cron 槽位、不再与手动运行并排跑第二轮：跳过的槽位同样推进 `last_fired_at`；同一任务上一轮还在跑时
  不叠加开新轮；"模型服务失败"守卫只看已结束的运行（此前点一次「立即运行」会让被压着的 cron 同一秒补发）。
- 在任务报表 / 数据库 / 资源页点侧栏「新会话」没反应：那是官方侧栏按钮，在聊天区起草新会话但被任务页盖住。现在捕获该点击
  并切回聊天区；任何入口打开新会话（当前会话 id 变化）也会切回。行为测试 `scripts/browser/new-session-from-task.mjs`。
- `db_query` 语句超时从 15s 放到 60s，模型可按语句传 `timeout_ms`（上限 120s）；超时报错改为说明性文字（是平台的线、值多少、
  改用 `pg_class.reltuples` / `TABLESAMPLE` / 累计统计视图）。采集器等仍用 db seam 的 15s。
- 任务面板「已加载但未注册」红条先自动刷新一次（连续发布窗口里加载的页面常见），刷新后仍如此才提示代码 bug；
  判定前等 4s——面板注册常晚于任务页首绘，立刻判故障会把正常页面刷掉（08-28 下午两个任务"刷不出来"即此）。
- `db_query` 报「关系不存在」时顺手查同名表在哪个 schema 并给出应写的全名（模型常把 WDR 快照写成 `dbe_perf.snapshot`，
  实际在 `snapshot.snapshot`）；工具描述补充 WDR 快照位置。
- 归档的任务不再按 cron 触发（一个归档的 `*/10` 定时对话任务曾在无人可见的情况下跑了 3 小时）。
- **同一轮不会再被两台 Runtime 同时执行**：Host 因心跳陈旧重投后，原 Runtime 的心跳现在充当所有权栅栏（线程已不归自己
  → 立即取消本地轮次，不 release / 不重投 / 不算失败）；关机/失败重投只对本 pod 仍持有的队列行生效；心跳异常不再是未处理
  rejection（曾让整个 Runtime 进程退出）；陈旧线从 30s 放宽到 90s（节点/PG 抖动 10–30s 不再误回收）。
- Runtime 轮次活动看门狗（`turnIdleMs`，默认 10 分钟）：会话日志长时间没有新事件（上游模型不出 token）即切断本轮并换 id 重投，
  不再出现一次 LLM 调用挂 55 分钟。
- Host 滚动更新窗口里加载的页面拿不到任务面板插件包，任务页退化成默认历史列表：就绪探针改探插件包 URL（TCP 端口开了不算就绪）、
  `maxUnavailable 0`；兜底视图检测到插件包未加载会自动刷新一次并给出「立即刷新」；插件包已加载却没注册面板（初始化异常）
  时给出明确红条而不是静默退化。
- 排队区只显示尚未被 Runtime 领走的消息：领走即撤下，不再出现「看得见却删不掉（可能已经开始发送）」的 1 秒窗口。
- `db_query` 报「列/表/函数不存在」时附上所引用视图的真实列名与最接近的列名建议（模型常把 openGauss `dbe_perf.wait_events` 的
  `event` 写成 `event_name`），工具描述加 openGauss 常错列名速查。
- CI 自 08-24 起一直红在 patch 依赖 lint：`bundle-host` / `bundle-runtime` 的 package.json 补齐 patch 引用的 7 个 workspace 依赖
  （ui-chart / thresholds-pg / task-thresholds / tool-thresholds / tool-chart）；registry、directory-picker 两个单测在迁移有台账后
  只 DROP 表不会被重建，改为重建 schema（并补 PG15+ 不再默认给的 PUBLIC 权限）。CI 全绿。

### Changed
- 默认模型切到 **Kimi K3**（Kimi Code API，OpenAI 兼容；`llm-pi-ai` 新增 `kimi` 路由，模型 `k3` / `k3-256k`；key 放
  `opendb-dsh-llm` Secret 的 `OPENDB_KIMI_API_KEY`）；DeepSeek 路由保留，模型选择器可切回。
- **数据库权限只由数据库控制**（user 2026-08-27 定）：平台插件不再过滤 SQL——`db_query` 的只读门（语句白名单 / 危险函数表 /
  单语句限制）与 db seam 启动包里的 `default_transaction_read_only=on` 一并拆除；平台账号能做什么，以它在各节点上的
  数据库授权为准，被拒时原样返回数据库错误。多语句文本按 psql 语义返回最后一条的结果。
  og5 实验库同步把 `opendb_ro` 提为 SYSADMIN（WLM 实时视图 `global_statement_complex_runtime` 等 5 个函数只认 SYSADMIN）。
- Host 预览阶段固定 1 副本；跨副本状态一律经 `host-fanout`（PG NOTIFY）同步。

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

[Unreleased]: https://github.com/sqlrush/opendb-dsh/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/sqlrush/opendb-dsh/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sqlrush/opendb-dsh/releases/tag/v0.1.0
