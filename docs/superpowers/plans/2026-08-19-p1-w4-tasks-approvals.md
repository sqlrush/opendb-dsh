# P1 W4：任务插件 + 审批 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans（会话内直接执行）。

**Goal:** 按 G1 冻结契约（设计 §8.5）交付任务引擎、报告签收审批、两个 MVP 任务类型与管理 UI。

**Architecture:** `@opendb-dsh/tasks`（opendbTasks：类型注册 + CRUD + CAS 触发引擎[仅 Host] + task_report 工具[仅 Runtime 有 tools] + 内置 prompt 类型，收编 scheduler）；`@opendb-dsh/approvals`（opendbApprovals：request/decide/list/expire + Provider seam，P1 console=no-op）；类型包 host/runtime 双侧加载（Host 要 buildPrompt，Runtime 要 reportSchema 校验）。

**Spec:** docs/2026-08-16-opendb-dsh-platform-design.md §8.5（G1 冻结稿）。

## Global Constraints
- run 状态机 queued→running→succeeded|failed|timeout 无回退；报告定位 exec.agent.id==sessionId。
- SQL 列名避开保留字：trigger→trigger_kind。
- 审批决定唯一写入口 approvals.decide()；报告签收单由 Host 引擎（单写者）扫描创建。
- 分钟级 cron 测试后必须禁用（烧 token）。

### Task 1: 迁移 006 + @opendb-dsh/approvals
- sql/006_tasks.sql：dsh_tasks/dsh_task_runs/dsh_task_reports/dsh_approvals + dsh_schedules 数据搬迁后 DROP。
- approvals: request/decide(CAS pending)/list/sweepExpired + registerProvider seam。单测：decide CAS、expire。

### Task 2: @opendb-dsh/tasks（契约核心）
- types.ts（冻结接口）、cron.ts（自 scheduler 迁入含测试）、index.ts（注册+CRUD+runNow）、engine.ts（tick：isDue→CAS→开会话；sweep：超时/无报告判定/建审批单）、tool.ts（task_report：schemastery 校验 data，失败报错让模型重交）、prompt-type.ts（内置 prompt 类型，report:optional）。
- 删除 packages/scheduler；bundle-host 的 opendb-scheduler 行替换为 opendb-tasks(engine:true)+opendb-approvals；bundle-runtime 加 opendb-tasks(engine:false)。
- 单测：cron（既有 4 项迁入）、报告校验失败路径、状态机辅助函数。

### Task 3: task-inspection + task-sql-audit
- 各自 configSchema/reportSchema/buildPrompt（巡检：db_overview+metrics_recent+dict_changes 逐节点；审核：db_query 读 dbe_perf.statement Top SQL 反模式）。host/runtime bundle+profile 双侧接线。

### Task 4: ui-opendb 扩展 + 上线验收
- /opendb RPC：tasks/list|create|update|toggle|runNow|types、runs/list、reports/get、approvals/list|decide。
- 设置页新增「任务」「审批箱」两块（列表/新建/run 历史/报告详情/签收驳回）。
- 验收：① runNow 巡检任务→报告落库 severity 正确→审批单出现→RPC 签收→审计字段齐；② sql-audit 同路径；③ cron 触发一次后禁用；④ prompt 类型（原 dsh_schedules 场景）回归。
