/**
 * tool-ddl-collect — ddl_collect 工具（task-ddl 的采集半边，Runtime 侧）。
 * 三源阶梯：①平台字典变更（opendbDictionary，对象/时间主干）②节点审计日志 pg_query_audit
 * （用户归因+DDL 原文；需平台账号 AUDITADMIN，无权限如实降级并给解锁方法）
 * ③dbe_perf.statement DDL 文本（辅助佐证）。全程只读。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { pickNode, clampText } from '@opendb-dsh/tool-db';
import { dictToTimeline, auditToTimeline, mergeTimeline, scanDdlRules, worstOf, timelineStats, withDdlThresholds } from '@opendb-dsh/task-ddl';
import type { TimelineEntry, DdlLevel } from '@opendb-dsh/task-ddl';

export const name = 'tool-ddl-collect';
export const inject = ['opendbDb', 'opendbRegistry', 'opendbDictionary', 'opendbThresholds'];
export const Config = z.object({
  maxContentBytes: z.number().step(1).min(4096).default(30000),
  maxEntries: z.number().step(1).min(20).default(120),
});

const LEVEL_CN: Record<string, string> = { ok: '正常', notice: '关注', warn: '告警', critical: '严重' };

interface Deps { db: any; registry: any; dictionary: any; thresholds: any; maxContentBytes: number; maxEntries: number }

function defineDdlCollectTool(deps: Deps) {
  return defineTool({
    name: 'ddl_collect',
    description: 'DDL 变更追溯与规范扫描：合并平台字典变更快照（对象/时间）与节点审计日志（哪个用户执行了什么 DDL），产出变更时间轴 + 确定性规范扫描（DROP/TRUNCATE/业务时段变更/变更抖动等规则）。回答"什么时间、由哪个用户、做过什么变更"。全程只读。',
    parameters: {
      node: { type: 'string', description: '目标节点名称；agent 只绑定一个节点时可省略。' },
      hours: { type: 'integer', description: '回溯窗口小时数（默认 168 = 7 天）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true } } },
      render: (_args: unknown, value: any) => [{ type: 'text', text: value.content }],
    },
    async execute(args: any, exec: any) {
      const { node } = await pickNode(deps.registry, exec, typeof args.node === 'string' && args.node !== '' ? args.node : undefined);
      const hours = Math.max(1, Math.min(Number(args.hours ?? 168), 24 * 30));
      const notes: string[] = [];
      // 运行时阈值：平台阈值服务的覆盖值；服务不可读则退回代码默认值
      const T = withDdlThresholds(await deps.thresholds.resolve('ddl').catch(() => ({})));

      // ① 平台字典变更（主干）
      let dictEntries: TimelineEntry[] = [];
      try {
        const rows = await deps.dictionary.changes({ nodeId: node.id, sinceHours: hours, limit: 500 });
        dictEntries = dictToTimeline(rows.map((r: any) => ({ time: r.time, kind: r.kind, sch: r.sch, name: r.name, change: r.change })), T.floodFoldCount);
      } catch (cause) { notes.push(`字典变更源降级：${String((cause as Error).message ?? cause).slice(0, 120)}`); }

      // ② 节点审计（用户归因）
      let auditEntries: TimelineEntry[] = [];
      let auditAvailable = false;
      try {
        const r = await deps.db.query(node,
          `SELECT time, type, result, username, object_name, detail_info FROM pg_query_audit(now() - interval '${hours} hours', now()) WHERE lower(type) LIKE 'ddl%' ORDER BY time DESC LIMIT 300`,
          { maxRows: 300 });
        auditEntries = auditToTimeline(r.rows as any);
        auditAvailable = true;
        if (auditEntries.length === 0) notes.push('审计源可读但窗口内无 DDL 审计记录');
      } catch (cause) {
        notes.push(`审计源不可读（${String((cause as Error).message ?? cause).slice(0, 100)}）——"由哪个用户"无法归因。解锁：DBA 对平台只读账号执行 ALTER USER <账号> AUDITADMIN;（仅授予审计查询权，平台仍只读）`);
      }

      // ③ dbe_perf DDL 文本（辅助佐证；og unique_sql 缓存有限，常为空）
      try {
        const r = await deps.db.query(node,
          `SELECT user_name, left(query, 120) AS q, n_calls, last_updated FROM dbe_perf.statement WHERE query ~* '^\\s*(create|alter|drop|truncate)\\b' ORDER BY last_updated DESC LIMIT 20`,
          { maxRows: 20 });
        if (r.rows.length > 0 && auditEntries.length === 0) {
          for (const row of r.rows) {
            auditEntries.push({ time: new Date(row.last_updated as any).toISOString(), action: 'ddl', kind: 'statement', object: '', user: String(row.user_name ?? ''), sqlText: String(row.q ?? ''), sources: ['dbe_perf'] });
          }
          notes.push(`审计不可用，以 dbe_perf.statement 里 ${r.rows.length} 条 DDL 文本辅助归因（时间为 last_updated，非精确执行时刻）`);
        }
      } catch { /* dbe_perf 缺失已有其他任务覆盖，不重复记 note */ }

      // 合并 + 规则 + 统计
      const timeline = mergeTimeline(dictEntries, auditEntries, T.mergeWindowMinutes * 60 * 1000).slice(0, deps.maxEntries);
      const ruleFindings = scanDdlRules(timeline, 480, T);
      const stats = timelineStats(timeline);
      const counts: Record<DdlLevel, number> = { ok: 0, notice: 0, warn: 0, critical: 0 };
      for (const f of ruleFindings) counts[f.level] += 1;
      const worst = worstOf(ruleFindings);
      if (!auditAvailable && stats.users.length === 0) {
        // 归因缺失本身是一条确定性发现（可观测性缺口）
        counts.notice += 1;
        ruleFindings.push({ rule: 'DDLR90', level: 'notice', object: node.name, time: '', problem: '变更无法归因到用户（审计查询权限缺失）', advice: 'DBA 授予平台账号 AUDITADMIN（只读审计查询）后，时间轴自动补齐操作者', evidence: 'pg_query_audit permission denied' });
      }

      const payload = {
        scope: 'ddl-trace',
        node: node.name,
        windowHours: hours,
        det: { worst: worstOf(ruleFindings), counts },
        stats: { total: stats.total, added: stats.added, removed: stats.removed, changed: stats.changed, users: stats.users },
        timeline,
        ruleFindings,
        auditAvailable,
        collectionNotes: notes,
      };
      const header = [
        `-- ddl_collect · ${node.name} · 回溯 ${hours}h · 时间轴 ${timeline.length} 条（实际变更 ${stats.total}）· worst=${payload.det.worst}（${LEVEL_CN[payload.det.worst]}）`,
        `-- 用户归因：${auditAvailable ? '审计可用' : stats.users.length > 0 ? 'dbe_perf 辅助' : '不可用（见 collectionNotes 解锁方法）'}`,
        `-- 以下 JSON 是唯一事实来源：除 timeline[].note / priorities / rootCause 外全部逐字进报告，level/user 不得改动`,
      ].join('\n');
      return { content: clampText(`${header}\n${JSON.stringify(payload, null, 1)}`, deps.maxContentBytes) };
    },
  } as any);
}

export function apply(ctx: Context, config: { maxContentBytes?: number; maxEntries?: number } = {}): void {
  const anyCtx = ctx as any;
  anyCtx.inject(['tools'], (c: any) => {
    const deps: Deps = {
      db: anyCtx.opendbDb,
      registry: anyCtx.opendbRegistry,
      dictionary: anyCtx.opendbDictionary,
      thresholds: anyCtx.opendbThresholds,
      maxContentBytes: config.maxContentBytes ?? 30000,
      maxEntries: config.maxEntries ?? 120,
    };
    c.effect(() => c.tools.register(defineDdlCollectTool(deps)), 'tool-ddl-collect.ddl_collect');
  });
}
