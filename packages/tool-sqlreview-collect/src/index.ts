/**
 * tool-sqlreview-collect — sqlreview_collect 工具（task-sqlreview 的采集半边，Runtime 侧）。
 * 独立成包（W4 + task-health 两次事故定论：工具注册必须独立 function plugin，
 * 顶层 inject 数据服务、嵌套仅 inject(['tools'])，形状对照 tool-metrics/tool-health-collect）。
 *
 * R5（2026-08-27）：榜单维度由调用方（任务配置/会话）决定，产出负载总量 + 各维度榜单 + 去重 Top SQL
 * 明细（指标·占比·榜位·类型·执行计划·归因违规）+ 一眼结论 + 规则违规，整包存档 opendb_task_collects
 * 供面板直读；给模型的是同一份数据的精简视图（它只需逐条解读）。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type pg from 'pg';
import { pickNode, clampText } from '@opendb-dsh/tool-db';
import { createPool } from '@opendb-dsh/session-persistence-pg';
import {
  runCatalogRules, textRules, worstRuleLevel, LEVEL_ORDER, explainOne, shortKey, withSqlreviewThresholds,
  buildTopSql, normalizeDimensions, attributeRules, insightsOf, DIMENSIONS, fingerprint, fetchExecProfile,
} from '@opendb-dsh/task-sqlreview';
import type { RuleFinding, RuleLevel, TopSqlItem, DimKey, SqlMetrics, ExecProfile } from '@opendb-dsh/task-sqlreview';

export const name = 'tool-sqlreview-collect';
export const inject = ['opendbDb', 'opendbRegistry', 'opendbThresholds'];
export const Config = z.object({
  maxContentBytes: z.number().step(1).min(4096).default(60000),
  /** 存档用 PG（opendb_task_collects）；不配则不存档，面板退回兼容视图 */
  connectionString: z.string().default(''),
  /** 逐条 EXPLAIN 的上限（多榜去重后条数可能超过 topN） */
  maxExplain: z.number().step(1).min(1).default(24),
});

const LEVEL_CN: Record<string, string> = { ok: '正常', notice: '关注', warn: '告警', critical: '严重' };
const EMPTY_METRICS: SqlMetrics = { calls: 0, elapsedUs: 0, avgUs: 0, minUs: 0, maxUs: 0, cpuUs: 0, ioUs: 0, blocks: 0, blocksHit: 0, dbTimeUs: 0, rowsRet: 0, spillBytes: 0 };

interface Deps { db: any; registry: any; thresholds: any; maxContentBytes: number; maxExplain: number; pool?: pg.Pool }

/** 采集包里的每条 SQL：榜单指标 + 计划锚定 + 归因违规 */
interface CollectedItem extends TopSqlItem {
  explainOk: boolean; plan: string[]; origCost: string; planFindings: { code: string; line: number; level: string; detail: string }[]; note?: string;
  ruleRefs: number[];
  /** 单次耗时构成 + 等待事件（statement_history 最近 N 次执行均值）；未进采样的语句为 undefined，profileNote 说明原因 */
  profile?: ExecProfile;
  profileNote?: string;
}

async function archive(pool: pg.Pool, sessionId: string | undefined, node: string, worst: string, payload: unknown): Promise<number | undefined> {
  const r = await pool.query(
    `INSERT INTO opendb_task_collects (task_type, session_id, node, worst, collected_at, payload) VALUES ('sqlreview', $1, $2, $3, now(), $4) RETURNING id`,
    [sessionId ?? null, node, worst, JSON.stringify(payload)],
  );
  return r.rows[0] !== undefined ? Number(r.rows[0].id) : undefined;
}

const ms = (us: number): number => Math.round(us / 1000);

/** 给模型看的精简视图：它只需要文本、计划、标注、归因违规和少量指标来做逐条解读 */
function modelView(items: CollectedItem[], ruleFindings: RuleFinding[]) {
  return items.map((it) => ({
    key: it.key, label: it.label, kind: it.kind, ranks: it.ranks,
    text: it.text,
    metrics: { calls: it.metrics.calls, avgMs: ms(it.metrics.avgUs), maxMs: ms(it.metrics.maxUs), totalMs: ms(it.metrics.elapsedUs), cpuMs: ms(it.metrics.cpuUs), ioMs: ms(it.metrics.ioUs), blocks: it.metrics.blocks, rowsRet: it.metrics.rowsRet, spillMB: Math.round(it.metrics.spillBytes / 1048576) },
    sharesPct: it.shares,
    // 单次耗时构成与等待事件（模型解读"时间花在哪/主导等待事件"的依据；没有就说明为什么没有）
    profile: it.profile !== undefined
      ? { samples: it.profile.samples, avgDbMs: ms(it.profile.avgDbUs), partsMs: Object.fromEntries(it.profile.parts.map((p) => [p.name, ms(p.us)])), topWaits: it.profile.waits.slice(0, 4).map((w) => `${w.type} ${w.event} 均 ${ms(w.us)} ms/次（${w.pct}%）`) }
      : it.profileNote,
    explainOk: it.explainOk, origCost: it.origCost, plan: it.plan.slice(0, 20), planNotes: it.planFindings.map((f) => f.detail), note: it.note,
    rules: it.ruleRefs.map((i) => ruleFindings[i]).filter(Boolean).map((f) => ({ rule: f.rule, level: f.level, object: f.object, problem: f.problem })),
  }));
}

function defineSqlreviewCollectTool(deps: Deps) {
  return defineTool({
    name: 'sqlreview_collect',
    description: `Top SQL 报表确定性采集器：按指定维度（${Object.values(DIMENSIONS).map((d) => `${d.key}=${d.label}`).join('、')}）各取 dbe_perf.statement 的 Top-N，去重后每条带全量指标、占全库比例、榜位、类型判定、EXPLAIN 计划与脚本标注的优化点，并把 12 条审核规则的违规归到引用该表的 SQL 名下；另产出负载总量与脚本生成的「一眼结论」。结果自动存档供任务面板直读。用户在会话里说"按执行次数和耗时分别 Top5"就传 dimensions=["calls","elapsed"], topN=5。`,
    parameters: {
      node: { type: 'string', description: '目标节点名称；agent 只绑定一个节点时可省略。' },
      dimensions: { type: 'array', items: { type: 'string' }, description: '榜单维度数组（elapsed/calls/avg/cpu/io/blocks/dbtime/spill/rows，也接受中文如 "执行次数"）；省略 = ["elapsed","calls","avg"]。' },
      topN: { type: 'integer', description: '每个维度的榜单条数（默认 5，最多 20）。' },
      sqls: { type: 'array', items: { type: 'string' }, description: '只放榜单之外、用户自己贴的 SQL 文本；榜单里会出现的语句不要再传（同一条会按指纹合并进榜单项）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true } } },
      render: (_args: unknown, value: any) => [{ type: 'text', text: value.content }],
    },
    async execute(args: any, exec: any) {
      const { node } = await pickNode(deps.registry, exec, typeof args.node === 'string' && args.node !== '' ? args.node : undefined);
      const q = (sql: string, maxRows = 50) => deps.db.query(node, sql, { maxRows });
      const notes: string[] = [];
      const dims: DimKey[] = normalizeDimensions(args.dimensions);
      const topN = Math.max(1, Math.min(Number(args.topN ?? 5), 20));
      const extraSqls: string[] = Array.isArray(args.sqls) ? args.sqls.map(String).slice(0, 10) : [];
      const T = withSqlreviewThresholds(await deps.thresholds.resolve('sqlreview').catch(() => ({})));

      // 1) 多维榜单 + 去重明细（一次 workload + 每维度一次 Top-N）
      let top = { workload: { nSql: 0, calls: 0, elapsedUs: 0, cpuUs: 0, ioUs: 0, blocks: 0, blocksHit: 0, dbTimeUs: 0, rowsRet: 0, spillBytes: 0 }, boards: [] as any[], items: [] as TopSqlItem[] };
      try {
        top = await buildTopSql(q, dims, topN);
      } catch (cause) {
        notes.push(`Top SQL 榜单降级：dbe_perf.statement 不可读（${String((cause as Error).message ?? cause).slice(0, 120)}）`);
      }
      // 贴的 SQL 与榜单按指纹合并：同一条语句只保留榜单项（带指标/榜位），标 specified；其余才另立 Q 项
      const boardByFp = new Map(top.items.map((it) => [fingerprint(it.text), it]));
      const specified: TopSqlItem[] = [];
      for (const text of extraSqls) {
        const hit = boardByFp.get(fingerprint(text));
        if (hit !== undefined) { hit.specified = true; continue; }
        specified.push({ key: shortKey(text), label: `Q${specified.length + 1}`, uniqueSqlId: '', text: text.slice(0, 1200), kind: '指定', metrics: EMPTY_METRICS, shares: {}, ranks: {}, tables: [] });
      }
      const all: TopSqlItem[] = [...top.items, ...specified.filter((s) => !top.items.some((it) => it.key === s.key))];

      // 2) 逐条计划锚定（事务控制语句没有计划，不浪费一次 EXPLAIN）
      const items: CollectedItem[] = [];
      let explained = 0;
      for (const it of all) {
        let anchored: { explainOk: boolean; plan: string[]; planCost?: number; planFindings: any[]; note?: string };
        if (it.kind === '事务控制') anchored = { explainOk: false, plan: [], planFindings: [], note: '事务控制语句没有执行计划' };
        else if (explained >= deps.maxExplain) anchored = { explainOk: false, plan: [], planFindings: [], note: `超出逐条 EXPLAIN 上限（${deps.maxExplain}），未取计划` };
        else { explained += 1; anchored = await explainOne(q, it.text, T); }
        items.push({ ...it, explainOk: anchored.explainOk, plan: anchored.plan, origCost: anchored.planCost !== undefined ? String(anchored.planCost) : '', planFindings: anchored.planFindings, note: anchored.note, ruleRefs: [] });
      }

      // 2b) 单次耗时构成 + 等待事件：statement_history 最近 20 次执行均值（openGauss；只有进了慢 SQL 采样的语句才有行）
      if (String(node.engine) === 'opengauss') {
        for (const it of items) {
          if (it.kind === '事务控制' || it.kind === '指定' || it.uniqueSqlId === '') { it.profileNote = it.kind === '指定' ? '指定 SQL 无运行样本' : '事务控制语句不采样'; continue; }
          try {
            it.profile = await fetchExecProfile(q, it.uniqueSqlId, 20);
            if (it.profile === undefined) it.profileNote = '未进入 statement_history 采样（单次低于慢 SQL 阈值 / 未被抽样），无单次耗时构成与等待事件';
          } catch (cause) {
            it.profileNote = `耗时构成不可得：${String((cause as Error).message ?? cause).slice(0, 100)}`;
          }
        }
      }

      // 3) 规则引擎：目录类（联动 Top SQL 文本）+ 文本类；再按引用的表归因到各条 SQL
      const texts = items.map((s) => s.text);
      const ruleFindings: RuleFinding[] = [
        ...await runCatalogRules(q, texts, notes, T),
        ...textRules(items.map((s) => ({ key: s.key, text: s.text }))),
      ].sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level]);
      const attribution = attributeRules(items, ruleFindings);
      for (const it of items) it.ruleRefs = attribution.byKey[it.key] ?? [];

      // 4) hypopg 可用性（只探测不启用）
      let hypopg = false;
      try {
        const r = await q("SELECT count(*)::int AS n FROM pg_available_extensions WHERE name = 'hypopg'", 1);
        hypopg = Number(r.rows[0]?.n ?? 0) > 0;
      } catch { notes.push('hypopg 探测降级（pg_available_extensions 不可读）'); }

      // 5) det：规则违规 + 计划发现两类之和（语义沿用；2026-08-24 已把来源拆明）
      const zero = (): Record<RuleLevel, number> => ({ ok: 0, notice: 0, warn: 0, critical: 0 });
      const ruleCounts = zero();
      for (const f of ruleFindings) ruleCounts[f.level] += 1;
      const planCounts = zero();
      for (const s of items) for (const pf of s.planFindings) planCounts[pf.level as RuleLevel] += 1;
      const counts: Record<RuleLevel, number> = { ok: ruleCounts.ok + planCounts.ok, notice: ruleCounts.notice + planCounts.notice, warn: ruleCounts.warn + planCounts.warn, critical: ruleCounts.critical + planCounts.critical };
      const planFindingTotal = Object.values(planCounts).reduce((a, b) => a + b, 0);
      const worst = worstRuleLevel([
        ...ruleFindings,
        ...items.flatMap((s) => s.planFindings.map((pf) => ({ rule: pf.code, level: pf.level as RuleLevel, object: s.key, problem: '', advice: '', evidence: '' } as RuleFinding))),
      ]);
      const insights = insightsOf({ workload: top.workload, boards: top.boards, items: top.items }, dims, T);

      const payload = {
        scope: 'sql-set', node: node.name, dimensions: dims, topN, collectedAt: new Date().toISOString(),
        workload: top.workload, boards: top.boards, insights,
        items, ruleFindings, unattributedRules: attribution.unattributed,
        det: { worst, counts, countsBySource: { rule: ruleCounts, plan: planCounts }, totals: { rule: ruleFindings.length, plan: planFindingTotal, all: ruleFindings.length + planFindingTotal } },
        hypopg: { available: hypopg, note: hypopg ? '可用：可虚拟索引实证' : '不可用：索引类建议只能 estimated（og-lite 常态）' },
        collectionNotes: notes,
      };

      let archiveLine = '';
      if (deps.pool !== undefined) {
        try {
          const sessionId = typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : undefined;
          const id = await archive(deps.pool, sessionId, node.name, worst, payload);
          if (id !== undefined) archiveLine = `\n-- 采集已存档 opendb_task_collects#${id}（任务面板直读榜单/占比/违规；report 里不必复述数字）`;
        } catch (cause) {
          archiveLine = `\n-- 采集存档失败：${String((cause as Error).message ?? cause).slice(0, 120)}`;
        }
      }
      const header = [
        `-- sqlreview_collect · ${node.name} · 维度 ${dims.map((d) => DIMENSIONS[d].label).join('/')} · 各 Top ${topN} · 去重 ${items.length} 条 · 规则违规 ${ruleFindings.length} 条 · worst=${worst}（${LEVEL_CN[worst]}）`,
        `-- 一眼结论（脚本按占比生成）：${insights.length > 0 ? insights.map((i) => i.text).join('；') : '无'}`,
        `-- 以下 JSON 是唯一事实来源：det 逐字进报告；sqlItems 按 key 逐条给 optimizedSql/newCost/verify/detail（每条都要有）`,
        `-- 优化改写请另行 db_query EXPLAIN 实证（不要 EXPLAIN ANALYZE）；hypopg=${hypopg ? '可用' : '不可用'}`,
      ].join('\n');
      const forModel = { det: payload.det, node: node.name, dimensions: dims, workload: top.workload, insights: insights.map((i) => i.text), sqlItems: modelView(items, ruleFindings), unattributedRules: attribution.unattributed.map((i) => ruleFindings[i]).map((f) => ({ rule: f.rule, level: f.level, object: f.object, problem: f.problem })), collectionNotes: notes };
      return { content: clampText(`${header}${archiveLine}\n${JSON.stringify(forModel, null, 1)}`, deps.maxContentBytes) };
    },
  } as any);
}

export function apply(ctx: Context, config: { maxContentBytes?: number; connectionString?: string; maxExplain?: number } = {}): void {
  const anyCtx = ctx as any;
  const conn = config.connectionString ?? '';
  const pool = conn !== '' ? createPool(conn) : undefined;
  if (pool !== undefined) ctx.effect(() => () => pool.end(), 'tool-sqlreview-collect.pool');
  anyCtx.inject(['tools'], (c: any) => {
    const deps: Deps = {
      db: anyCtx.opendbDb,
      registry: anyCtx.opendbRegistry,
      thresholds: anyCtx.opendbThresholds,
      maxContentBytes: config.maxContentBytes ?? 60000,
      maxExplain: config.maxExplain ?? 24,
      pool,
    };
    c.effect(() => c.tools.register(defineSqlreviewCollectTool(deps)), 'tool-sqlreview-collect.sqlreview_collect');
  });
}
