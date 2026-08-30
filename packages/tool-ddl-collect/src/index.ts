/**
 * tool-ddl-collect — ddl_collect 工具（task-ddl 的采集半边，Runtime 侧）。
 * 三源阶梯：①平台字典变更（opendbDictionary，含定义原文——对象/时间/列级 diff 主干）②openGauss pg_object
 * （建/改时间与创建者，补字典未观测到的变更）③节点审计日志 pg_query_audit（用户归因 + DDL 原文；需 AUDITADMIN，
 * 无权限如实降级并给解锁方法）。全程只读；采集前先做一次字典快照，保证报告反映采集时刻的结构。
 * R2（2026-08-30 user 定稿 docs/prototypes/ddl-r2.html）：产出结构历史（主干版本 / 分支生命线 / 各对象定义时间线），
 * 整包存档 opendb_task_collects 供面板直读（演进图 + GitHub 式版本比较在前端按定义时间线算），模型只写解读。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { pickNode, clampText } from '@opendb-dsh/tool-db';
import { scanDdlRules, worstOf, timelineStats, withDdlThresholds, buildHistory, toTimelineEntries, compareVersions } from '@opendb-dsh/task-ddl';
import type { DdlLevel, DdlRuleFinding, TimelineEntry, DictChangeFull, CurrentObject, PgObjectRow, AuditDdl, IndexOwner } from '@opendb-dsh/task-ddl';

export const name = 'tool-ddl-collect';
export const inject = ['opendbDb', 'opendbRegistry', 'opendbDictionary', 'opendbThresholds'];
export const Config = z.object({
  maxContentBytes: z.number().step(1).min(4096).default(40000),
  maxEntries: z.number().step(1).min(20).default(300),
  /** 存档用 PG（opendb_task_collects）；空则用字典服务同一个连接池 */
  connectionString: z.string().default(''),
});

const LEVEL_CN: Record<string, string> = { ok: '正常', notice: '关注', warn: '告警', critical: '严重' };
const iso = (v: unknown): string => { const d = new Date(v as any); return Number.isNaN(d.getTime()) ? String(v ?? '') : d.toISOString(); };
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const errMsg = (cause: unknown): string => String((cause as Error)?.message ?? cause).slice(0, 120);

interface Deps { db: any; registry: any; dictionary: any; thresholds: any; maxContentBytes: number; maxEntries: number }

/** 采集前先快照：把节点当前字典（含定义）记进平台，报告才反映"此刻"的结构 */
async function snapshotNow(deps: Deps, node: any): Promise<string> {
  const queries = deps.db.dialect(node.engine)?.dictionary ?? [];
  const objects: { kind: string; sch: string; name: string; signature: string; definition?: string }[] = [];
  for (const q of queries) {
    const r = await deps.db.query(node, q.sql, { maxRows: 20000 });
    for (const row of r.rows) {
      if (typeof row.kind !== 'string' || typeof row.sch !== 'string' || typeof row.name !== 'string') continue;
      objects.push({ kind: row.kind, sch: row.sch, name: row.name, signature: typeof row.signature === 'string' ? row.signature : '', ...(typeof row.definition === 'string' ? { definition: row.definition } : {}) });
    }
  }
  const r = await deps.dictionary.snapshot(node.id, objects);
  return `采集前字典快照：${r.total} 对象，+${r.added} −${r.removed} ~${r.modified}`;
}

function defineDdlCollectTool(deps: Deps) {
  return defineTool({
    name: 'ddl_collect',
    description: '表结构变更追溯与规范扫描：合并平台字典变更（含列/索引定义）、pg_object 建改时间与创建者、审计 DDL 原文，产出结构历史——主干版本（每个 DDL 批次一版）、各 schema/表的生命线、任意两版之间的列/索引级差异、变更时间轴与确定性规范扫描（DROP/TRUNCATE/业务时段/抖动等）。回答"什么时间、由哪个用户、把哪张表的结构改成了什么"。全程只读。',
    parameters: {
      node: { type: 'string', description: '目标节点名称；agent 只绑定一个节点时可省略。' },
      hours: { type: 'integer', description: '回溯窗口小时数（默认 168 = 7 天）。' },
      schemas: { type: 'array', items: { type: 'string' }, description: '只看这些 schema（省略 = 全部非系统 schema）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true } } },
      render: (_args: unknown, value: any) => [{ type: 'text', text: value.content }],
    },
    async execute(args: any, exec: any) {
      const { node } = await pickNode(deps.registry, exec, typeof args.node === 'string' && args.node !== '' ? args.node : undefined);
      const hours = Math.max(1, Math.min(Number(args.hours ?? 168), 24 * 30));
      const schemas: string[] = Array.isArray(args.schemas) ? args.schemas.map(String).filter((s: string) => s !== '') : [];
      const notes: string[] = [];
      const until = new Date(); const since = new Date(until.getTime() - hours * 3600_000);
      const T = withDdlThresholds(await deps.thresholds.resolve('ddl').catch(() => ({})));
      const inSchemas = (sch: string) => schemas.length === 0 || schemas.includes(sch);

      // ⓪ 先快照
      try { notes.push(await snapshotNow(deps, node)); } catch (cause) { notes.push(`采集前字典快照失败（沿用上一次快照）：${errMsg(cause)}`); }

      // ① 字典变更（含定义）+ 当前对象
      let changes: DictChangeFull[] = []; let current: CurrentObject[] = [];
      try {
        const rows = await deps.dictionary.changes({ nodeId: node.id, sinceHours: hours, limit: 2000 });
        changes = rows.filter((r: any) => inSchemas(str(r.sch))).map((r: any) => ({ time: iso(r.time), kind: str(r.kind), sch: str(r.sch), name: str(r.name), change: str(r.change) as DictChangeFull['change'], oldDefinition: r.oldDefinition ?? undefined, newDefinition: r.newDefinition ?? undefined }));
        const objs = await deps.dictionary.objects(node.id);
        current = objs.filter((o: any) => inSchemas(str(o.sch))).map((o: any) => ({ kind: str(o.kind), sch: str(o.sch), name: str(o.name), definition: o.definition ?? undefined, firstSeen: iso(o.firstSeen) }));
      } catch (cause) { notes.push(`字典源降级：${errMsg(cause)}`); }

      // ② pg_object（openGauss）：建/改时间 + 创建者；索引归属表
      let pgObjects: PgObjectRow[] = []; let indexOwners: IndexOwner[] = []; let pgObjectAvailable = false;
      try {
        const r = await deps.db.query(node,
          `SELECT n.nspname AS sch, c.relname AS name, c.relkind AS kind, o.ctime, o.mtime, coalesce(r.rolname, '') AS creator
           FROM pg_object o JOIN pg_class c ON c.oid = o.object_oid JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_roles r ON r.oid = o.creator
           WHERE c.relkind IN ('r','i','v','m','p') AND n.nspname NOT LIKE 'pg_%' AND n.nspname NOT IN ('information_schema','snapshot','dbe_perf','db4ai','cstore','blockchain','dbe_pldebugger','dbe_pldeveloper','dbe_sql_util','sqladvisor','pkg_service','coverage','pmk','dbms_om','dbms_sql')
             AND (o.ctime > now() - interval '${hours} hours' OR o.mtime > now() - interval '${hours} hours')`, { maxRows: 5000 });
        pgObjects = r.rows.filter((row: any) => inSchemas(str(row.sch))).map((row: any) => ({ sch: str(row.sch), name: str(row.name), kind: str(row.kind), ctime: iso(row.ctime), mtime: iso(row.mtime), creator: str(row.creator) }));
        pgObjectAvailable = true;
      } catch (cause) { notes.push(`pg_object 不可读（非 openGauss 或无权限），建/改时间只能靠字典快照粒度：${errMsg(cause)}`); }
      try {
        const r = await deps.db.query(node, `SELECT schemaname AS sch, indexname AS idx, tablename AS tbl FROM pg_indexes WHERE schemaname NOT LIKE 'pg_%' AND schemaname NOT IN ('information_schema','snapshot','dbe_perf','db4ai')`, { maxRows: 20000 });
        indexOwners = r.rows.map((row: any) => ({ sch: str(row.sch), index: str(row.idx), table: str(row.tbl) }));
      } catch { /* 索引归属只影响子线挂载 */ }

      // ③ 审计（用户归因 + 原文）
      let audit: AuditDdl[] = []; let auditAvailable = false;
      try {
        const r = await deps.db.query(node,
          `SELECT time, type, result, username, object_name, detail_info FROM pg_query_audit(now() - interval '${hours} hours', now()) WHERE lower(type) LIKE 'ddl%' ORDER BY time DESC LIMIT 500`,
          { maxRows: 500 });
        audit = r.rows.map((row: any) => ({ time: iso(row.time), type: str(row.type), username: str(row.username), object: str(row.object_name), sql: str(row.detail_info).slice(0, 400) }));
        auditAvailable = true;
        if (audit.length === 0) notes.push('审计源可读但窗口内无 DDL 审计记录（业务表 DDL 需 audit_system_object 覆盖 table/index 才会入审计）');
      } catch (cause) {
        notes.push(`审计源不可读（${errMsg(cause)}）——"由哪个用户"只能靠 pg_object.creator（建表者）。解锁：DBA 对平台账号执行 ALTER USER <账号> AUDITADMIN;（仅审计查询权，平台仍只读）`);
      }

      // ④ 结构历史（纯函数）
      const history = buildHistory({ since: since.toISOString(), until: until.toISOString(), changes, current, pgObjects, audit, indexOwners, mergeWindowMs: T.mergeWindowMinutes * 60_000 });
      const timeline: TimelineEntry[] = toTimelineEntries(history.events).slice().sort((x, y) => y.time.localeCompare(x.time)).slice(0, deps.maxEntries);
      const ruleFindings: DdlRuleFinding[] = scanDdlRules(timeline, 480, T);
      const stats = timelineStats(timeline);
      const counts: Record<DdlLevel, number> = { ok: 0, notice: 0, warn: 0, critical: 0 };
      for (const f of ruleFindings) counts[f.level] += 1;
      const unattributed = history.events.filter((e) => e.change !== 'user' && e.who === '').length;
      if (unattributed > 0 && !auditAvailable) {
        counts.notice += 1;
        ruleFindings.push({ rule: 'DDLR90', level: 'notice', object: node.name, time: '', problem: `${unattributed} 条变更无法归因到用户（审计不可用且 pg_object 无创建者）`, advice: 'DBA 授予平台账号 AUDITADMIN 后，时间轴自动补齐操作者', evidence: 'pg_query_audit permission denied' });
      }
      const worst = worstOf(ruleFindings);
      const schemasTouched = [...new Set(history.events.filter((e) => e.sch !== '').map((e) => e.sch))];
      const summary = {
        events: history.events.length, structural: history.events.filter((e) => e.change !== 'user').length, account: history.events.filter((e) => e.change === 'user').length,
        objects: Object.keys(history.objects).length, tables: new Set(history.events.filter((e) => e.kind === 'table').map((e) => `${e.sch}.${e.name}`)).size,
        users: [...new Set(history.events.map((e) => e.who).filter((w) => w !== ''))], unattributed,
        destructive: history.events.filter((e) => e.change === 'removed' && (e.kind === 'table' || e.kind === 'schema')).length,
        businessHours: ruleFindings.filter((f) => f.rule === 'DDLR04').length, schemas: schemasTouched.length, versions: history.versions.length,
      };
      const payload = {
        scope: 'ddl-trace', version: 2, node: node.name, collectedAt: until.toISOString(), windowHours: hours, since: since.toISOString(), until: until.toISOString(), schemasFilter: schemas,
        det: { worst, counts }, summary, stats: { total: stats.total, added: stats.added, removed: stats.removed, changed: stats.changed, users: stats.users },
        versions: history.versions, lanes: history.lanes, objects: history.objects, events: history.events,
        timeline, ruleFindings, auditAvailable, pgObjectAvailable, collectionNotes: notes,
      };

      // 存档（字典服务的池即平台 PG）
      let archiveLine = '';
      try {
        const sessionId = typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : null;
        const r = await deps.dictionary.pool.query(`INSERT INTO opendb_task_collects (task_type, session_id, node, worst, collected_at, payload) VALUES ('ddl', $1, $2, $3, now(), $4) RETURNING id`, [sessionId, node.name, worst, JSON.stringify(payload)]);
        if (r.rows[0] !== undefined) archiveLine = `\n-- 采集已存档 opendb_task_collects#${Number(r.rows[0].id)}（任务面板直读演进图/版本比较/时间轴；报告只写解读）`;
      } catch (cause) { archiveLine = `\n-- 采集存档失败：${errMsg(cause)}`; }

      // 给模型：版本摘要 + 首末版本 diff 摘要 + 规则 + 精简时间轴
      const firstLast = history.versions.length >= 1 ? compareVersions(history.objects, since.toISOString(), until.toISOString()) : undefined;
      const forModel = {
        node: node.name, windowHours: hours, det: payload.det, summary,
        versions: history.versions.map((v) => ({ v: v.v, time: v.time, who: v.who, kind: v.kind, label: v.label, objs: v.objs })),
        lanes: history.lanes.map((l) => ({ id: l.id, born: l.born, died: l.died, tables: l.tables, subs: l.subs.map((s) => `${s.kind} ${s.name}：${s.events.map((e) => `${e.change}@${e.time.slice(5, 16)}`).join(' → ')}`) })),
        windowDiff: firstLast !== undefined ? { summary: firstLast.summary, objects: firstLast.objects.slice(0, 30).map((o) => ({ object: `${o.kind} ${o.sch}.${o.name}`, change: o.change, rows: o.rows.filter((r) => r.k !== 'same').slice(0, 12).map((r) => `${r.k === 'add' ? '+' : r.k === 'del' ? '-' : '~'} ${r.t}`) })) } : undefined,
        ruleFindings, timeline: timeline.slice(0, 60).map((t) => ({ time: t.time, action: t.action, kind: t.kind, object: t.object, user: t.user, sql: t.sqlText.slice(0, 160), sources: t.sources })),
        auditAvailable, pgObjectAvailable, collectionNotes: notes,
      };
      const header = [
        `-- ddl_collect · ${node.name} · 回溯 ${hours}h · 事件 ${history.events.length} · 主干版本 ${history.versions.length} · 涉及 ${summary.objects} 个对象 · worst=${worst}（${LEVEL_CN[worst]}）`,
        `-- 归因：${summary.users.length > 0 ? summary.users.join(', ') : '无'}${auditAvailable ? '（审计可用）' : '（审计不可用，建表者取自 pg_object）'}；未归因 ${unattributed}`,
        `-- 以下 JSON 是唯一事实来源：det 逐字进报告；你只写 situation / versionNotes[].note / findings[].note / rootCause / priorities`,
      ].join('\n');
      return { content: clampText(`${header}${archiveLine}\n${JSON.stringify(forModel, null, 1)}`, deps.maxContentBytes) };
    },
  } as any);
}

export function apply(ctx: Context, config: { maxContentBytes?: number; maxEntries?: number; connectionString?: string } = {}): void {
  const anyCtx = ctx as any;
  anyCtx.inject(['tools'], (c: any) => {
    const deps: Deps = {
      db: anyCtx.opendbDb,
      registry: anyCtx.opendbRegistry,
      dictionary: anyCtx.opendbDictionary,
      thresholds: anyCtx.opendbThresholds,
      maxContentBytes: config.maxContentBytes ?? 40000,
      maxEntries: config.maxEntries ?? 300,
    };
    c.effect(() => c.tools.register(defineDdlCollectTool(deps)), 'tool-ddl-collect.ddl_collect');
  });
}
