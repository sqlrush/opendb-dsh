import type { Context } from '@deepseek-ai/cordis';

export const name = 'skill-pg';

/**
 * PG/openGauss 运维 SOP 技能包（P2 W2）：经 dsh skills 注册表注册 runtime skill——
 * 模型按需加载指令体（skill body = markdown SOP），把平台工具（db_query/metrics_recent/
 * dict_changes/metrics_fleet_overview）串成标准排查路径。
 * 注册用 function plugin 顶层 inject 模式（W4 教训：Service 构造器内 inject 静默失效）；
 * skills 服务只在 Runtime（agent 树）存在，Host 侧本插件静默不激活。
 */
const SKILLS: { name: string; description: string; content: string }[] = [
  {
    name: 'og-slow-query-triage',
    description: '慢查询排查 SOP：从 dbe_perf 语句视图定位 Top 慢 SQL，判读等待事件与执行计划方向',
    content: [
      '# 慢查询排查（openGauss）',
      '',
      '## 路径',
      '1. `db_overview` 看 Top SQL 与等待事件概况；',
      '2. `db_query`：`SELECT unique_sql_id, n_calls, total_elapse_time/greatest(n_calls,1) AS avg_us, left(query,120) FROM dbe_perf.statement ORDER BY total_elapse_time DESC LIMIT 10;`',
      '3. 对可疑语句看等待构成：`SELECT * FROM dbe_perf.wait_events ORDER BY total_wait_time DESC LIMIT 10;`',
      '4. 用 `metrics_recent` 对照该节点 db.sessions.active 时间线，确认慢查询是否伴随会话堆积。',
      '',
      '## 判读要点',
      '- avg 耗时高但 n_calls 低 → 单次重查询（关注扫描行数与计划）；n_calls 高 → 高频小查询（关注缓存命中/索引）。',
      '- 等待事件以 IO 类为主 → 存储/缓冲区方向；以 lock 类为主 → 转锁排查 SOP（og-lock-diagnosis）。',
      '- 报告时给出：语句指纹、平均耗时、调用次数、主导等待事件、下一步建议（只建议不执行）。',
    ].join('\n'),
  },
  {
    name: 'og-lock-diagnosis',
    description: '锁等待/阻塞链排查 SOP：从 waiting_locks 指标到 pg_locks 阻塞树定位持锁者',
    content: [
      '# 锁等待排查（openGauss）',
      '',
      '## 路径',
      '1. `metrics_recent` 看 db.waiting_locks 时间线（何时开始、是否持续攀升）；',
      '2. `db_query`：`SELECT w.pid AS waiter, l.pid AS holder, w.query AS waiter_query FROM pg_locks wl JOIN pg_locks l ON wl.locktype=l.locktype AND wl.relation IS NOT DISTINCT FROM l.relation AND l.granted JOIN pg_stat_activity w ON w.pid=wl.pid JOIN pg_stat_activity h ON h.pid=l.pid WHERE NOT wl.granted;`',
      '3. 找到根持锁者后看它在做什么、跑了多久（pg_stat_activity.query_start）。',
      '',
      '## 判读要点',
      '- 根持锁者 state=idle in transaction → 应用忘提交（最常见），建议：业务侧提交/回滚；平台侧可建议 DBA 评估 kill（本平台动作能力未开放，只建议）。',
      '- 阻塞链短且瞬时 → 正常争用；链长且 waiter 持续增加 → 事故级，报告 severity=critical。',
    ].join('\n'),
  },
  {
    name: 'og-capacity-review',
    description: '容量与连接水位评估 SOP：连接使用率、库大小趋势、会话构成的健康判读',
    content: [
      '# 容量与连接水位评估（openGauss）',
      '',
      '## 路径',
      '1. 节点多时先 `metrics_fleet_overview` 拿全舰队水位与异常榜；单节点用 `metrics_recent`；',
      '2. 连接：db.connections_used_ratio 时间线（>0.7 关注，>0.9 危险）；构成看 db.sessions.active/idle 比例；',
      '3. 空间：db.size_bytes.* 各库大小；`db_query` 查 Top 表：`SELECT relname, pg_total_relation_size(oid) FROM pg_class WHERE relkind='r' ORDER BY 2 DESC LIMIT 10;`',
      '',
      '## 判读要点',
      '- idle 会话占比高且连接率高 → 连接池配置问题（建议收紧应用池），不是容量问题。',
      '- 库大小短期陡增 → 结合 dict_changes 看是否新表/新索引导致；持续线性增长 → 正常业务，给出到达阈值的预估时间。',
    ].join('\n'),
  },
  {
    name: 'og-ddl-change-audit',
    description: 'DDL 变更审计 SOP：从字典变更流判定预期内外、评估影响面并出具审计结论',
    content: [
      '# DDL 变更审计（openGauss）',
      '',
      '## 路径',
      '1. `dict_changes` 取窗口内全部结构变更（表/索引/视图/函数/序列的 added/removed/altered）；',
      '2. 判定性质：命名含 tmp/bak/test/drill、空表、非业务 schema → 大概率预期内；业务表被 removed/altered、索引被删 → 可疑；',
      '3. 可疑项用 `db_query` 追影响：对象大小、依赖（pg_depend）、变更前后 `metrics_recent` 指标异动；',
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
