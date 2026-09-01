/**
 * 规则命中统计：目录页右侧「近 N 天命中」的数据来源。
 *
 * 只读采集存档，不碰报告——存档是脚本产出的确定性结果，报告里是模型叙述。
 * 口径：命中运行数 / 该插件同期运行数，只计 **非 ok** 的发现（容量插件每次都会为每个维度出一条
 * 含 ok 的判定，按条数统计会全是满分，毫无信息量）。
 *
 * 两种存档形状：
 *   健康  → opendb_health_collects.payload.nodes[].findings[]（每节点一组）
 *   其余  → opendb_task_collects.payload.ruleFindings[] 或 .findings[]（字段名按插件不同）
 * 规则码字段同样两种：`code`（health / sqlreview / wdr / capacity）与 `rule`（ddl）。
 */
import type pg from 'pg';

export interface RuleStat {
  code: string;
  hit: number;                 // 命中的运行次数（非 ok）
  worst: string;               // 这些命中里最严重的级别
  lastAt: string | null;       // 最近一次命中时间
  lastText: string;            // 最近一次命中的原文（problem / detail），供面板展示"长这样"
}

export interface PluginStat {
  plugin: string;
  runs: number;                // 同期产出过规则判定的运行次数（分母）
  rules: RuleStat[];
}

const LV = { critical: 3, warn: 2, notice: 1, ok: 0 } as const;
const worstOf = (a: string, b: string): string => ((LV as Record<string, number>)[b] ?? 0) > ((LV as Record<string, number>)[a] ?? 0) ? b : a;

/** 任务类采集存档（sqlreview / wdr / ddl / capacity）：一次运行一行 payload */
const TASK_SQL = `
  SELECT coalesce(f->>'code', f->>'rule') AS code,
         coalesce(f->>'level', 'ok')      AS lvl,
         c.id, c.collected_at,
         coalesce(f->>'problem', f->>'detail', f->>'title', '') AS text
    FROM opendb_task_collects c,
         LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(c.payload->'ruleFindings') = 'array' THEN c.payload->'ruleFindings'
                WHEN jsonb_typeof(c.payload->'findings')     = 'array' THEN c.payload->'findings'
                ELSE '[]'::jsonb END) f
   WHERE c.task_type = $1 AND c.collected_at > now() - ($2 || ' days')::interval`;

/** 健康采集存档：findings 挂在每个节点下 */
const HEALTH_SQL = `
  SELECT f->>'code' AS code, coalesce(f->>'level', 'ok') AS lvl, c.id, c.collected_at,
         coalesce(f->>'detail', f->>'problem', '') AS text
    FROM opendb_health_collects c,
         LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload->'nodes') = 'array' THEN c.payload->'nodes' ELSE '[]'::jsonb END) nd,
         LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(nd->'findings') = 'array' THEN nd->'findings' ELSE '[]'::jsonb END) f
   WHERE c.collected_at > now() - ($1 || ' days')::interval`;

/** 分母：同期有规则判定产出的运行数（没产出任何判定的运行不计，否则 sqlreview 的 topN 模式会稀释比例） */
function countRuns(rows: { id: unknown }[]): number {
  return new Set(rows.map((r) => String(r.id))).size;
}

function fold(rows: { code: unknown; lvl: unknown; id: unknown; collected_at: unknown; text: unknown }[]): RuleStat[] {
  const byCode = new Map<string, { runs: Set<string>; worst: string; lastAt: number; lastText: string }>();
  for (const r of rows) {
    const code = String(r.code ?? '');
    const lvl = String(r.lvl ?? 'ok');
    if (code === '' || lvl === 'ok') continue;
    const at = new Date(String(r.collected_at)).getTime();
    const cur = byCode.get(code) ?? { runs: new Set<string>(), worst: 'notice', lastAt: 0, lastText: '' };
    cur.runs.add(String(r.id));
    cur.worst = worstOf(cur.worst, lvl);
    if (at >= cur.lastAt) { cur.lastAt = at; cur.lastText = String(r.text ?? ''); }
    byCode.set(code, cur);
  }
  return [...byCode.entries()]
    .map(([code, v]) => ({ code, hit: v.runs.size, worst: v.worst, lastAt: v.lastAt === 0 ? null : new Date(v.lastAt).toISOString(), lastText: v.lastText }))
    .sort((a, b) => b.hit - a.hit);
}

/** 五个插件的近 days 天命中统计；某个插件查询失败不拖垮整页（返回 runs=0） */
export async function ruleStats(pool: pg.Pool, days: number): Promise<PluginStat[]> {
  const taskPlugins = ['sqlreview', 'wdr', 'ddl', 'capacity'];
  const [health, ...tasks] = await Promise.all([
    pool.query(HEALTH_SQL, [String(days)]).then((r) => r.rows).catch(() => []),
    ...taskPlugins.map((p) => pool.query(TASK_SQL, [p, String(days)]).then((r) => r.rows).catch(() => [])),
  ]);
  return [
    { plugin: 'health', runs: countRuns(health), rules: fold(health) },
    ...taskPlugins.map((p, i) => ({ plugin: p, runs: countRuns(tasks[i]), rules: fold(tasks[i]) })),
  ];
}
