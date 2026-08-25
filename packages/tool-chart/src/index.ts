/**
 * tool-chart — metrics_chart / chart_render（Runtime 侧）。
 * user 2026-08-24：曲线图、趋势图、对比图在会话里展示是 opendb 的核心功能——要给客户看核心健康
 * 指标的变化趋势。此前平台没有画图工具，模型只能在代码块里用 ▇ 字符"画"柱子（prd 截图）。
 *
 * 分工：本工具在服务端取数、差分、比例、降采样、叠阈值线，输出紧凑的图表 JSON；
 * ui-chart 的会话内联卡接管渲染（SVG 折线/面积/柱状 + hover 提示 + 图例统计）。
 * 模型不再拿原始计数自己算、也不再用文本画图——工具描述里明说。
 *
 * 独立 function plugin（工具注册定论）。输出 = `--` 注释头 + JSON（与各 *_collect 同形）。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { pickNode, resolvePlatformAgent, clampText } from '@opendb-dsh/tool-db';
import { toAsc, downsample, stats, round4, type Pt } from './series.ts';
import { resolveMetric, compute, listCatalogMarkdown, type MetricDef } from './catalog.ts';

export { METRIC_CATALOG, resolveMetric, compute } from './catalog.ts';
export * from './series.ts';

export const name = 'tool-chart';
export const inject = ['opendbMetrics', 'opendbRegistry', 'opendbThresholds'];
export const Config = z.object({
  maxContentBytes: z.number().step(1).min(4096).default(60000),
  maxPoints: z.number().step(1).min(30).max(1000).default(120).description('每条序列降采样后的点数上限（图上够用，token 也省）'),
});

interface Deps { metrics: any; registry: any; thresholds: any; maxContentBytes: number; maxPoints: number }

const TEXT_OUTPUT = {
  schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true } } },
  render: (_args: unknown, value: any) => [{ type: 'text', text: value.content }],
} as const;

const MAX_MINUTES = 7 * 24 * 60;
const MAX_SERIES = 12;

/** 时间点压成 [距 t0 的秒数, 值]：120 点 × 两个小整数，一条序列 ~1.5KB，模型读得起 */
function packTime(pts: Pt[], t0: number): [number, number][] {
  return pts.map(([t, v]) => [Math.round((t - t0) / 1000), round4(v)]);
}

const HEADER_HINT = [
  '-- 图表已在会话里渲染为交互式曲线（ui-chart），用户能直接看到坐标轴、各点数值与阈值线。',
  '-- 不要再用文本/表格/ASCII 复述数据点；用两三句话解读趋势即可：峰值出现在何时、均值水平、是否越过阈值线、前后对比。',
];

function defineMetricsChartTool(deps: Deps) {
  return defineTool({
    name: 'metrics_chart',
    description: '把节点的核心健康指标画成曲线/趋势/对比图，在会话里直接渲染。**用户要看曲线图、趋势图、走势、对比、"最近 N 小时的 xx 变化"时必须用本工具，不要用 metrics_recent 拿数字后自己用文本或 ASCII 画图。** 服务端负责累计计数器差分（TPS/QPS/CPU/命中率都是差分得到）、降采样与阈值线叠加。语义指标：'
      + 'tps qps rollback_rate avg_latency_ms cpu io_wait cache_hit connections active_sessions idle_sessions idle_in_xact waiting_locks load load_per_core wait_lwlock wait_io wait_lock；也接受原始 db.* 指标名（按原值画）。',
    parameters: {
      metrics: { type: 'array', items: { type: 'string' }, required: true, description: '要画的指标（1~6 个），如 ["tps","qps"]；每个指标一张图。' },
      node: { type: 'string', description: '目标节点名称；agent 只绑定一个节点时可省略。' },
      nodes: { type: 'array', items: { type: 'string' }, description: '多节点对比：同一张图上叠多条线；填了则忽略 node。' },
      minutes: { type: 'integer', description: '回看窗口分钟数（默认 60，最大 10080=7 天）。' },
      kind: { type: 'string', description: 'line（默认）/ area / bar。' },
      title: { type: 'string', description: '图表总标题（可省略，自动生成）。' },
    },
    output: TEXT_OUTPUT,
    async execute(args: any, exec: any) {
      const metricNames: string[] = Array.isArray(args.metrics) ? args.metrics.map(String).filter((s: string) => s.trim() !== '').slice(0, 6) : [];
      if (metricNames.length === 0) return { content: '-- metrics_chart 失败\nmetrics 至少给一个指标，例如 ["tps","qps"]。可用语义指标：\n' + listCatalogMarkdown() };
      const minutes = Math.max(5, Math.min(Number(args.minutes ?? 60) || 60, MAX_MINUTES));
      const kind = ['line', 'area', 'bar'].includes(String(args.kind)) ? String(args.kind) : 'line';

      // 节点：多节点对比 or 单节点
      let nodes: { id: string; name: string }[] = [];
      if (Array.isArray(args.nodes) && args.nodes.length > 0) {
        const agent = await resolvePlatformAgent(deps.registry, exec?.agent);
        if (agent === undefined) return { content: '-- metrics_chart 失败\n无法确定当前会话所属的智能体' };
        const bound = await deps.registry.listNodes({ agentId: agent.id });
        const wanted = new Set(args.nodes.map(String));
        nodes = bound.filter((n: any) => wanted.has(n.name));
        if (nodes.length === 0) return { content: `-- metrics_chart 失败\nnodes ${JSON.stringify(args.nodes)} 都不在本智能体绑定的节点里` };
      } else {
        const { node } = await pickNode(deps.registry, exec, typeof args.node === 'string' && args.node !== '' ? args.node : undefined);
        nodes = [node];
      }
      if (nodes.length * metricNames.length > MAX_SERIES) {
        return { content: `-- metrics_chart 失败\n节点数 × 指标数 = ${nodes.length * metricNames.length} 超过上限 ${MAX_SERIES}，请减少指标或节点` };
      }

      const notes: string[] = [];
      const defs: MetricDef[] = metricNames.map(resolveMetric);
      const t1 = Date.now();
      const t0 = t1 - minutes * 60_000;
      const limit = Math.min(12000, Math.max(200, Math.ceil(minutes * 1.2)));

      // 阈值线：按指标定义里的 health 阈值组取当前生效值
      let healthT: Record<string, number> = {};
      try { healthT = await deps.thresholds.resolve('health'); } catch { notes.push('阈值服务不可读，本图不叠阈值线'); }

      const charts = [];
      for (const def of defs) {
        const series = [];
        for (const node of nodes) {
          const fetched: Record<string, Pt[]> = {};
          for (const raw of def.raw) {
            try {
              const rows = await deps.metrics.recent(node.id, raw, minutes, limit);
              fetched[raw] = toAsc(rows);
            } catch (cause) {
              fetched[raw] = [];
              notes.push(`${node.name} ${raw} 读取失败：${String((cause as Error).message ?? cause).slice(0, 80)}`);
            }
          }
          const full = compute(def, fetched);
          if (full.length === 0) { notes.push(`${node.name} 的 ${def.key} 在最近 ${minutes} 分钟没有数据（原始指标 ${def.raw.join('+')} 未采集或窗口内无点）`); continue; }
          const st = stats(full);
          series.push({
            name: node.name,
            points: packTime(downsample(full, deps.maxPoints), t0),
            stats: { min: round4(st.min), max: round4(st.max), avg: round4(st.avg), last: round4(st.last), n: st.n, maxAt: st.maxAt !== undefined ? Math.round((st.maxAt - t0) / 1000) : undefined },
          });
        }
        const thresholds: { label: string; value: number; level: string }[] = [];
        if (def.threshold !== undefined) {
          for (const level of ['notice', 'warn', 'critical']) {
            const v = healthT[`${def.threshold.group}.${level}`];
            if (typeof v === 'number') thresholds.push({ label: level, value: v, level });
          }
        }
        charts.push({ key: def.key, label: def.label, unit: def.unit, desc: def.desc, computed: def.kind !== 'gauge', series, thresholds });
      }
      const drawn = charts.filter((c) => c.series.length > 0);
      if (drawn.length === 0) {
        return { content: `-- metrics_chart：没有可画的数据\n${notes.join('\n')}\n提示：collector 每分钟采一次；语义指标依赖的原始键见目录。` };
      }
      const payload = {
        v: 1, kind, xType: 'time', t0, t1, minutes,
        title: typeof args.title === 'string' && args.title !== '' ? args.title : `${nodes.map((n) => n.name).join(' vs ')} · 最近 ${minutes >= 60 ? `${Math.round(minutes / 60)} 小时` : `${minutes} 分钟`}`,
        charts: drawn, notes,
      };
      const summary = drawn.map((c) => `${c.label}：${c.series.map((s) => `${s.name} 最新 ${s.stats.last} / 均 ${s.stats.avg} / 峰 ${s.stats.max}`).join('；')}`).join('\n-- ');
      const header = [`-- metrics_chart · ${payload.title} · ${drawn.length} 张图 · ${kind}`, `-- ${summary}`, ...HEADER_HINT].join('\n');
      return { content: clampText(`${header}\n${JSON.stringify(payload)}`, deps.maxContentBytes) };
    },
  } as any);
}

function defineChartRenderTool(deps: Deps) {
  return defineTool({
    name: 'chart_render',
    description: '把任意一组数据画成图（折线/面积/柱状）并在会话里渲染——用于 metrics_chart 覆盖不到的数据：WDR 两快照的对比、db_query 查出来的分组统计、任务报告里的数字等。**凡是要给用户看图，就用本工具，不要用文本或 ASCII 画。** 时间轴给 ISO 时间或毫秒，分类轴给字符串标签。',
    parameters: {
      title: { type: 'string', required: true, description: '图表标题。' },
      kind: { type: 'string', description: 'line（默认）/ area / bar；分类对比建议 bar。' },
      unit: { type: 'string', description: '数值单位：ratio（0~1，显示为百分比）/ per_s / count / ms / bytes / x（无单位）。' },
      x_type: { type: 'string', description: 'time（默认，x 为时间）或 category（x 为标签）。' },
      series: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: '序列名（图例）。' },
            points: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: { x: { type: 'string' }, y: { type: 'number', required: true } } }, description: '点列：{x, y}。x 为 ISO 时间/毫秒（time）或标签（category）。' },
          },
        },
        description: '1~8 条序列，每条 ≤ 1000 点。',
      },
      y_label: { type: 'string', description: 'y 轴说明（可省略）。' },
    },
    output: TEXT_OUTPUT,
    async execute(args: any) {
      const seriesIn: any[] = Array.isArray(args.series) ? args.series.slice(0, 8) : [];
      if (seriesIn.length === 0) return { content: '-- chart_render 失败\nseries 至少一条' };
      const xType = String(args.x_type ?? 'time') === 'category' ? 'category' : 'time';
      const kind = ['line', 'area', 'bar'].includes(String(args.kind)) ? String(args.kind) : (xType === 'category' ? 'bar' : 'line');
      const unit = ['ratio', 'per_s', 'count', 'ms', 'bytes', 'x'].includes(String(args.unit)) ? String(args.unit) : 'x';
      const notes: string[] = [];
      const categories: string[] = [];
      const catIndex = new Map<string, number>();
      let t0 = Infinity; let t1 = -Infinity;
      const parsed = seriesIn.map((s) => {
        const pts: Pt[] = [];
        for (const p of (Array.isArray(s.points) ? s.points.slice(0, 1000) : [])) {
          const y = Number(p?.y);
          if (!Number.isFinite(y)) continue;
          if (xType === 'time') {
            const x = typeof p?.x === 'number' ? p.x : Date.parse(String(p?.x ?? ''));
            if (!Number.isFinite(x)) continue;
            t0 = Math.min(t0, x); t1 = Math.max(t1, x);
            pts.push([x, y]);
          } else {
            const label = String(p?.x ?? '');
            if (!catIndex.has(label)) { catIndex.set(label, categories.length); categories.push(label); }
            pts.push([catIndex.get(label) as number, y]);
          }
        }
        return { name: String(s?.name ?? '序列'), pts: xType === 'time' ? pts.sort((a, b) => a[0] - b[0]) : pts };
      }).filter((s) => s.pts.length > 0);
      if (parsed.length === 0) return { content: '-- chart_render 失败\n没有一条序列含有效点（y 必须是数值；time 轴的 x 必须能解析为时间）' };
      if (xType === 'time' && !Number.isFinite(t0)) { t0 = 0; t1 = 0; }
      const series = parsed.map((s) => {
        const st = stats(s.pts);
        const pts = xType === 'time' ? packTime(downsample(s.pts, deps.maxPoints), t0) : s.pts.map(([x, v]) => [x, round4(v)] as [number, number]);
        return { name: s.name, points: pts, stats: { min: round4(st.min), max: round4(st.max), avg: round4(st.avg), last: round4(st.last), n: st.n } };
      });
      const payload = {
        v: 1, kind, xType, t0: xType === 'time' ? t0 : undefined, t1: xType === 'time' ? t1 : undefined, categories: xType === 'category' ? categories : undefined,
        title: String(args.title ?? '图表'),
        charts: [{ key: 'custom', label: String(args.title ?? '图表'), unit, desc: typeof args.y_label === 'string' ? args.y_label : '', computed: false, series, thresholds: [] }],
        notes,
      };
      const header = [`-- chart_render · ${payload.title} · ${series.length} 条序列 · ${kind}`, ...HEADER_HINT].join('\n');
      return { content: clampText(`${header}\n${JSON.stringify(payload)}`, deps.maxContentBytes) };
    },
  } as any);
}

export function apply(ctx: Context, config: { maxContentBytes?: number; maxPoints?: number } = {}): void {
  const anyCtx = ctx as any;
  anyCtx.inject(['tools'], (c: any) => {
    const deps: Deps = {
      metrics: anyCtx.opendbMetrics,
      registry: anyCtx.opendbRegistry,
      thresholds: anyCtx.opendbThresholds,
      maxContentBytes: config.maxContentBytes ?? 60000,
      maxPoints: config.maxPoints ?? 120,
    };
    c.effect(() => c.tools.register(defineMetricsChartTool(deps)), 'tool-chart.metrics_chart');
    c.effect(() => c.tools.register(defineChartRenderTool(deps)), 'tool-chart.chart_render');
  });
}
