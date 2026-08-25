/**
 * opendb-dsh 平台规则目录（四任务插件的确定性判定层全集）。
 * 数值为快照式手写（client bundle 不能背 server 包），与各实现常量的同步由
 * test/type.test.ts 交叉比对守护（改了 THRESHOLDS 忘改这里 → CI 红）。
 */

export interface RuleRow {
  id: string;
  name: string;
  levels: string;      // 级别阶梯描述，如 "notice≥15% · warn≥30%"
  desc: string;
}

export interface RuleGroup {
  plugin: string;      // 任务类型 key
  title: string;
  source: string;      // 实现位置（代码即真相）
  intro: string;
  rows: RuleRow[];
  notes?: string[];
}

/** 与 task-health/src/collectors.ts THRESHOLDS 同步（单测比对） */
export const HEALTH_T = {
  connRatio: { warn: 0.8, critical: 0.9 },
  cacheHit: { notice: 0.99, warn: 0.95 },
  xactSec: { notice: 300, warn: 1800, critical: 7200 },
  bloatRatio: { notice: 0.15, warn: 0.3 },
  slowAvgMs: { notice: 1000, warn: 3000 },
  blockedSessions: { warn: 1, critical: 5 },
  ckptReqShare: { notice: 0.3, warn: 0.5 },
  waitTopShare: { notice: 0.4 },
  lwlockShare: { notice: 0.2, warn: 0.4 },
  activeSessions: { notice: 50 },
} as const;

/** 与 task-wdr/src/wdr.ts WDR_THRESHOLDS 同步（单测比对） */
export const WDR_T = {
  avgActive: { notice: 2, warn: 5 },
  tempBytes: { notice: 10 * 1024 * 1024, warn: 100 * 1024 * 1024 },
  cacheHit: { notice: 0.99, warn: 0.95 },
  ckptReqShare: { notice: 0.3, warn: 0.5 },
  rollbackRatio: { notice: 0.05, warn: 0.2 },
  blkSqlShare: { warn: 0.3 },
} as const;

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function rulesCatalog(): RuleGroup[] {
  return [
    {
      plugin: 'health',
      title: '健康检查 · 12 维阈值',
      source: 'packages/task-health/src/collectors.ts',
      intro: '12 个确定性采集器逐维出证据包，阈值命中即立 Deterministic Finding；总体状态=最差级别，模型不可下调。',
      rows: [
        { id: 'CONN_HIGH', name: '连接占用', levels: `warn≥${pct(HEALTH_T.connRatio.warn)} · critical≥${pct(HEALTH_T.connRatio.critical)}`, desc: '当前连接数 / max_connections' },
        { id: 'CACHE_LOW', name: '缓存命中率', levels: `notice<${pct(HEALTH_T.cacheHit.notice)} · warn<${pct(HEALTH_T.cacheHit.warn)}`, desc: 'pg_stat_database blks_hit/(hit+read)' },
        { id: 'XACT_LONG / XACT_IDLE', name: '长·空闲事务', levels: `notice≥${HEALTH_T.xactSec.notice}s · warn≥${HEALTH_T.xactSec.warn}s · critical≥${HEALTH_T.xactSec.critical}s`, desc: 'xact_start 起算；idle in transaction 单列 code' },
        { id: 'BLOAT_MID / BLOAT_HIGH', name: '死元组膨胀', levels: `notice≥${pct(HEALTH_T.bloatRatio.notice)} · warn≥${pct(HEALTH_T.bloatRatio.warn)}`, desc: 'n_dead_tup/n_live_tup（live>10000 的表）' },
        { id: 'SLOWSQL / SLOWSQL_MANY', name: '慢 SQL', levels: `notice 均耗时≥${HEALTH_T.slowAvgMs.notice}ms · warn ≥3 条均耗时≥${HEALTH_T.slowAvgMs.warn}ms`, desc: 'dbe_perf.statement 按均耗时' },
        { id: 'LOCK_CHAIN', name: '锁与阻塞链', levels: `warn≥${HEALTH_T.blockedSessions.warn} 会话被阻塞 · critical≥${HEALTH_T.blockedSessions.critical}`, desc: 'pg_locks 未授予锁 join 持有者' },
        { id: 'CKPT_REQ', name: '被动 checkpoint', levels: `notice≥${pct(HEALTH_T.ckptReqShare.notice)} · warn≥${pct(HEALTH_T.ckptReqShare.warn)}`, desc: 'checkpoints_req/(timed+req)' },
        { id: 'WAIT_CONC', name: '等待集中', levels: `notice Top1≥${pct(HEALTH_T.waitTopShare.notice)}`, desc: 'dbe_perf.wait_events Top1 占比' },
        { id: 'LWLOCK_HOT', name: 'LWLock 争用', levels: `notice≥${pct(HEALTH_T.lwlockShare.notice)} · warn≥${pct(HEALTH_T.lwlockShare.warn)}`, desc: 'LWLOCK 类等待占总等待' },
        { id: 'SESS_ACTIVE_HIGH', name: '活跃会话', levels: `notice≥${HEALTH_T.activeSessions.notice}`, desc: "state='active' 计数" },
        { id: 'XACT_PREPARED', name: '悬挂两阶段事务', levels: 'notice>0', desc: 'pg_prepared_xacts' },
        { id: 'REPL_BROKEN', name: '复制异常', levels: 'critical state≠streaming', desc: 'pg_stat_replication；无备机=正常单机' },
        { id: 'IDX_INVALID / IDX_UNUSED', name: '索引健康', levels: 'warn 失效>0 · notice 未用>0', desc: 'indisvalid=false / idx_scan=0（非 PK/唯一）' },
        { id: 'NODE_UNREACHABLE', name: '节点不可达', levels: 'warn', desc: '整机采集失败降级' },
      ],
      notes: ['集群 scope 追加：COMMON_*（同 code ≥半数实例）、SET_DRIFT（关键参数漂移）、WORST_INSTANCE（最差上浮）'],
    },
    {
      plugin: 'sqlreview',
      title: 'SQL 审核 · 12 条规则 + 计划标注',
      source: 'packages/task-sqlreview/src/rules.ts · sqlscan.ts',
      intro: '目录类 7 条查系统目录、文本类 4 条对 Top-N 慢 SQL 正则、计划类 2 条标注 EXPLAIN 行；优化建议走验证阶梯（explain-verified / estimated / no-gain / plan-unavailable）。',
      rows: [
        { id: 'TBL001', name: '大表无主键', levels: 'warn（被慢 SQL 的 UPDATE/DELETE 命中→critical）', desc: '>1 万行且无 PK/唯一键；确定性联动升级' },
        { id: 'TBL002', name: '大表无索引', levels: 'warn', desc: '>10 万行且无任何索引' },
        { id: 'IDX001', name: '失效索引', levels: 'warn', desc: 'indisvalid=false' },
        { id: 'IDX002', name: '索引列过多', levels: 'notice', desc: 'indnatts>5' },
        { id: 'IDX003', name: '完全重复索引', levels: 'warn', desc: '同表同列序' },
        { id: 'IDX004', name: '前缀冗余索引', levels: 'notice', desc: '(a) 被 (a,b) 覆盖' },
        { id: 'IDX005', name: '从未使用索引', levels: 'notice', desc: 'idx_scan=0（非 PK/唯一）' },
        { id: 'COL001', name: '超长 varchar', levels: 'notice', desc: 'varchar(>4000)' },
        { id: 'DML001', name: '无 WHERE 的 UPDATE/DELETE', levels: 'critical', desc: '文本正则' },
        { id: 'DQL001', name: 'SELECT *', levels: 'notice', desc: '全列拉取' },
        { id: 'DQL002', name: '前置模糊 LIKE', levels: 'warn', desc: "LIKE '%…' 无法走索引" },
        { id: 'DQL003', name: 'NOT IN 子查询', levels: 'notice', desc: 'NULL 语义陷阱，建议 NOT EXISTS' },
        { id: 'PLAN_SEQSCAN', name: '计划：全表扫描', levels: 'notice（rows>10 万→warn）', desc: 'EXPLAIN 行内标注' },
        { id: 'PLAN_SPILL', name: '计划：排序/聚合下盘', levels: 'warn', desc: 'Sort Method: external / Disk:' },
      ],
    },
    {
      plugin: 'wdr',
      title: 'WDR 窗口 · 七维阈值 + 归因纪律',
      source: 'packages/task-wdr/src/wdr.ts',
      intro: '窗口 = 既有快照对 delta；阈值判定与 Top SQL 归因全部脚本产出。',
      rows: [
        { id: 'WDR_LOAD_HIGH', name: '平均活跃会话', levels: `notice≥${WDR_T.avgActive.notice} · warn≥${WDR_T.avgActive.warn}`, desc: 'ΔDB_TIME / 窗口时长' },
        { id: 'WDR_TEMP_SPILL', name: '临时文件', levels: `notice≥${WDR_T.tempBytes.notice / 1024 / 1024}MB · warn≥${WDR_T.tempBytes.warn / 1024 / 1024}MB`, desc: 'Δtemp_bytes（库级）' },
        { id: 'WDR_CACHE_LOW', name: '窗口命中率', levels: `notice<${pct(WDR_T.cacheHit.notice)} · warn<${pct(WDR_T.cacheHit.warn)}`, desc: '窗口内 blks delta' },
        { id: 'WDR_CKPT_REQ', name: '被动 checkpoint', levels: `notice≥${pct(WDR_T.ckptReqShare.notice)} · warn≥${pct(WDR_T.ckptReqShare.warn)}`, desc: '窗口 delta' },
        { id: 'WDR_DEADLOCK', name: '死锁', levels: 'warn>0', desc: 'Δdeadlocks' },
        { id: 'WDR_ROLLBACK_HIGH', name: '回滚率', levels: `notice≥${pct(WDR_T.rollbackRatio.notice)} · warn≥${pct(WDR_T.rollbackRatio.warn)}`, desc: '窗口事务数>100 时' },
        { id: 'WDR_SQL_BLOCKED', name: '锁等待型 SQL 主导', levels: `warn 占窗口耗时≥${pct(WDR_T.blkSqlShare.warn)}`, desc: 'attr=blk 的 Top SQL 份额' },
        { id: '归因纪律', name: 'Top SQL attr 徽章', levels: '脚本判定 · 模型不可改', desc: 'tmp=下盘>0 · cpu=cpu/elapsed≥50% · io=io/elapsed≥30% · blk=elapsed>1s 且 cpu/io 双<5%' },
      ],
      notes: ['等待事件剔除 STATUS 空闲类（wait cmd 等归因噪声）', '只消费既有快照：绝不 create_wdr_snapshot / 不碰 GUC'],
    },
    {
      plugin: 'ddl',
      title: 'DDL 追溯 · 规范扫描 + 时间轴参数',
      source: 'packages/task-ddl/src/ddl.ts',
      intro: '三源阶梯（字典变更 / 审计日志 / dbe_perf）合并时间轴；规范规则对时间轴条目扫描。',
      rows: [
        { id: 'DDLR00', name: 'DROP SCHEMA', levels: 'critical', desc: '整模式删除' },
        { id: 'DDLR01', name: '表被删除', levels: 'warn', desc: 'DROP TABLE / 字典 removed' },
        { id: 'DDLR02', name: 'TRUNCATE', levels: 'warn', desc: '清空表' },
        { id: 'DDLR03', name: 'DROP COLUMN/CONSTRAINT', levels: 'warn', desc: '破坏性结构变更' },
        { id: 'DDLR04', name: '业务时段变更', levels: 'notice', desc: '北京 09:00-20:00 的删除/变更类 DDL' },
        { id: 'DDLR05', name: '变更抖动', levels: 'warn', desc: '同一对象 24h 内 ≥3 次变更' },
        { id: 'DDLR07', name: 'DROP 无 IF EXISTS', levels: 'notice', desc: '脚本不幂等' },
        { id: 'DDLR90', name: '归因缺失', levels: 'notice', desc: '审计查询权限缺失——可观测性缺口本身是发现' },
        { id: '时间轴参数', name: '合并与折叠', levels: '—', desc: '审计条目按对象名 ±15 分钟吸附字典条目；同刻 >30 条折叠为「批量登记」' },
      ],
    },
  ];
}

/** 会话简易版：markdown 输出（rules_catalog 工具用） */
export function catalogMarkdown(pluginFilter?: string): string {
  const groups = rulesCatalog().filter((g) => pluginFilter === undefined || pluginFilter === '' || g.plugin === pluginFilter);
  const out: string[] = ['# opendb-dsh 平台规则目录（确定性判定层，级别不可被模型下调）', ''];
  for (const g of groups) {
    out.push(`## ${g.title}（\`${g.plugin}\`）`, g.intro, '', '| 规则 | 名称 | 级别阶梯 | 说明 |', '|---|---|---|---|');
    for (const r of g.rows) out.push(`| \`${r.id}\` | ${r.name} | ${r.levels} | ${r.desc} |`);
    for (const n of g.notes ?? []) out.push(`> ${n}`);
    out.push(`> 实现：\`${g.source}\``, '');
  }
  out.push('（本目录的阈值数字是代码默认值；当前生效值与改动记录用 threshold_list 查看，会话里可直接改——见「阈值配置」插件）');
  return out.join('\n');
}
