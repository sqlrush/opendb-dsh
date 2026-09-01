/**
 * opendb-dsh 平台规则目录（五个任务插件的确定性判定层全集）。
 * 数值为快照式手写（client bundle 不能背 server 包），与各实现常量的同步由
 * test/type.test.ts 交叉比对守护（改了 THRESHOLDS 忘改这里 → CI 红）。
 *
 * 2026-08-31 R1（user 通过 docs/prototypes/rules-r1.html）：
 *   - 级别阶梯由字符串改成结构化 steps[]，面板按级别上色、markdown 拼回原样；
 *   - 每行补 from（判据来源）与 codes（该行代表的真实规则码，用于和采集存档 / 阈值服务对账）；
 *   - 补上此前漏登记的 OS_LOAD_HIGH / OS_IOWAIT_HIGH（健康，主机维度）与整个容量插件（10 条 CAP_*）。
 */

export type RuleLevel = 'notice' | 'warn' | 'critical' | 'plain';

export interface RuleStep {
  lv: RuleLevel;
  t: string;                 // 阶梯文本，如 "warn ≥80%"
}

export interface RuleRow {
  id: string;                // 展示用规则码（合并行写成 "A / B"）
  codes?: string[];          // 该行代表的真实码；缺省 = [id]。命中统计与目录对账按它匹配
  /** 阈值 spec.rule 的匹配名；缺省 = codes。参数类条目（不产出发现但有可调数字）用它挂阈值 */
  tuneRules?: string[];
  name: string;
  steps: RuleStep[];
  desc: string;
  from: string;              // 判据来源（视图 / 字典 / 计划树 …）
}

export interface RuleGroup {
  plugin: string;            // 任务类型 key
  title: string;
  source: string;            // 实现位置（代码即真相）
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
  loadPerCore: { notice: 0.7, warn: 1.0, critical: 2.0 },
  iowaitShare: { notice: 0.2, warn: 0.4 },
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

/** 与 task-ddl/src/ddl.ts DDL_THRESHOLDS 同步（单测比对） */
export const DDL_T = {
  businessHourStart: 9,
  businessHourEnd: 20,
  churnCount: 3,
  churnWindowHours: 24,
} as const;

const GIB = 1024 ** 3;
/** 与 task-capacity/src/capacity.ts CAP_THRESHOLDS 同步（单测比对） */
export const CAP_T = {
  diskUsed: { notice: 0.8, warn: 0.9 },
  daysToFull: { notice: 90, warn: 30 },
  minGrowthBytesPerDay: 0.1 * GIB,
  nonTableShare: { notice: 0.3, warn: 0.5 },
  sysTableBloat: { minBytes: 4 * GIB, avgRowBytes: 8 * 1024 },
  statsNeverRows: 1_000_000,
  deadRatio: { notice: 0.2, warn: 0.4, minBytes: 1 * GIB },
  walSegFactor: 3,
  wdr: { maxBytes: 10 * GIB, overdueDays: 2 },
  collectGapHours: 24,
  logMaxBytes: 2 * GIB,
} as const;

const pct = (v: number) => `${Math.round(v * 100)}%`;
const gib = (v: number) => `${v / GIB}GiB`;
const st = (lv: RuleLevel, t: string): RuleStep => ({ lv, t });

export function rulesCatalog(): RuleGroup[] {
  return [
    {
      plugin: 'health',
      title: '健康检查 · 逐维阈值判定',
      source: 'packages/task-health/src/collectors.ts',
      intro: '确定性采集器逐维出证据包，阈值命中即立发现；整体状态 = 最差级别，模型不可下调。',
      rows: [
        { id: 'CONN_HIGH', name: '连接占用', from: 'pg_stat_activity · max_connections', desc: '当前连接数 / max_connections',
          steps: [st('warn', `warn ≥${pct(HEALTH_T.connRatio.warn)}`), st('critical', `critical ≥${pct(HEALTH_T.connRatio.critical)}`)] },
        { id: 'CACHE_LOW', name: '缓存命中率', from: 'pg_stat_database', desc: 'blks_hit /（hit + read）',
          steps: [st('notice', `notice <${pct(HEALTH_T.cacheHit.notice)}`), st('warn', `warn <${pct(HEALTH_T.cacheHit.warn)}`)] },
        { id: 'XACT_LONG / XACT_IDLE', codes: ['XACT_LONG', 'XACT_IDLE'], name: '长事务 · 空闲事务', from: 'pg_stat_activity.xact_start',
          desc: '从 xact_start 起算；idle in transaction 单列 code',
          steps: [st('notice', `notice ≥${HEALTH_T.xactSec.notice}s`), st('warn', `warn ≥${HEALTH_T.xactSec.warn}s`), st('critical', `critical ≥${HEALTH_T.xactSec.critical}s`)] },
        { id: 'BLOAT_MID / BLOAT_HIGH', codes: ['BLOAT_MID', 'BLOAT_HIGH'], name: '死元组膨胀', from: 'pg_stat_user_tables',
          desc: 'n_dead_tup /（live + dead），只看活元组 > 1 万的表',
          steps: [st('notice', `notice ≥${pct(HEALTH_T.bloatRatio.notice)}`), st('warn', `warn ≥${pct(HEALTH_T.bloatRatio.warn)}`)] },
        { id: 'SLOWSQL / SLOWSQL_MANY', codes: ['SLOWSQL', 'SLOWSQL_MANY'], name: '慢 SQL', from: 'dbe_perf.statement', desc: '按均耗时取 Top-N',
          steps: [st('notice', `notice 均耗时 ≥${HEALTH_T.slowAvgMs.notice}ms`), st('warn', `warn ≥3 条 ≥${HEALTH_T.slowAvgMs.warn}ms`)] },
        { id: 'LOCK_CHAIN', name: '锁与阻塞链', from: 'pg_locks · pg_stat_activity', desc: '未授予的锁 join 持有者，输出完整阻塞链',
          steps: [st('warn', `warn ≥${HEALTH_T.blockedSessions.warn} 会话被阻塞`), st('critical', `critical ≥${HEALTH_T.blockedSessions.critical}`)] },
        { id: 'CKPT_REQ', name: '被动 checkpoint', from: 'pg_stat_bgwriter', desc: 'checkpoints_req /（timed + req）',
          steps: [st('notice', `notice ≥${pct(HEALTH_T.ckptReqShare.notice)}`), st('warn', `warn ≥${pct(HEALTH_T.ckptReqShare.warn)}`)] },
        { id: 'WAIT_CONC', name: '等待集中', from: 'dbe_perf.wait_events', desc: 'Top1 等待事件占全部等待的比例',
          steps: [st('notice', `notice Top1 ≥${pct(HEALTH_T.waitTopShare.notice)}`)] },
        { id: 'LWLOCK_HOT', name: 'LWLock 争用', from: 'dbe_perf.wait_events', desc: 'LWLOCK 类等待占总等待',
          steps: [st('notice', `notice ≥${pct(HEALTH_T.lwlockShare.notice)}`), st('warn', `warn ≥${pct(HEALTH_T.lwlockShare.warn)}`)] },
        { id: 'SESS_ACTIVE_HIGH', name: '活跃会话', from: 'pg_stat_activity', desc: "state = 'active' 计数",
          steps: [st('notice', `notice ≥${HEALTH_T.activeSessions.notice}`)] },
        { id: 'OS_LOAD_HIGH', name: '主机负载', from: '节点主机采集（LOAD / NUM_CPUS）', desc: '每核负载，1.0 = 所有核排满队',
          steps: [st('notice', `notice ≥${HEALTH_T.loadPerCore.notice}`), st('warn', `warn ≥${HEALTH_T.loadPerCore.warn}`), st('critical', `critical ≥${HEALTH_T.loadPerCore.critical}`)] },
        { id: 'OS_IOWAIT_HIGH', name: 'IOWait 占比', from: '节点主机采集（IOWAIT_TIME / BUSY_TIME）', desc: '累计口径；持续偏高基本可判磁盘是瓶颈',
          steps: [st('notice', `notice ≥${pct(HEALTH_T.iowaitShare.notice)}`), st('warn', `warn ≥${pct(HEALTH_T.iowaitShare.warn)}`)] },
        { id: 'XACT_PREPARED', name: '悬挂两阶段事务', from: 'pg_prepared_xacts', desc: '未决的 prepared transaction 会卡住 vacuum',
          steps: [st('notice', 'notice > 0')] },
        { id: 'REPL_BROKEN', name: '复制异常', from: 'pg_stat_replication', desc: '无备机 = 正常单机，不报',
          steps: [st('critical', 'critical state ≠ streaming')] },
        { id: 'IDX_INVALID / IDX_UNUSED', codes: ['IDX_INVALID', 'IDX_UNUSED'], name: '索引健康', from: 'pg_index · pg_stat_user_indexes',
          desc: 'indisvalid = false / idx_scan = 0（排除 PK 与唯一索引）',
          steps: [st('warn', 'warn 失效 > 0'), st('notice', 'notice 未用 > 0')] },
        { id: 'NODE_UNREACHABLE', name: '节点不可达', from: '采集器自身', desc: '整机采集失败时如实降级，不猜测健康度',
          steps: [st('warn', 'warn')] },
      ],
      notes: ['集群 scope 追加：COMMON_*（同 code ≥半数实例）、SET_DRIFT（关键参数漂移）、WORST_INSTANCE（最差上浮）'],
    },
    {
      plugin: 'sqlreview',
      title: 'SQL 审核 · 目录 / 文本 / 计划三类',
      source: 'packages/task-sqlreview/src/rules.ts · sqlscan.ts',
      intro: '目录类查系统目录、文本类对 Top-N 慢 SQL 正则、计划类标注 EXPLAIN 行；优化建议走验证阶梯（explain-verified / estimated / no-gain / plan-unavailable）。',
      rows: [
        { id: 'TBL001', name: '大表无主键', from: 'pg_class · pg_constraint', desc: '> 1 万行且无 PK / 唯一键；确定性联动升级',
          steps: [st('warn', 'warn'), st('critical', 'critical 被慢 SQL 的 UPDATE/DELETE 命中')] },
        { id: 'TBL002', name: '大表无索引', from: 'pg_class · pg_index', desc: '> 10 万行且无任何索引', steps: [st('warn', 'warn')] },
        { id: 'IDX001', name: '失效索引', from: 'pg_index', desc: 'indisvalid = false', steps: [st('warn', 'warn')] },
        { id: 'IDX002', name: '索引列过多', from: 'pg_index', desc: 'indnatts > 5', steps: [st('notice', 'notice')] },
        { id: 'IDX003', name: '完全重复索引', from: 'pg_index', desc: '同表同列序的两个索引', steps: [st('warn', 'warn')] },
        { id: 'IDX004', name: '前缀冗余索引', from: 'pg_index', desc: '(a) 被 (a,b) 覆盖', steps: [st('notice', 'notice')] },
        { id: 'IDX005', name: '从未使用索引', from: 'pg_stat_user_indexes', desc: 'idx_scan = 0（排除 PK 与唯一索引）', steps: [st('notice', 'notice')] },
        { id: 'COL001', name: '超长 varchar', from: 'pg_attribute', desc: 'varchar(> 4000)', steps: [st('notice', 'notice')] },
        { id: 'DML001', name: '无 WHERE 的 UPDATE / DELETE', from: 'dbe_perf.statement 正文', desc: '对 Top-N 慢 SQL 正文正则', steps: [st('critical', 'critical')] },
        { id: 'DQL001', name: 'SELECT *', from: 'SQL 正文', desc: '全列拉取', steps: [st('notice', 'notice')] },
        { id: 'DQL002', name: '前置模糊 LIKE', from: 'SQL 正文', desc: "LIKE '%…' 无法走索引", steps: [st('warn', 'warn')] },
        { id: 'DQL003', name: 'NOT IN 子查询', from: 'SQL 正文', desc: 'NULL 语义陷阱，建议改 NOT EXISTS', steps: [st('notice', 'notice')] },
        { id: 'PLAN_SEQSCAN', name: '计划：全表扫描', from: 'EXPLAIN 计划树', desc: '在计划行内标注，不改判 SQL 级别',
          steps: [st('notice', 'notice'), st('warn', 'warn rows > 10 万')] },
        { id: 'PLAN_SPILL', name: '计划：排序 / 聚合下盘', from: 'EXPLAIN 计划树', desc: 'Sort Method: external / Disk:', steps: [st('warn', 'warn')] },
      ],
    },
    {
      plugin: 'wdr',
      title: 'WDR 窗口 · 窗口阈值 + 归因纪律',
      source: 'packages/task-wdr/src/wdr.ts',
      intro: '窗口 = 既有快照对 delta；阈值判定与 Top SQL 归因全部脚本产出。',
      rows: [
        { id: 'WDR_LOAD_HIGH', name: '平均活跃会话', from: '两次 WDR 快照 delta', desc: 'ΔDB_TIME / 窗口时长',
          steps: [st('notice', `notice ≥${WDR_T.avgActive.notice}`), st('warn', `warn ≥${WDR_T.avgActive.warn}`)] },
        { id: 'WDR_TEMP_SPILL', name: '临时文件下盘', from: 'pg_stat_database delta', desc: 'Δtemp_bytes（库级）',
          steps: [st('notice', `notice ≥${WDR_T.tempBytes.notice / 1024 / 1024}MB`), st('warn', `warn ≥${WDR_T.tempBytes.warn / 1024 / 1024}MB`)] },
        { id: 'WDR_CACHE_LOW', name: '窗口命中率', from: 'pg_stat_database delta', desc: '用窗口内 blks delta 算，不用累计值',
          steps: [st('notice', `notice <${pct(WDR_T.cacheHit.notice)}`), st('warn', `warn <${pct(WDR_T.cacheHit.warn)}`)] },
        { id: 'WDR_CKPT_REQ', name: '被动 checkpoint', from: 'pg_stat_bgwriter delta', desc: '窗口 delta 的被动占比',
          steps: [st('notice', `notice ≥${pct(WDR_T.ckptReqShare.notice)}`), st('warn', `warn ≥${pct(WDR_T.ckptReqShare.warn)}`)] },
        { id: 'WDR_DEADLOCK', name: '死锁', from: 'pg_stat_database delta', desc: 'Δdeadlocks', steps: [st('warn', 'warn > 0')] },
        { id: 'WDR_ROLLBACK_HIGH', name: '回滚率', from: 'xact_commit / xact_rollback delta', desc: '窗口事务数 > 100 时才判',
          steps: [st('notice', `notice ≥${pct(WDR_T.rollbackRatio.notice)}`), st('warn', `warn ≥${pct(WDR_T.rollbackRatio.warn)}`)] },
        { id: 'WDR_SQL_BLOCKED', name: '锁等待型 SQL 主导', from: 'Top SQL 归因', desc: 'attr = blk 的 Top SQL 份额',
          steps: [st('warn', `warn 占窗口耗时 ≥${pct(WDR_T.blkSqlShare.warn)}`)] },
        { id: '归因纪律', codes: [], name: 'Top SQL attr 徽章', from: 'dbe_perf.statement 分项耗时',
          desc: 'tmp = 下盘 > 0 · cpu = cpu/elapsed ≥50% · io = io/elapsed ≥30% · blk = elapsed > 1s 且 cpu/io 双 < 5%',
          steps: [st('plain', '脚本判定 · 模型不可改')] },
      ],
      notes: ['等待事件剔除 STATUS 空闲类（wait cmd 等归因噪声）', '只消费既有快照：绝不 create_wdr_snapshot / 不碰 GUC'],
    },
    {
      plugin: 'ddl',
      title: 'DDL 追溯 · 规范扫描 + 时间轴',
      source: 'packages/task-ddl/src/ddl.ts',
      intro: '三源阶梯（字典变更 / 审计日志 / dbe_perf）合并时间轴；规范规则对时间轴条目逐条扫描。',
      rows: [
        { id: 'DDLR00', name: 'DROP SCHEMA', from: '字典变更 / 审计原文', desc: '整个模式被删除', steps: [st('critical', 'critical')] },
        { id: 'DDLR01', name: '表被删除', from: '字典变更 / 审计原文', desc: 'DROP TABLE，或字典里对象消失', steps: [st('warn', 'warn')] },
        { id: 'DDLR02', name: 'TRUNCATE', from: '审计原文', desc: '清空表（可回滚点少的场景高危）', steps: [st('warn', 'warn')] },
        { id: 'DDLR03', name: 'DROP COLUMN / CONSTRAINT', from: '审计原文', desc: '破坏性结构变更，下游依赖需先核对', steps: [st('warn', 'warn')] },
        { id: 'DDLR04', name: '业务时段变更', from: '时间轴条目 + 时区换算',
          desc: `北京 ${String(DDL_T.businessHourStart).padStart(2, '0')}:00–${DDL_T.businessHourEnd}:00 执行破坏 / 变更类 DDL`, steps: [st('notice', 'notice')] },
        { id: 'DDLR05', name: '同一对象反复变更', from: '时间轴按对象聚合',
          desc: `${DDL_T.churnWindowHours} 小时内同一对象变更 ≥${DDL_T.churnCount} 次——变更抖动`, steps: [st('warn', 'warn')] },
        { id: 'DDLR07', name: 'DROP 无 IF EXISTS', from: '审计原文', desc: '重复执行会报错，清场脚本不幂等', steps: [st('notice', 'notice')] },
        { id: 'DDLR90', name: '归因缺失', from: '采集器降级路径', desc: '审计查询无权限时，可观测性缺口本身就是一条发现', steps: [st('notice', 'notice')] },
        { id: '时间轴参数', codes: [], tuneRules: ['时间轴合并', '时间轴折叠'], name: '合并与折叠', from: '三源合并算法',
          desc: '审计条目按对象名 ±15 分钟吸附字典条目；同刻 >30 条折叠为「批量登记」（首轮基线导入的洪峰）',
          steps: [st('plain', '不产出发现 · 但数字可调')] },
      ],
    },
    {
      plugin: 'capacity',
      title: '容量与增长 · 空间 / 增速 / 新鲜度',
      source: 'packages/task-capacity/src/capacity.ts',
      intro: '大小、增速、非表占用、vacuum 与统计新鲜度全部脚本判定；主机磁盘与文件级数据取不到时如实降级，不外推、不误报。',
      rows: [
        { id: 'CAP_DISK_FREE', name: '磁盘水位', from: '主机采集（未接入时标注降级）', desc: '数据目录所在卷已用占比',
          steps: [st('notice', `notice ≥${pct(CAP_T.diskUsed.notice)}`), st('warn', `warn ≥${pct(CAP_T.diskUsed.warn)}`)] },
        { id: 'CAP_GROWTH', name: '增速与满盘天数', from: 'opendb_capacity_samples',
          desc: `线性回归增速；日增 < ${CAP_T.minGrowthBytesPerDay / GIB} GiB 不外推；检测到清理悬崖只用其后的段`,
          steps: [st('notice', `notice < ${CAP_T.daysToFull.notice} 天`), st('warn', `warn < ${CAP_T.daysToFull.warn} 天`)] },
        { id: 'CAP_NONTABLE_SHARE', name: '非表占用比', from: '数据目录构成采集', desc: 'WAL + 全量 SQL 追踪 + WDR + 日志/审计/core 占数据目录比例',
          steps: [st('notice', `notice ≥${pct(CAP_T.nonTableShare.notice)}`), st('warn', `warn ≥${pct(CAP_T.nonTableShare.warn)}`)] },
        { id: 'CAP_STMT_HISTORY_BLOAT', name: '系统表膨胀', from: '系统表体积 + 行数', desc: 'statement_history 等系统表又大、行均又异常 = 空间没回收',
          steps: [st('warn', `warn 体积 ≥${gib(CAP_T.sysTableBloat.minBytes)} 且行均 ≥${CAP_T.sysTableBloat.avgRowBytes / 1024}KB`)] },
        { id: 'CAP_STATS_NEVER', name: '统计信息从未收集', from: 'pg_stat_user_tables.last_analyze', desc: '从未 analyze 的大表让优化器按默认选择率出坏计划',
          steps: [st('warn', `warn ≥${CAP_T.statsNeverRows / 10000} 万行且从未 analyze`)] },
        { id: 'CAP_DEAD_TUPLES', name: '死元组占比', from: 'pg_stat_user_tables', desc: `只看 ≥${gib(CAP_T.deadRatio.minBytes)} 的表，小表不判`,
          steps: [st('notice', `notice ≥${pct(CAP_T.deadRatio.notice)}`), st('warn', `warn ≥${pct(CAP_T.deadRatio.warn)}`)] },
        { id: 'CAP_WAL_SIZE', name: 'WAL 体积', from: 'checkpoint_segments 等 GUC', desc: 'openGauss 不允许非初始账号读目录，改按 GUC 给上限估算，并注明是估算',
          steps: [st('warn', `warn 段数 > ${CAP_T.walSegFactor} × checkpoint_segments`)] },
        { id: 'CAP_WDR_RETENTION', name: 'WDR 快照保留', from: 'snapshot schema', desc: '快照体积与最老快照年龄',
          steps: [st('warn', `warn 体积 ≥${gib(CAP_T.wdr.maxBytes)} 或超期 > ${CAP_T.wdr.overdueDays} 天`)] },
        { id: 'CAP_LOG_RETENTION', name: '日志保留', from: 'log_directory 与 GUC', desc: 'pg_log 只轮转不清理时会一直长',
          steps: [st('warn', `warn 无保留策略且 ≥${gib(CAP_T.logMaxBytes)}`)] },
        { id: 'CAP_COLLECT_GAP', name: '采集空窗', from: 'opendb_capacity_samples', desc: '空窗会让增速失真——所以它是一条发现，而不是悄悄用旧数据',
          steps: [st('notice', `notice 相邻采样间隔 > ${CAP_T.collectGapHours}h`)] },
        { id: '采集诚实', codes: [], name: '降级即发现', from: '采集器降级路径',
          desc: '取不到的数据一律标注来源与原因（主机磁盘未接入、pg_ls_dir 需 omm 账号），判定不因此误报，也不外推',
          steps: [st('plain', '脚本判定 · 不可被解读掩盖')] },
      ],
      notes: ['2026-08-31 容量插件上线后补入目录'],
    },
  ];
}

/** 该行代表的真实规则码（合并行会有多个；纪律类条目为空 = 不参与命中对账） */
export function codesOf(row: RuleRow): string[] {
  return row.codes ?? [row.id];
}

/** 该行挂哪些阈值（按 spec.rule 匹配）；参数类条目不产出发现但有可调数字，所以单列 */
export function tuneRulesOf(row: RuleRow): string[] {
  return row.tuneRules ?? codesOf(row);
}

/** 目录里登记过的全部真实规则码 */
export function catalogCodes(plugin?: string): Set<string> {
  const out = new Set<string>();
  for (const g of rulesCatalog()) {
    if (plugin !== undefined && plugin !== '' && g.plugin !== plugin) continue;
    for (const r of g.rows) for (const c of [...codesOf(r), ...tuneRulesOf(r)]) out.add(c);
  }
  return out;
}

/** 会话简易版：markdown 输出（rules_catalog 工具用） */
export function catalogMarkdown(pluginFilter?: string): string {
  const groups = rulesCatalog().filter((g) => pluginFilter === undefined || pluginFilter === '' || g.plugin === pluginFilter);
  const out: string[] = ['# opendb-dsh 平台规则目录（确定性判定层，级别不可被模型下调）', ''];
  for (const g of groups) {
    out.push(`## ${g.title}（\`${g.plugin}\`）`, g.intro, '', '| 规则 | 名称 | 级别阶梯 | 说明 |', '|---|---|---|---|');
    for (const r of g.rows) out.push(`| \`${r.id}\` | ${r.name} | ${r.steps.map((s) => s.t).join(' · ')} | ${r.desc} |`);
    for (const n of g.notes ?? []) out.push(`> ${n}`);
    out.push(`> 实现：\`${g.source}\``, '');
  }
  out.push('（本目录的阈值数字是代码默认值；当前生效值与改动记录用 threshold_list 查看，会话里可直接改——见「阈值配置」插件）');
  return out.join('\n');
}
