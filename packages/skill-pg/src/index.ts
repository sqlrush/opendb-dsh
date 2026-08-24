import type { Context } from '@deepseek-ai/cordis';

export const name = 'skill-pg';

/**
 * PG/openGauss 运维 SOP 技能包（P2 W2）：经 dsh skills 注册表注册 runtime skill——
 * 模型按需加载指令体（skill body = markdown SOP），把平台工具（db_query/metrics_recent/
 * dict_changes/metrics_fleet_overview）串成标准排查路径。
 * 注册用 function plugin 顶层 inject 模式（W4 教训：Service 构造器内 inject 静默失效）；
 * skills 服务只在 Runtime（agent 树）存在，Host 侧本插件静默不激活。
 */
// 每个技能必须带 source: 'runtime'（dsh-skill 加载器校验 source 为 string——缺失时模型 invoke 报
// "source must be a string"，注册端 validateRuntimeSkill 却不查，实测踩坑）
const SKILLS: { name: string; description: string; content: string; source: string }[] = [
  {
    source: 'runtime',
    name: 'og-slow-query-triage',
    description: '慢查询排查 SOP：一次 sqlreview_collect 拿全 Top 慢 SQL + 执行计划 + 规则违规，再解读',
    content: [
      '# 慢查询排查（openGauss）',
      '',
      '## 路径（先用确定性工具，不要手写探索 SQL）',
      '1. **`sqlreview_collect`（node，可选 topN，默认 5）——第一步就调它**。它一次返回：',
      '   Top-N 慢 SQL（含 sql_id/文本/调用次数/均耗时）、每条的 EXPLAIN 执行计划与总 cost、',
      '   脚本标注的计划优化点（全表扫/下盘）、12 条审核规则的违规清单、hypopg 可用性。',
      '   **这一次调用就覆盖了从前要手写 5~9 条 dbe_perf/pg_class 查询才能得到的全部信息。**',
      '2. 只有工具明确取不到（如 plan-unavailable、权限不足）或需要追额外证据时，才用 `db_query` 补一两条；',
      '3. 需要节点整体健康背景时用 `health_collect`（12 维一次给全），不要用 db_overview + metrics_recent 拼。',
      '',
      '## 判读要点',
      '- attr/归因看工具给的字段：spill>0=temp 溢出型；cpu 占比高=CPU 型；物理读高=IO 型；耗时高而 cpu≈0=等待/锁型（转 og-lock-diagnosis）。',
      '- 优化建议必须走验证阶梯：改写类要用 `db_query` 执行 `EXPLAIN <新SQL>` 拿到新 cost 才算 explain-verified；',
      '  索引类无 hypopg 时只能标 estimated；没有低风险空间就如实写 no-gain——**不许把未验证的方案说成确定优化**。',
      '- 报告给出：sql_id、均耗时、调用次数、归因、原/新 cost 与降幅、建议（只建议不执行）。',
    ].join('\n'),
  },
  {
    source: 'runtime',
    name: 'og-lock-diagnosis',
    description: '锁等待/阻塞链排查 SOP：从 waiting_locks 指标到 pg_locks 阻塞树定位持锁者',
    content: [
      '# 锁等待排查（openGauss）',
      '',
      '## 路径（先用确定性工具）',
      '1. **`health_collect`（node）——第一步就调它**：12 维里的 lockchain 维直接给出阻塞会话数、',
      '   waiter↔holder 边、最长等待时长；xact 维给出长事务/空闲事务（最常见的根持锁者）。',
      '2. 只在需要看根持锁者「此刻在跑什么」时用一条 `db_query` 追 `pg_stat_activity`（query/query_start/state）；',
      '3. 不要手写 pg_locks 自连接——lockchain 维已经算好了。',
      '',
      '## 判读要点',
      '- 根持锁者 state=idle in transaction → 应用忘提交（最常见），建议：业务侧提交/回滚；平台侧可建议 DBA 评估 kill（本平台动作能力未开放，只建议）。',
      '- 阻塞链短且瞬时 → 正常争用；链长且 waiter 持续增加 → 事故级，报告 severity=critical。',
    ].join('\n'),
  },
  {
    source: 'runtime',
    name: 'og-capacity-review',
    description: '容量与连接水位评估 SOP：连接使用率、库大小趋势、会话构成的健康判读',
    content: [
      '# 容量与连接水位评估（openGauss）',
      '',
      '## 路径（先用确定性工具）',
      '1. 单节点：**`health_collect`** 一次给全——connections 维（占用率与阈值判定）、overview 维（各库大小、',
      '   缓存命中）、concurrency 维（活跃会话）、bloat 维（膨胀占用）；节点多时先 `metrics_fleet_overview` 拿异常榜；',
      '2. 需要历史趋势（何时开始爬升）才用 `metrics_recent` 看时间线；',
      '3. 需要 Top 表明细才用一条 `db_query`——不要一上来就手写。',
      '',
      '## 判读要点',
      '- idle 会话占比高且连接率高 → 连接池配置问题（建议收紧应用池），不是容量问题。',
      '- 库大小短期陡增 → 结合 dict_changes 看是否新表/新索引导致；持续线性增长 → 正常业务，给出到达阈值的预估时间。',
    ].join('\n'),
  },
  {
    source: 'runtime',
    name: 'og-ddl-change-audit',
    description: 'DDL 变更审计 SOP：从字典变更流判定预期内外、评估影响面并出具审计结论',
    content: [
      '# DDL 变更审计（openGauss）',
      '',
      '## 路径（先用确定性工具）',
      '1. **`ddl_collect`（node，可选 hours）——第一步就调它**：合并字典变更与节点审计日志，直接给出',
      '   变更时间轴（什么时间/由哪个用户/做过什么变更/DDL 原文）+ 8 条规范规则的扫描结果 + 统计；',
      '2. 只在需要追对象现状/依赖时补一条 `db_query`；不要用 dict_changes 手工拼时间轴（它没有用户归因）；',
      '4. 结论按事故报告结构：findings（每对象一条）+ rootCause 推测 + actions（只建议）。',
      '',
      '## 判读要点',
      '- 同一批变更在多个节点同时出现且间隔规律 → 脚本化批量操作（写进 rootCause）。',
      '- 删除类变更即使影响为零也至少 warn（不可逆操作需要人工确认知情）。',
    ].join('\n'),
  },
];

export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  anyCtx.inject(['skills'], (c: any) => {
    for (const skill of SKILLS) {
      c.effect(() => c.skills.register(skill), `skill-pg.${skill.name}`);
    }
    process.stderr.write(`[skill-pg] registered ${SKILLS.length} ops skills\n`);
  });
}
