# Changelog

opendb-harness（仓库 opendb-dsh）的版本记录。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)：0.x 阶段 **minor = 一批功能**、**patch = 修复/打磨**。
产品版本的唯一来源是根 `package.json` 的 `version`（Helm chart 的 `version/appVersion`、UI 角标、镜像标签都由它派生）；
发布流程见 `scripts/release.sh`。

## [Unreleased]

### Fixed
- Host 滚动更新窗口里加载的页面拿不到任务面板插件包，任务页退化成默认历史列表：就绪探针改探插件包 URL（TCP 端口开了不算就绪）、
  `maxUnavailable 0`；兜底视图检测到插件包未加载会自动刷新一次并给出「立即刷新」；插件包已加载却没注册面板（初始化异常）
  时给出明确红条而不是静默退化。
- 新增 `deploy/k8s/rollout.sh`：构建 → 等用户轮次归零 → 滚动 → 自动验收（含无头 Chrome 任务页检查 `scripts/browser/task-panel-check.mjs`）。
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
