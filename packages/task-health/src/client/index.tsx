/**
 * task-health client 面板（2026-08-26 改造版，user 三点）：
 *   ① 十二维每维都有数、有解释、有阈值：直读采集存档（runs/list 附带的 collect，来自 opendb_health_collects），
 *      每个数字都来自采集器；模型报告只贡献「根因串联 / 处置优先级」两段叙述。
 *   ② 发现与维度带图：占比 → 阈值水位（Gauge）；分布 → 柱/饼；趋势 → 平台指标库最近 1 小时曲线 + 历次检查折线。
 *   ③ 「在会话里深挖」= 一键新建会话并自动发送带背景的提示词，页面直接跳到该会话。
 * 旧报告（无 collect）退回只按 findings 展示。视觉 token = dsh 原版基准；只读展示。
 */
import { useEffect, useMemo, useState } from 'react';
import { Bars, Pie, Gauge, Line, SEV, fmtValue, type Level, type Unit } from '@opendb-dsh/chart-kit';

// 深挖要用 sessions / connection / workspaces：列进 inject 保证 apply 时服务已就绪
export const inject = ['slots', 'connection', 'workspaces', 'sessions'];

const T = {
  ink: '#0f1115', sub: '#61666b', dim: '#81858c', blue: '#4176e6',
  line: 'rgba(0,0,0,.08)', fill: '#f7f8fa', blueSoft: '#e4edfd',
  sev: {
    ok: { c: SEV.ok, soft: '#e8f5ec', cn: '正常', grad: 'linear-gradient(135deg,#3fa552,#2f8541)' },
    notice: { c: SEV.notice, soft: '#faf3e5', cn: '关注', grad: 'linear-gradient(135deg,#c9862d,#a96e1f)' },
    warn: { c: SEV.warn, soft: '#fdf0e3', cn: '告警', grad: 'linear-gradient(135deg,#e07a1f,#c9640f)' },
    critical: { c: SEV.critical, soft: '#fdecec', cn: '严重', grad: 'linear-gradient(135deg,#d64545,#b53434)' },
  } as Record<string, { c: string; soft: string; cn: string; grad: string }>,
};
const sev = (l: string) => T.sev[l] ?? T.sev.ok;
const ORDER: Record<string, number> = { critical: 3, warn: 2, notice: 1, ok: 0 };
const card: any = { background: '#fff', border: `1px solid ${T.line}`, borderRadius: 8, padding: '16px 20px', boxShadow: '0 4px 12px rgba(0,0,0,.02),0 2px 8px rgba(0,0,0,.03)' };
const mono = '"JetBrains Mono","SF Mono",Menlo,monospace';
const asLevel = (l: unknown): Level => (['ok', 'notice', 'warn', 'critical'].includes(String(l)) ? (String(l) as Level) : 'ok');
const asUnit = (u: unknown): Unit => (['ratio', 'count', 'ms', 's', 'bytes', 'x', 'per_s', 'text'].includes(String(u)) ? (String(u) as Unit) : 'count');

/** 客户端 ctx（apply 时捕获）：深挖要用 sessions / connection / workspaces */
let clientCtx: any;

function H2({ children }: { children: any }) {
  return <div style={{ fontSize: 18, fontWeight: 600, margin: '30px 0 14px', color: T.ink, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{children}</div>;
}
function Hint({ children }: { children: any }) {
  return <span style={{ fontSize: 13.5, color: T.dim, fontWeight: 400 }}>{children}</span>;
}
function Dot({ level }: { level: string }) {
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: sev(level).c, marginRight: 6, flex: 'none' }} />;
}
function Tag({ level }: { level: string }) {
  const s = sev(level);
  return <span style={{ fontSize: 11.5, fontWeight: 600, color: s.c, background: s.soft, borderRadius: 5, padding: '1px 7px' }}>{s.cn}</span>;
}

/** 12 维清单（与 collectors.ts COLLECTORS 对齐）；旧报告无 collect 时环与矩阵从 findings 派生 */
const DIMS: { dim: string; title: string }[] = [
  { dim: 'overview', title: '总览' }, { dim: 'waits', title: '等待事件' }, { dim: 'slowsql', title: '慢 SQL' },
  { dim: 'xact', title: '长·空闲事务' }, { dim: 'bloat', title: '膨胀' }, { dim: 'lwlock', title: 'LWLock' },
  { dim: 'lockchain', title: '锁与阻塞链' }, { dim: 'connections', title: '连接' }, { dim: 'ckpt', title: 'Checkpoint/WAL' },
  { dim: 'replication', title: '主备复制' }, { dim: 'objects', title: '对象与索引' }, { dim: 'concurrency', title: '事务并发' },
  { dim: 'os', title: '主机资源' },
];
const CODE_DIM: [RegExp, string][] = [
  [/^XACT_PREPARED/, 'concurrency'], [/^XACT_/, 'xact'], [/^CACHE_/, 'overview'], [/^WAIT_/, 'waits'],
  [/^SLOWSQL/, 'slowsql'], [/^BLOAT_/, 'bloat'], [/^LWLOCK_/, 'lwlock'], [/^LOCK_/, 'lockchain'],
  [/^CONN_/, 'connections'], [/^CKPT_/, 'ckpt'], [/^REPL_/, 'replication'], [/^IDX_/, 'objects'],
  [/^SESS_/, 'concurrency'], [/^NODE_/, 'overview'], [/^OS_/, 'os'],
];
function dimOf(f: any): string {
  const d = String(f.dim ?? '');
  if (d !== '') return d;
  const code = String(f.code ?? '');
  for (const [re, dim] of CODE_DIM) if (re.test(code)) return dim;
  return '';
}
function dimStates(findings: any[]): { dim: string; title: string; worst: string; top?: any }[] {
  return DIMS.map((d) => {
    const list = findings.filter((f) => dimOf(f) === d.dim).sort((a, b) => (ORDER[String(b.level)] ?? 0) - (ORDER[String(a.level)] ?? 0));
    return { ...d, worst: list[0] !== undefined ? String(list[0].level) : 'ok', top: list[0] };
  });
}

// ───────────────────────────────────────────── 深挖：一键开会话并发送
async function digInSession(text: string): Promise<string> {
  if (clientCtx === undefined) throw new Error('客户端上下文未就绪');
  const ws = clientCtx.workspaces?.list?.getSnapshot?.()?.items?.[0];
  const sessionId: string = await clientCtx.sessions.create(ws?.workspaceId !== undefined ? { workspaceId: ws.workspaceId } : {});
  const bridge = (window as any).__opendbHarness__;
  if (typeof bridge?.openSession === 'function') bridge.openSession(sessionId); else clientCtx.sessions.open(sessionId);
  const r = await clientCtx.connection.rpc.call('/api', 'session.prompt', {
    sessionId, mode: 'queue', content: [{ type: 'text', text }],
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  if (r?.ok === false) throw new Error(String(r.error?.message ?? 'prompt rejected'));
  return sessionId;
}

function DigButton({ prompt, label = '在会话里深挖' }: { prompt: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'fail'>('idle');
  const [err, setErr] = useState('');
  return (
    <button type="button" disabled={state === 'busy'}
      onClick={() => { setState('busy'); digInSession(prompt).then(() => setState('idle')).catch((e) => { setErr(String(e?.message ?? e)); setState('fail'); }); }}
      style={{ font: '500 12.5px inherit', color: state === 'fail' ? T.sev.critical.c : T.blue, background: state === 'fail' ? T.sev.critical.soft : T.blueSoft, border: 'none', borderRadius: 6, padding: '4px 10px', cursor: state === 'busy' ? 'wait' : 'pointer' }}
      title="新建会话，自动发送带背景的深挖提示词">
      {state === 'busy' ? '正在开会话并发送…' : state === 'fail' ? `深挖失败：${err.slice(0, 40)}（点击重试）` : `💬 ${label}`}
    </button>
  );
}

/** 深挖提示词：背景（实例/维度/指标/阈值/证据/同维指标）+ 任务 */
function digPrompt(node: string, when: string, f: any, dim?: any): string {
  const measures: any[] = dim?.measures ?? [];
  const lines = [
    `【健康检查深挖】实例 ${node} · 报告时间 ${when}${dim !== undefined ? ` · 维度「${String(dim.title)}」` : ''}`,
    `发现：[${String(f.code ?? '')}] ${sev(String(f.level)).cn} · ${String(f.item ?? f.detail ?? '')}`,
    String(f.metric ?? '') !== '' ? `指标：${String(f.metric)} 实测 ${String(f.value ?? '')}（阈值 ${String(f.threshold ?? '')}）` : '',
    String(f.detail ?? '') !== '' ? `解读：${String(f.detail)}` : '',
    String(f.evidence ?? '') !== '' ? `证据：${String(f.evidence)}` : '',
    measures.length > 0 ? `同维关键指标：${measures.map((m) => `${String(m.label)}=${typeof m.value === 'number' ? fmtValue(m.value, asUnit(m.unit)) : String(m.value)}（${sev(String(m.level)).cn}）`).join('；')}` : '',
    '任务：请围绕这条发现深挖根因——先用工具（metrics_chart / metrics_recent / health_collect / sqlreview_collect 等）取最近数据取证，再给出：1) 根因判断与依据；2) 影响面；3) 处置建议（本平台只读，不执行任何变更）。不要向我反问，直接给结论。',
  ].filter((s) => s !== '');
  return lines.join('\n');
}

// ───────────────────────────────────────────── 图表适配
function DimChartView({ c }: { c: any }) {
  const unit = asUnit(c.unit);
  const items = (c.items ?? []).map((it: any) => ({ name: String(it.name), value: Number(it.value) }));
  if (c.kind === 'pie') return <Pie items={items} unit={unit} size={104} />;
  if (c.kind === 'gauge') {
    const v = Number(items[0]?.value ?? 0);
    const tiers = c.tiers ?? {};
    const lv = levelOf(v, tiers, c.cmp === '<' ? '<' : '>=');
    return <Gauge value={v} tiers={tiers} cmp={c.cmp === '<' ? '<' : '>='} level={lv} unit={unit} />;
  }
  return <Bars items={items} unit={unit} />;
}
function levelOf(v: number, tiers: Record<string, number>, cmp: '>=' | '<'): Level {
  for (const l of ['critical', 'warn', 'notice'] as Level[]) {
    const t = tiers[l];
    if (typeof t === 'number' && ((cmp === '>=' && v >= t) || (cmp === '<' && v < t))) return l;
  }
  return 'ok';
}

// ───────────────────────────────────────────── ① 十二维卡片（直读采集）
function MeasureRow({ m }: { m: any }) {
  const unit = asUnit(m.unit);
  const level = asLevel(m.level);
  const valueText = typeof m.value === 'number' ? fmtValue(m.value, unit) : String(m.value);
  const tiers = m.rule?.tiers ?? {};
  const hasTiers = Object.keys(tiers).length > 0;
  return (
    <div style={{ padding: '8px 0', borderTop: `1px solid ${T.line}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: T.sub }}>{String(m.label)}</span>
        <b style={{ fontSize: 17, color: level === 'ok' ? T.ink : sev(level).c, fontFamily: unit === 'text' ? undefined : mono }}>{valueText}</b>
        {m.rule !== undefined ? <Tag level={level} /> : <span style={{ fontSize: 11.5, color: T.dim }}>观测值</span>}
      </div>
      <div style={{ fontSize: 12.5, color: T.dim, marginTop: 2 }}>{String(m.desc ?? '')}</div>
      {hasTiers && unit === 'ratio' && typeof m.value === 'number' ? <Gauge value={m.value} tiers={tiers} cmp={m.rule.cmp} level={level} unit="ratio" /> : null}
      {m.rule !== undefined ? (
        <div style={{ fontSize: 12.5, color: level === 'ok' ? T.sub : sev(level).c, marginTop: 4 }}>
          {hasTiers ? <span style={{ fontFamily: mono, marginRight: 6 }}>{['notice', 'warn', 'critical'].filter((l) => tiers[l] !== undefined).map((l) => `${sev(l).cn}${m.rule.cmp}${fmtValue(tiers[l], unit)}`).join(' → ')}</span> : null}
          {String(m.why ?? '')}
        </div>
      ) : null}
    </div>
  );
}

function DimCard({ d, node, when }: { d: any; node: string; when: string }) {
  const worst = String(d.worst ?? 'ok');
  const measures: any[] = d.measures ?? [];
  const charts: any[] = (d.charts ?? []).filter((c: any) => c.kind !== 'gauge' || !measures.some((m) => m.rule?.thresholdKey !== undefined && asUnit(m.unit) === 'ratio'));
  const findings: any[] = d.findingsOfDim ?? [];
  return (
    <div style={{ ...card, borderTop: `3px solid ${sev(worst).c}`, padding: '12px 16px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Dot level={worst} /><b style={{ fontSize: 15 }}>{String(d.title)}</b>
        <span style={{ marginLeft: 'auto' }}><Tag level={worst} /></span>
      </div>
      {d.ok === false ? <div style={{ fontSize: 12.5, color: T.sev.warn.c, marginTop: 6 }}>采集降级：{String(d.note ?? '')}（该维不产结论）</div> : null}
      {measures.length === 0 && d.ok !== false ? <div style={{ fontSize: 12.5, color: T.dim, marginTop: 6 }}>本维无可量化指标</div> : null}
      {measures.map((m, i) => <MeasureRow key={i} m={m} />)}
      {charts.map((c, i) => (
        <div key={i} style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, color: T.dim, marginBottom: 6 }}>{String(c.label)}</div>
          <DimChartView c={c} />
        </div>
      ))}
      {findings.length > 0 ? (
        <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {findings.map((f, i) => <DigButton key={i} prompt={digPrompt(node, when, f, d)} label={`深挖 ${String(f.code ?? '')}`} />)}
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────────────────────────── 发现卡（带同维图 + 深挖）
function FindingCard({ f, dim, node, when }: { f: any; dim?: any; node: string; when: string }) {
  const s = sev(String(f.level));
  const chart = dim?.charts?.[0];
  return (
    <div style={{ ...card, borderLeft: `3px solid ${s.c}`, marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Dot level={String(f.level)} />
        <b style={{ fontSize: 16 }}>{String(f.item ?? f.detail ?? '')}</b>
        {String(f.code ?? '') !== '' ? <span style={{ font: `600 11.5px ${mono}`, background: T.fill, border: `1px solid ${T.line}`, borderRadius: 5, padding: '1px 6px', color: T.sub }}>{String(f.code)}</span> : null}
        {String(f.node ?? '') !== '' ? <span style={{ fontSize: 12, color: T.dim }}>@{String(f.node)}</span> : null}
        {String(f.value ?? '') !== '' && String(f.threshold ?? '') !== '' ? <span style={{ marginLeft: 'auto', fontSize: 12, color: T.dim }}>实测 <b style={{ color: s.c, fontFamily: mono }}>{String(f.value)}</b> · 阈值 <span style={{ fontFamily: mono }}>{String(f.threshold)}</span></span> : null}
      </div>
      {String(f.detail ?? '') !== '' ? <div style={{ fontSize: 15, color: T.sub, marginTop: 6 }}>{String(f.detail)}</div> : null}
      {String(f.evidence ?? '') !== '' ? <div style={{ fontSize: 12.5, color: T.dim, marginTop: 4, fontFamily: mono, wordBreak: 'break-all' }}>证据 {String(f.evidence)}</div> : null}
      {chart !== undefined ? <div style={{ marginTop: 10, maxWidth: 520 }}><div style={{ fontSize: 12, color: T.dim, marginBottom: 6 }}>{String(chart.label)}</div><DimChartView c={chart} /></div> : null}
      {String(f.level) !== 'ok' ? <div style={{ marginTop: 10 }}><DigButton prompt={digPrompt(node, when, f, dim)} /></div> : null}
    </div>
  );
}

// ───────────────────────────────────────────── 趋势（平台指标库曲线 + 历次检查）
function TrendSection({ node, call, runs }: { node: string; call: (endpoint: string, payload?: unknown) => Promise<any>; runs: any[] }) {
  const [trend, setTrend] = useState<any | undefined>();
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    call('health/trend', { node, minutes: 60 }).then((v) => { if (alive) { setTrend(v); setErr(''); } }).catch((e) => { if (alive) setErr(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, [node]);
  // 历次检查：每次 collect 的关键指标（连接占用 / 缓存命中 / 每核负载）
  const history = useMemo(() => {
    const pick = (c: any, dim: string, key: string): number | undefined => {
      const n = (c?.nodes ?? []).find((x: any) => x.node === node) ?? c?.nodes?.[0];
      const m = (n?.dims ?? []).find((d: any) => d.dim === dim)?.measures?.find((x: any) => x.key === key);
      return typeof m?.value === 'number' ? m.value : undefined;
    };
    const rows = runs.filter((r) => r.collect !== undefined).slice(0, 30).reverse();
    const series = (dim: string, key: string, name: string) => ({ name, points: rows.map((r) => [Date.parse(String(r.collect.collectedAt ?? r.firedAt)), pick(r.collect, dim, key)] as [number, number | undefined]).filter((p) => p[1] !== undefined) as [number, number][] });
    return [
      { label: '连接占用率', unit: 'ratio' as Unit, series: [series('connections', 'connRatio', '连接占用')] },
      { label: '缓存命中率', unit: 'ratio' as Unit, series: [series('overview', 'cacheHit', '缓存命中')] },
      { label: '每核负载', unit: 'x' as Unit, series: [series('os', 'loadPerCore', '每核负载')] },
    ].filter((h) => h.series[0].points.length >= 2);
  }, [runs, node]);
  return (
    <>
      <H2>趋势 <Hint>左：平台指标库最近 60 分钟（虚线 = 当前生效阈值）· 右：历次检查关键指标</Hint></H2>
      {err !== '' ? <div style={{ fontSize: 13, color: T.dim }}>曲线加载失败：{err}</div> : null}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(360px,1fr))', gap: 12 }}>
        {(trend?.charts ?? []).map((c: any) => (
          <div key={String(c.key)} style={{ ...card, padding: '12px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}><b style={{ fontSize: 13.5 }}>{String(c.label)}</b><span style={{ fontSize: 12, color: T.dim }}>最新 {fmtValue(Number(c.stats?.last), asUnit(c.unit))} · 均 {fmtValue(Number(c.stats?.avg), asUnit(c.unit))} · 峰 {fmtValue(Number(c.stats?.max), asUnit(c.unit))}</span></div>
            <Line series={[{ name: node, points: c.points }]} unit={asUnit(c.unit)} thresholds={(c.thresholds ?? []).map((t: any) => ({ label: String(t.label), value: Number(t.value), level: asLevel(t.label) }))} height={150} />
          </div>
        ))}
        {history.map((h) => (
          <div key={h.label} style={{ ...card, padding: '12px 14px' }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>{h.label} <span style={{ fontSize: 12, color: T.dim, fontWeight: 400 }}>· 历次检查</span></div>
            <Line series={h.series} unit={h.unit} height={150} />
          </div>
        ))}
        {trend !== undefined && (trend.charts ?? []).length === 0 && history.length === 0 ? <div style={{ fontSize: 13, color: T.dim }}>指标库暂无该实例最近 60 分钟数据</div> : null}
      </div>
    </>
  );
}

// ───────────────────────────────────────────── 总览带 / 环 / 历史（沿用）
function Ring({ states, worst }: { states: { dim: string; title: string; worst: string }[]; worst: string }) {
  const n = Math.max(states.length, 1);
  const R = 62; const C = 2 * Math.PI * R;
  const seg = C / n;
  return (
    <div style={{ position: 'relative', width: 170, height: 170, margin: '4px auto' }}>
      <svg width={170} height={170} viewBox="0 0 170 170" style={{ transform: 'rotate(-90deg)' }}>
        {states.map((d, i) => (
          <circle key={d.dim} cx={85} cy={85} r={R} fill="none" stroke={sev(d.worst).c} strokeWidth={15}
            strokeDasharray={`${Math.max(seg - 3, 2)} ${C - Math.max(seg - 3, 2)}`} strokeDashoffset={-i * seg}>
            <title>{d.title} · {sev(d.worst).cn}</title>
          </circle>
        ))}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
        <b style={{ fontSize: 20, color: sev(worst).c }}>{sev(worst).cn}</b>
        <span style={{ fontSize: 12, color: T.dim }}>{n} 维 · 只讲证据</span>
      </div>
    </div>
  );
}

function StatusBand({ data, when, collect }: { data: any; when?: string; collect?: any }) {
  const worst = String(data?.det?.worst ?? collect?.worst ?? 'ok');
  const s = sev(worst);
  const counts = data?.det?.counts ?? collect?.counts ?? {};
  const driver = (data?.findings ?? []).slice().sort((a: any, b: any) => (ORDER[b.level] ?? 0) - (ORDER[a.level] ?? 0))[0];
  const notes = collect?.nodes?.flatMap((n: any) => n.collectionNotes ?? []) ?? data?.collectionNotes ?? [];
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'stretch' }}>
      <div style={{ borderRadius: 12, padding: '16px 22px', color: '#fff', minWidth: 200, background: s.grad, display: 'flex', flexDirection: 'column', gap: 4, justifyContent: 'center' }}>
        <span style={{ fontSize: 12, opacity: 0.8, letterSpacing: '.1em' }}>{String(data?.scope ?? collect?.scope) === 'cluster' ? '集群总体状态 · 取最差实例' : '总体状态'}</span>
        <span style={{ fontSize: 24, fontWeight: 600, letterSpacing: 1 }}>{s.cn}</span>
        {driver !== undefined && String(driver.level) !== 'ok' ? <span style={{ fontSize: 13.5, opacity: 0.92, maxWidth: 280, lineHeight: 1.5 }}>驱动：{String(driver.detail ?? driver.item ?? '')}</span> : null}
      </div>
      <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 7, justifyContent: 'center' }}>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13.5, background: T.sev.ok.soft, color: T.sev.ok.c, borderRadius: 6, padding: '3px 10px', width: 'fit-content' }}>
          ✓ {collect !== undefined ? `数字直读采集器存档 #${String(collect.id)} · 阈值来源 ${String(collect.thresholds?.source ?? '')}` : '已锚定 · 确定性发现全覆盖'} · 状态不可被解读下调
        </span>
        <span style={{ fontSize: 13.5, color: T.dim }}>
          严重 <b style={{ color: T.sev.critical.c }}>{Number(counts.critical ?? 0)}</b> · 告警 <b style={{ color: T.sev.warn.c }}>{Number(counts.warn ?? 0)}</b> · 关注 <b style={{ color: T.sev.notice.c }}>{Number(counts.notice ?? 0)}</b>
          {when !== undefined ? <span> · 完成于 {when}</span> : null}
        </span>
        {notes.length > 0
          ? <span style={{ fontSize: 13.5, color: T.sev.warn.c }}>⚠ {notes.length} 个维度采集降级（见底部 Collection Notes）</span>
          : <span style={{ fontSize: 13.5, color: T.dim }}>全部维度采集成功 · 0 降级 · 📄 报告已自动入库归档</span>}
      </div>
    </div>
  );
}

function ClusterGrid({ byNode, selNode, onSel }: { byNode: any[]; selNode: string; onSel: (n: string) => void }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(170px,1fr))', gap: 8 }}>
      {byNode.map((n: any) => {
        const s = sev(String(n.worst));
        const isSel = String(n.node) === selNode;
        return (
          <div key={String(n.node)} onClick={() => onSel(String(n.node))} style={{ ...card, borderLeft: `4px solid ${s.c}`, padding: '10px 12px', cursor: 'pointer', outline: isSel ? `2px solid ${T.blue}` : 'none' }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <b style={{ fontSize: 16 }}>{String(n.node)}</b>
              <span style={{ marginLeft: 'auto', fontSize: 13.5, fontWeight: 600, color: s.c }}>{s.cn}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RunStrip({ runs, selId, onSel }: { runs: any[]; selId: string; onSel: (id: string) => void }) {
  const cells = runs.slice(0, 30).reverse();
  if (cells.length === 0) return null;
  return (
    <div style={{ ...card }}>
      <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 26 }}>
        {cells.map((r: any) => {
          const lv = String(r.report?.data?.det?.worst ?? r.collect?.worst ?? (r.status === 'succeeded' ? 'ok' : 'notice'));
          const isSel = r.id === selId;
          return (
            <i key={String(r.id)} title={`${String(r.firedAt).replace('T', ' ').slice(0, 16)} · ${lv}`}
              onClick={() => (r.report !== undefined || r.collect !== undefined) && onSel(String(r.id))}
              style={{ flex: 1, maxWidth: 16, height: '100%', borderRadius: 3, background: sev(lv).c, cursor: 'pointer', fontStyle: 'normal', outline: isSel ? `2px solid ${T.ink}` : 'none', opacity: isSel ? 1 : 0.75 }} />
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: T.dim, marginTop: 6 }}>
        <span>{String(cells[0]?.firedAt ?? '').slice(5, 10)}</span>
        <span>最新 ▲ · 点格子查看当次完整报告</span>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────── 面板
export function HealthPanel({ task, call }: { task: any; call: (endpoint: string, payload?: unknown) => Promise<any> }) {
  const [runs, setRuns] = useState<any[]>([]);
  const [selId, setSelId] = useState('');
  const [selNode, setSelNode] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () => {
      call('runs/list', { taskId: task.id })
        .then((v) => { if (alive) { setRuns(v?.runs ?? []); setError(''); } })
        .catch((e) => { if (alive) setError(String(e?.message ?? e)); });
    };
    load();
    const timer = setInterval(load, 30000);
    return () => { alive = false; clearInterval(timer); };
  }, [task.id]);

  const withReport = runs.filter((r) => r.report !== undefined || r.collect !== undefined);
  const current = withReport.find((r) => r.id === selId) ?? withReport[0];
  const data = current?.report?.data;
  const collect = current?.collect;
  if (error !== '') return <div style={{ fontSize: 16, color: T.dim, padding: 16 }}>加载失败：{error}</div>;
  if (current === undefined) return <div style={{ fontSize: 16, color: T.dim, padding: 16 }}>还没有健康检查报告——任务触发后（cron 或在会话里说一声「立即跑一次健康检查」）这里会出现大盘。</div>;

  const nodes: any[] = collect?.nodes ?? [];
  const node = nodes.find((n) => n.node === selNode) ?? nodes[0];
  const nodeName = String(node?.node ?? data?.det?.byNode?.[0]?.node ?? task?.config?.node ?? '');
  const isCluster = String(data?.scope ?? collect?.scope) === 'cluster';
  const when = String(collect?.collectedAt ?? current?.finishedAt ?? '').replace('T', ' ').slice(0, 19);
  const findingsAll: any[] = (data?.findings ?? (collect !== undefined ? nodes.flatMap((n: any) => (n.findings ?? []).map((f: any) => ({ ...f, node: n.node }))) : [])).slice()
    .sort((a: any, b: any) => (ORDER[b.level] ?? 0) - (ORDER[a.level] ?? 0));
  const abnormal = findingsAll.filter((f: any) => String(f.level) !== 'ok' && (!isCluster || node === undefined || String(f.node ?? node.node) === String(node.node)));
  const dims: any[] = node !== undefined
    ? (node.dims ?? []).map((d: any) => ({ ...d, findingsOfDim: (node.findings ?? []).filter((f: any) => dimOf(f) === d.dim && String(f.level) !== 'ok') }))
    : [];
  const dimByKey = new Map<string, any>(dims.map((d) => [String(d.dim), d]));
  const states = dims.length > 0
    ? dims.map((d) => ({ dim: String(d.dim), title: String(d.title), worst: String(d.worst ?? 'ok') }))
    : dimStates(findingsAll);
  const worst = String(data?.det?.worst ?? collect?.worst ?? 'ok');

  return (
    <div style={{ fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif', color: T.ink, lineHeight: 1.75, fontSize: 15 }}>
      <StatusBand data={data} when={when} collect={collect} />

      {isCluster ? (
        <>
          <H2>实例健康矩阵 <Hint>每格一实例 · 点选后下方按该实例展开十二维</Hint></H2>
          <ClusterGrid byNode={data?.det?.byNode ?? nodes.map((n: any) => ({ node: n.node, worst: n.worst }))} selNode={String(node?.node ?? '')} onSel={setSelNode} />
          {(data?.clusterFindings ?? collect?.clusterFindings ?? []).length > 0 ? (
            <>
              <H2>集群级发现 <Hint>跨实例共性 / 配置漂移 / 最差上浮</Hint></H2>
              {(data?.clusterFindings ?? collect?.clusterFindings ?? []).map((f: any, i: number) => (
                <FindingCard key={i} f={{ ...f, node: (f.nodes ?? []).join(', ') }} node={nodeName} when={when} />
              ))}
            </>
          ) : null}
        </>
      ) : null}

      <H2>{isCluster ? `${nodeName} · ` : ''}十二维体检 <Hint>{collect !== undefined ? '每维关键值 · 含义 · 当前生效阈值阶梯 · 落档原因——全部直读采集器' : '旧报告：仅按发现反推每维状态'}</Hint></H2>
      <div style={{ display: 'grid', gridTemplateColumns: '210px 1fr', gap: 14, alignItems: 'start' }}>
        <div style={{ ...card, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <Ring states={states} worst={worst} />
        </div>
        {dims.length > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(320px,1fr))', gap: 10 }}>
            {dims.map((d) => <DimCard key={String(d.dim)} d={d} node={nodeName} when={when} />)}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 8 }}>
            {dimStates(findingsAll).map((d) => (
              <div key={d.dim} style={{ ...card, padding: '9px 12px' }}>
                <div style={{ fontSize: 13.5, color: T.sub }}><Dot level={d.worst} />{d.title}</div>
                <div style={{ fontSize: 16, fontWeight: 600, marginTop: 3, color: sev(d.worst).c }}>{d.top === undefined ? '正常' : `${String(d.top.value ?? '')} · ${String(d.top.code ?? '')}`}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <H2>发现 <Hint>按严重度排序 · 每条 = 证据 → 阈值 → 解读 → 同维分布图 → 深挖</Hint></H2>
      {abnormal.length === 0 ? <div style={{ fontSize: 16, color: T.sev.ok.c }}>✓ 无异常发现，各维在阈值内。</div>
        : abnormal.map((f: any, i: number) => <FindingCard key={i} f={f} dim={dimByKey.get(dimOf(f))} node={String(f.node ?? nodeName)} when={when} />)}

      {nodeName !== '' ? <TrendSection node={nodeName} call={call} runs={runs} /> : null}

      {String(data?.rootCause ?? '') !== '' ? (
        <>
          <H2>根因串联 <Hint>模型叙述</Hint></H2>
          <div style={{ ...card, background: T.fill, border: 'none' }}>
            <div style={{ fontSize: 15, color: T.sub }}>{String(data.rootCause)}</div>
          </div>
        </>
      ) : null}

      {(data?.priorities ?? []).length > 0 ? (
        <>
          <H2>处置优先级 <Hint>P0/P1/P2 按影响面排 · 与严重度是两个维度 · 模型叙述</Hint></H2>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {(data.priorities ?? []).map((p: any, i: number) => (
              <div key={i} style={{ ...card, flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: T.sub, letterSpacing: '.05em' }}>{String(p.p)}</div>
                <div style={{ fontSize: 15, marginTop: 4 }}>{String(p.action)}</div>
                {(p.refs ?? []).length > 0 ? <div style={{ fontSize: 12, color: T.dim, marginTop: 4 }}>关联 {(p.refs ?? []).join(', ')}</div> : null}
              </div>
            ))}
          </div>
        </>
      ) : null}

      <H2>检查历史 <Hint>一格一次运行 · 点格子查看当次报告</Hint></H2>
      <RunStrip runs={runs} selId={String(current?.id ?? '')} onSel={setSelId} />

      {(collect?.nodes?.flatMap((n: any) => n.collectionNotes ?? []) ?? data?.collectionNotes ?? []).length > 0 ? (
        <div style={{ fontSize: 13.5, color: T.dim, border: `1px dashed ${T.line}`, borderRadius: 8, padding: '8px 14px', marginTop: 16 }}>
          📋 Collection Notes：{(collect?.nodes?.flatMap((n: any) => n.collectionNotes ?? []) ?? data?.collectionNotes ?? []).map((n: any, i: number) => <div key={i}>{String(n)}</div>)}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 注册面板：与 ui-harness 的加载顺序无关。桥已在就直接注册，否则把自己排进 __pending，
 * 由后到的 ui-harness 兑现（2026-08-24 面板注册竞态复盘）。
 */
function registerPanel(key: string, Comp: any): void {
  if (typeof window === 'undefined') return;
  const w = window as any;
  if (w.__opendbHarness__?.registerTaskPanel !== undefined) { w.__opendbHarness__.registerTaskPanel(key, Comp); return; }
  w.__opendbHarness__ = w.__opendbHarness__ ?? {};
  w.__opendbHarness__.__pending = [...(w.__opendbHarness__.__pending ?? []), { kind: 'task', key, comp: Comp }];
}

export function apply(ctx: any): void {
  clientCtx = ctx;
  registerPanel('health', HealthPanel);
}
