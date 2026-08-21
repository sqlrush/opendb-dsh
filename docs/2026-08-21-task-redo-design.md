# 任务功能重做 · 三任务设计稿（健康检查 / SQL 审核与优化 / WDR 报告与解读）

> 状态：**user 已定稿**（2026-08-21，"非常好！非常好！"）。UI 原型 `docs/prototypes/task-ui-prototypes.html`（R4），
> 视觉基准 = 原版 dsh 实拍（`prd/` 两张截图）。方法论蓝本 = mac `~/opencode_skill`（health/wdr/sqlreview/sqltune 四 skill）。
> 背景：2026-08-20 user 决定任务功能全部重做，旧任务组 10 插件（tasks/approvals/tool-task-report/tool-task-admin/
> alert-ddl/四任务类型）逐个重审；数据已清场（任务/运行/报告/审批清零，会话每 workspace 留 1）。

## 0. 总纲（继承交互纲领 §15）

- 一切交互尽量在会话完成；主区任务页 = 无按钮结果大盘（registerTaskPanel）；审批签收保留显式控件。
- **确定性归脚本、判断归模型、证据锚定校验门**（opencode_skill 方法论核心，三任务通用）：
  - 采集/规则判定/阈值比较 = TS 确定性代码，产出证据包 + Deterministic Findings
    `{dimension, code, severity(🟢🟡🟠🔴), metric, value, threshold, evidence}`；
  - 模型只做：根因串联、P0/P1/P2 处置排序（与严重度是两个维度）、建议生成、报告成文；
  - **总体状态 = 最差确定性严重度，模型不可降级**——report 提交时机器校验（锚定门），引用数字必须来自证据包；
  - 采集降级如实记入 Collection Notes，该维不产任何结论。

## 1. 报告 schema（三任务通用，灵活 scope）

```
report = {
  scope: 'instance' | 'cluster' | 'sql-set',
  status: worst(deterministic findings),          // 锚定门校验
  target: { node | cluster | sqlSet 描述 },
  findings: [...deterministic + model 串联层],
  children: [ per-instance / per-sql 子报告 ],     // cluster / sql-set 时
  clusterFindings: [...],                          // 仅 cluster：跨实例共性/离群/最差上浮
  collectionNotes: [...], evidenceRef: 'minio://…'
}
```

- 同一插件面板按 scope 自适应渲染：instance=原型①，cluster=原型④（汇总层+逐实例下钻），sql-set=原型②组概览+卡片流。
- 启动方式四路：定时 cron / 会话一句话 / event 告警联动 / 面板重跑。
- **一次性会话运行不落任务实体**（裁决点⑩）：报告照常入库可检索，缩减卡（renderInline，裁决点⑨）内嵌聊天流
  （状态带 + Top3 结果行 + 展开完整报告 + 证据包链接）；user 说「固化成周期任务」才建任务，历史报告自动挂靠。

## 2. 任务一：健康检查（task-health）

- **12 维**（继承 opencode_skill health）：总览/等待/慢SQL/长·空闲事务/膨胀/LWLock/锁链/连接/ckpt·WAL/复制/对象/并发；
  阈值内置（conn 80/90%、cache 99/95%、长事务 5m/30m/2h…），客户规范经知识库对照——参考不改判（KB 契约）。
- 执行流：TS 采集器逐维出证据包 → 模型锚定解读（根因串联，如 XACT_LONG→LOCK_CHAIN→BLOAT 同源）→ 报告 → 签收。
- cluster scope：扇出 N 实例并发采集（runtime 池）→ 跨实例分析层（同时段共性聚类 / 关键参数漂移横向对齐 / 最差实例驱动上浮）。
- UI：状态带+锚定徽章 / 12 维环+矩阵 / 发现卡（证据→根因→建议+风险tag+会话深挖链）/ P0P1P2 / 30 次趋势条+指标曲线 / 签收条。

## 3. 任务二：SQL 审核与优化（task-sqlreview）

- **审核**：rules.yaml 式确定性规则集（TBL/COL/IDX/DML/DDL/DQL 14 条起）三输入源（存量 schema / 线上 sql_id / 会话贴 SQL）；
  规则集可会话调整（"把索引列数上限改成 4"）；客户规范冲突条目（KB-01 类）并列呈现交 user 裁决。
- **优化**（R2 反馈①定稿的完整链路）：原 SQL → 原执行计划（优化点直接标注在计划行上）→ 优化方案
  （hypopg 虚拟索引实证 / 必要时改写）→ 优化后执行计划 → 新旧 cost 对比+降幅。
  **未通过验证的方案绝不呈现为确定优化**（如实标注"无低风险空间"，裁决点⑤）；索引 DDL 一律 [需人工执行]，签收后给执行清单。
- sql-set scope（R2 反馈②）："top5 慢 SQL 扫描优化" → 组概览条（每条状态 chip）+ 逐条完整卡；
  非慢 SQL 根因（如被锁链阻塞）如实转健康检查视角，不硬塞索引建议。
- UI：UGO 式分级计数 / 违规分布环图+规则命中条形 / 可展开违规表 / 组概览 / SQL 卡完整链路。

## 4. 任务三：WDR 报告与解读（task-wdr）

- snaps→collect 窗口 delta 七维：Load Profile / 库级 Stat / Top SQL / 等待 / Checkpoint / Cache / File IO；
- **归因纪律**：temp→spill_MB、CPU→elapsed、IO→physical reads、锁→cpu≈0——Top SQL 表每行归因徽章，元凶不一锅烩；
- 原生 WDR HTML 留底归档（og 官方格式）；**绝不自动开 enable_wdr_snapshot**（要 user 确认）；
- 换窗口在会话里说（时间轴只做可见，不做拖拽）；
- UI：快照时间轴+窗口高亮 / AWS-PI 式 DB Time 负载堆叠条+构成环图 / Load Profile delta 表 / 归因表 / 跨任务链接。

## 5. 裁决点决议（11 条，user 总体认可）

| # | 内容 | 决议 |
|---|------|------|
| ① | 健康环 vs 维度矩阵 | 并存：环=总览，矩阵=下钻导航 |
| ② | 点发现→开会话自动填话 | 要（把用户带回会话主战场） |
| ③ | 30 次历史趋势条 | 要（点格子开当日报告） |
| ④ | 审核+优化同页 | 同页两段 |
| ⑤ | 验证未通过如实展示 | 要（信任来自诚实） |
| ⑥ | AWS-PI 负载堆叠 | 要（堆叠条+环图并存） |
| ⑦ | 跨任务互相引用链接 | 要（三大盘连成诊断故事） |
| ⑧ | 集群级发现层（共性/离群/上浮） | 要（汇总≠钉一起） |
| ⑨ | 缩减卡=插件第二渲染形态 renderInline | 要 |
| ⑩ | 一次性运行不落任务实体 | 要（固化才建任务） |
| ⑪ | 图表轻量自绘 SVG 零依赖 | 要（不引第三方图表库） |

## 6. 视觉基准（R4，原版 dsh 实拍为准）

字体栈 `-apple-system,…,"PingFang SC",…`；主蓝 #4176E6（链接/下划线 tab/发送钮/primary 按钮）；文字 #0F1115/#61666B/#81858C；
**侧栏纯白+浅灰选中 #F2F3F5**；页内 tab=文字+2px 蓝下划线；代码块无边框 #F7F8FA 填充；输入框白底 16px 圆角+浅影；
用户气泡浅灰、助手纯正文流；边框 rgba(0,0,0,.08)；字号 14/12；字重 400/500（数据强调 600）；圆角 8/10/16；语义色只上数据。
教训：控制台实测会被自己插的样式污染——以 `prd/` 原版截图为准。

## 7. 实施顺序

1. **task-health**（先做，含 scope=cluster 扇出与锚定门首践）→ og5 + og-cluster 真实验收
2. task-sqlreview（hypopg 链路 + 规则引擎）
3. task-wdr（snaps/collect/归因 + 原生 HTML 留底）
4. 旧任务组插件逐个重审替换（alert-ddl 事件路接新 TaskType，approvals/tool-task-report 沿用）
