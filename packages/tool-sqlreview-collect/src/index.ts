/**
 * tool-sqlreview-collect — sqlreview_collect 工具（task-sqlreview 的采集半边，Runtime 侧）。
 * 独立成包（W4 + task-health 两次事故定论：工具注册必须独立 function plugin，
 * 顶层 inject 数据服务、嵌套仅 inject(['tools'])，形状对照 tool-metrics/tool-health-collect）。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { pickNode, clampText } from '@opendb-dsh/tool-db';
import { runCatalogRules, textRules, worstRuleLevel, LEVEL_ORDER, scanSql, shortKey, withSqlreviewThresholds } from '@opendb-dsh/task-sqlreview';
import type { RuleFinding, RuleLevel, SqlItem } from '@opendb-dsh/task-sqlreview';

export const name = 'tool-sqlreview-collect';
export const inject = ['opendbDb', 'opendbRegistry', 'opendbThresholds'];
export const Config = z.object({
  maxContentBytes: z.number().step(1).min(4096).default(30000),
});

const LEVEL_CN: Record<string, string> = { ok: '正常', notice: '关注', warn: '告警', critical: '严重' };

interface Deps { db: any; registry: any; thresholds: any; maxContentBytes: number }

function defineSqlreviewCollectTool(deps: Deps) {
  return defineTool({
    name: 'sqlreview_collect',
    description: 'SQL 审核确定性采集器：对目标节点运行 12 条审核规则（表/索引/列目录检查 + 慢 SQL 文本检查）产出违规清单，并对 Top-N 慢 SQL 做执行计划锚定（EXPLAIN 原计划 + 总 cost + 脚本标注的优化点）。全程只读；og 无 hypopg 时索引建议只能预估。',
    parameters: {
      node: { type: 'string', description: '目标节点名称；agent 只绑定一个节点时可省略。' },
      topN: { type: 'integer', description: '慢 SQL 扫描条数（默认 5，按均耗时降序）。' },
      sqls: { type: 'array', items: { type: 'string' }, description: '额外指定要审核的 SQL 文本（会话贴 SQL 场景）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true } } },
      render: (_args: unknown, value: any) => [{ type: 'text', text: value.content }],
    },
    async execute(args: any, exec: any) {
      const { node } = await pickNode(deps.registry, exec, typeof args.node === 'string' && args.node !== '' ? args.node : undefined);
      const q = (sql: string, maxRows = 50) => deps.db.query(node, sql, { maxRows });
      const notes: string[] = [];
      const topN = Math.max(1, Math.min(Number(args.topN ?? 5), 20));
      const extraSqls: string[] = Array.isArray(args.sqls) ? args.sqls.map(String).slice(0, 10) : [];

      // 1) 慢 SQL 扫描 + 计划锚定
      // 运行时阈值：平台阈值服务的覆盖值；服务不可读则退回代码默认值
      const T = withSqlreviewThresholds(await deps.thresholds.resolve('sqlreview').catch(() => ({})));
      const sqlItems: SqlItem[] = await scanSql(q, topN, extraSqls, notes, T);
      // 2) 规则引擎：目录类（联动慢 SQL 文本）+ 文本类
      const slowTexts = sqlItems.map((s) => s.text);
      const ruleFindings: RuleFinding[] = [
        ...await runCatalogRules(q, slowTexts, notes, T),
        ...textRules(sqlItems.map((s) => ({ key: s.key, text: s.text }))),
      ].sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level]);
      // 3) hypopg 可用性（只探测不启用）
      let hypopg = false;
      try {
        const r = await q("SELECT count(*)::int AS n FROM pg_available_extensions WHERE name = 'hypopg'", 1);
        hypopg = Number(r.rows[0]?.n ?? 0) > 0;
      } catch { notes.push('hypopg 探测降级（pg_available_extensions 不可读）'); }

      /**
       * det.counts 是「规则违规 + 执行计划发现」两类之和，而 ruleFindings 数组只装前者——
       * 模型每次都据此判定「det.counts 与明细计数不一致」并写进 collectionNotes
       * （2026-08-24 user 报障：大盘环图写 26 条、下面只列 20 条）。
       * counts 的值一个不改（判定语义不动），只把来源拆明白，让读的人/模型一眼看出 26 = 20 + 6。
       */
      const zero = (): Record<RuleLevel, number> => ({ ok: 0, notice: 0, warn: 0, critical: 0 });
      const ruleCounts = zero();
      for (const f of ruleFindings) ruleCounts[f.level] += 1;
      const planCounts = zero();
      for (const s of sqlItems) for (const pf of s.planFindings) planCounts[pf.level] += 1;
      const counts: Record<RuleLevel, number> = {
        ok: ruleCounts.ok + planCounts.ok,
        notice: ruleCounts.notice + planCounts.notice,
        warn: ruleCounts.warn + planCounts.warn,
        critical: ruleCounts.critical + planCounts.critical,
      };
      const planFindingTotal = Object.values(planCounts).reduce((a, b) => a + b, 0);
      const worst = worstRuleLevel([
        ...ruleFindings,
        ...sqlItems.flatMap((s) => s.planFindings.map((pf) => ({ rule: pf.code, level: pf.level, object: s.key, problem: '', advice: '', evidence: '' } as RuleFinding))),
      ]);

      const payload = {
        scope: 'sql-set',
        node: node.name,
        det: {
          worst,
          counts,                        // 总计 = 规则违规 + 计划发现（语义与旧版一致，值未变）
          countsBySource: { rule: ruleCounts, plan: planCounts },
          totals: { rule: ruleFindings.length, plan: planFindingTotal, all: ruleFindings.length + planFindingTotal },
          countsNote: `det.counts 是两类之和：规则违规 ${ruleFindings.length} 条（见 ruleFindings）+ 执行计划发现 ${planFindingTotal} 条（见各 sqlItems[].planFindings）。两者数量本就不同，不是计数错误。`,
        },
        hypopg: { available: hypopg, note: hypopg ? '可用：可虚拟索引实证' : '不可用：索引类建议只能 estimated（og-lite 常态）' },
        ruleFindings,
        sqlItems: sqlItems.map((s) => ({
          key: s.key, text: s.text, calls: s.calls, avgMs: s.avgMs, totalMs: s.totalMs,
          explainOk: s.explainOk,
          origCost: s.planCost !== undefined ? String(s.planCost) : '',
          plan: s.plan,
          planFindings: s.planFindings,
          note: s.note,
        })),
        collectionNotes: notes,
      };
      const header = [
        `-- sqlreview_collect · ${node.name} · 规则违规 ${ruleFindings.length} 条 · 慢 SQL ${sqlItems.length} 条 · worst=${worst}（${LEVEL_CN[worst]}）`,
        `-- 以下 JSON 是唯一事实来源：det/ruleFindings 与 sqlItems 的 key/text/calls/avgMs/origCost/planFindings 必须逐字进报告，级别不得下调`,
        `-- 优化改写请另行 db_query EXPLAIN 实证（禁止 EXPLAIN ANALYZE）；hypopg=${hypopg ? '可用' : '不可用'}`,
      ].join('\n');
      return { content: clampText(`${header}\n${JSON.stringify(payload, null, 1)}`, deps.maxContentBytes) };
    },
  } as any);
}

export function apply(ctx: Context, config: { maxContentBytes?: number } = {}): void {
  const anyCtx = ctx as any;
  anyCtx.inject(['tools'], (c: any) => {
    const deps: Deps = {
      db: anyCtx.opendbDb,
      registry: anyCtx.opendbRegistry,
      thresholds: anyCtx.opendbThresholds,
      maxContentBytes: config.maxContentBytes ?? 30000,
    };
    c.effect(() => c.tools.register(defineSqlreviewCollectTool(deps)), 'tool-sqlreview-collect.sqlreview_collect');
  });
}
