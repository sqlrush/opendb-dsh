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
  resolveMode, matchStatements, fetchWorkload, TRACK_SHARE_DIMS,
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
    ...(it.ruleRefs.length > 0 ? { rules: it.ruleRefs.map((i) => ruleFindings[i]).filter(Boolean).map((f) => ({ rule: f.rule, level: f.level, object: f.object, problem: f.problem })) } : {}),
  }));
}

function defineSqlreviewCollectTool(deps: Deps) {
  return defineTool({
    name: 'sqlreview_collect',
    description: `Top SQL 报表确定性采集器：按指定维度（${Object.values(DIMENSIONS).map((d) => `${d.key}=${d.label}`).join('、')}）各取 dbe_perf.statement 的 Top-N，去重后每条带全量指标、占全库比例、榜位、类型判定、单次耗时构成与等待事件、EXPLAIN 计划与脚本标注的优化点；另产出负载总量与脚本生成的「一眼结论」。只谈性能不谈规范（规范规则默认不跑）。结果自动存档供任务面板直读。用户在会话里说"按执行次数和耗时分别 Top5"就传 dimensions=["calls","elapsed"], topN=5；说"跟踪这几条 SQL"就传 sqls=[原文], dimensions=[]。`,
    parameters: {
      node: { type: 'string', description: '目标节点名称；agent 只绑定一个节点时可省略。' },
      dimensions: { type: 'array', items: { type: 'string' }, description: '榜单维度数组（elapsed/calls/avg/cpu/io/blocks/dbtime/spill/rows，也接受中文如 "执行次数"）；省略 = ["elapsed","calls","avg"]。跟踪模式（只分析 sqls 里那几条）传 []。' },
      topN: { type: 'integer', description: '每个维度的榜单条数（默认 5，最多 20）；跟踪模式忽略。' },
      sqls: { type: 'array', items: { type: 'string' }, description: '跟踪模式：用户在对话里讨论/贴出并要求跟踪的 SQL 原文（配合 dimensions=[]，结果只含这几条，会到 dbe_perf.statement 里按指纹找它们的运行记录）。榜单模式留空。' },
      rules: { type: 'boolean', description: '是否附带 12 条规范规则的违规（默认 false：Top SQL 报表只谈性能，不谈规范）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true } } },
      render: (_args: unknown, value: any) => [{ type: 'text', text: value.content }],
    },
    async execute(args: any, exec: any) {
      const { node } = await pickNode(deps.registry, exec, typeof args.node === 'string' && args.node !== '' ? args.node : undefined);
      const q = (sql: string, maxRows = 50) => deps.db.query(node, sql, { maxRows });
      const notes: string[] = [];
      const extraSqls: string[] = Array.isArray(args.sqls) ? args.sqls.map(String).map((s: string) => s.trim()).filter((s: string) => s !== '').slice(0, 10) : [];
      // 模式：sqls 非空且 dimensions 明确为 [] = 跟踪模式（只跟踪对话里指定的那几条，不出榜）；否则榜单模式
      const mode = resolveMode({ dimensions: args.dimensions, sqls: extraSqls });
      const dims: DimKey[] = mode === 'track' ? [] : normalizeDimensions(args.dimensions);
      const topN = Math.max(1, Math.min(Number(args.topN ?? 5), 20));
      const T = withSqlreviewThresholds(await deps.thresholds.resolve('sqlreview').catch(() => ({})));

      // 1) 榜单模式：多维榜单 + 去重明细；跟踪模式：只取 workload 做分母
      let top = { workload: { nSql: 0, calls: 0, elapsedUs: 0, cpuUs: 0, ioUs: 0, blocks: 0, blocksHit: 0, dbTimeUs: 0, rowsRet: 0, spillBytes: 0 }, boards: [] as any[], items: [] as TopSqlItem[] };
      try {
        top = mode === 'track' ? { ...top, workload: await fetchWorkload(q) } : await buildTopSql(q, dims, topN);
      } catch (cause) {
        notes.push(`Top SQL 榜单降级：dbe_perf.statement 不可读（${String((cause as Error).message ?? cause).slice(0, 120)}）`);
      }
      // 会话里指定的 SQL：先与榜单按指纹合并（同一条不出两份），其余到 dbe_perf.statement 里找运行记录；找不到的只做计划与规范
      const boardByFp = new Map(top.items.map((it) => [fingerprint(it.text), it]));
      const lookup = extraSqls.filter((text) => !boardByFp.has(fingerprint(text)));
      let matched = new Map<string, TopSqlItem | undefined>();
      try { matched = await matchStatements(q, lookup, top.workload); } catch (cause) { notes.push(`指定 SQL 运行记录匹配降级：${String((cause as Error).message ?? cause).slice(0, 100)}`); }
      const specified: TopSqlItem[] = [];
      for (const text of extraSqls) {
        const hit = boardByFp.get(fingerprint(text));
        if (hit !== undefined) { hit.specified = true; hit.tracked = mode === 'track' ? true : hit.tracked; continue; }
        const found = matched.get(text);
        if (found !== undefined && !specified.some((s) => s.key === found.key)) { specified.push({ ...found, specified: true, tracked: true }); continue; }
        if (found === undefined) specified.push({ key: shortKey(text), label: '', uniqueSqlId: '', text: text.slice(0, 1200), kind: '指定', metrics: EMPTY_METRICS, shares: {}, ranks: {}, tables: [], specified: true, tracked: true });
      }
      // 统一 S 编号：榜单项在前（已编号），指定/跟踪项接着编（跟踪模式即 S1..Sn 按对话顺序）
      specified.forEach((s, i) => { s.label = `S${top.items.length + i + 1}`; });
      const all: TopSqlItem[] = [...top.items, ...specified.filter((s) => !top.items.some((it) => it.key === s.key))];
      // 占比条的维度：榜单只决定"谁上榜"，资源占比始终按六个标准资源维度画（配置里可分摊的维度排前面）。
      // 2026-08-28 user：只按平均耗时出 Top1 时整块占比没了——avg 不是可分摊资源，但上榜 SQL 的总耗时/CPU/IO 占比照样该看
      const shareDims: DimKey[] = mode === 'track'
        ? TRACK_SHARE_DIMS
        : [...dims.filter((d) => DIMENSIONS[d].shareable), ...TRACK_SHARE_DIMS.filter((d) => !dims.includes(d))];

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
          if (it.kind === '事务控制' || it.kind === '指定' || it.uniqueSqlId === '') { it.profileNote = it.kind === '指定' ? '在 dbe_perf.statement 里没有找到这条 SQL 的运行记录（未执行过或文本差异），无运行指标/耗时构成/等待事件' : '事务控制语句不采样'; continue; }
          try {
            it.profile = await fetchExecProfile(q, it.uniqueSqlId, 20);
            if (it.profile === undefined) it.profileNote = '未进入 statement_history 采样（单次低于慢 SQL 阈值 / 未被抽样），无单次耗时构成与等待事件';
          } catch (cause) {
            it.profileNote = `耗时构成不可得：${String((cause as Error).message ?? cause).slice(0, 100)}`;
          }
        }
      }

      // 3) 规范规则（目录类 + 文本类）默认不再进 Top SQL 报表（user 2026-08-27：规范与优化方案没关系，大盘里去掉）；
      //    规则引擎本身保留（规则总览/阈值配置仍登记它们），rules=true 时才跑并归因
      const withRules = args.rules === true;
      const texts = items.map((s) => s.text);
      const ruleFindings: RuleFinding[] = withRules
        ? [...await runCatalogRules(q, texts, notes, T), ...textRules(items.map((s) => ({ key: s.key, text: s.text })))].sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level])
        : [];
      const attribution = withRules ? attributeRules(items, ruleFindings) : { byKey: {} as Record<string, number[]>, unattributed: [] as number[] };
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
      const insights = insightsOf({ workload: top.workload, boards: top.boards, items: all.filter((it) => it.kind !== '指定') }, shareDims, T);

      const payload = {
        scope: 'sql-set', node: node.name, mode, dimensions: dims, shareDims, topN, trackedCount: extraSqls.length, collectedAt: new Date().toISOString(),
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
        mode === 'track'
          ? `-- sqlreview_collect · ${node.name} · 跟踪模式：会话指定 ${extraSqls.length} 条（找到运行记录 ${items.filter((it) => it.kind !== '指定').length} 条）· 不出榜 · 计划发现 ${planFindingTotal} 条 · worst=${worst}（${LEVEL_CN[worst]}）`
          : `-- sqlreview_collect · ${node.name} · 维度 ${dims.map((d) => DIMENSIONS[d].label).join('/')} · 各 Top ${topN} · 去重 ${items.length} 条 · 计划发现 ${planFindingTotal} 条 · worst=${worst}（${LEVEL_CN[worst]}）`,
        `-- 一眼结论（脚本按占比生成）：${insights.length > 0 ? insights.map((i) => i.text).join('；') : '无'}`,
        `-- 以下 JSON 是唯一事实来源：det 逐字进报告；sqlItems 按 key 逐条给 optimizedSql/newCost/verify/detail（每条都要有）`,
        `-- 优化改写请另行 db_query EXPLAIN 实证（不要 EXPLAIN ANALYZE）；hypopg=${hypopg ? '可用' : '不可用'}`,
      ].join('\n');
      const forModel = { det: payload.det, node: node.name, mode, dimensions: dims, workload: top.workload, insights: insights.map((i) => i.text), sqlItems: modelView(items, ruleFindings), collectionNotes: notes };
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
