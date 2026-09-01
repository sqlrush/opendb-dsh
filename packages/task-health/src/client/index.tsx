/**
 * task-health client 面板（2026-08-26 R2：user 指出 R1 "各种没对齐、卡片不精致"，按运维大盘业界做法重做）：
 *   - 每维一张等宽等高 stat 卡：标题行 → 大数 KPI + 状态标 → 阈值轨道（刻度/实测都在轨道上，文字统一在下方一行）
 *     → 两列对齐的次要指标 → 一个紧凑可视化（构成 = 100% 堆叠条；Top-N = 排名条列表）→ 右下角「深挖 →」
 *   - 环图缩小并入顶部状态带；发现区 = 紧凑列表行（严重度竖条 + 标题 + 实测/阈值 + 迷你趋势 + 深挖）
 *   - 卡片：1px 边框 / 10px 圆角 / 轻阴影；文字三级灰，语义色只上数据；数字 tabular-nums；无信息量的图不画
 *   数字全部直读采集存档（runs/list 附带的 collect）；模型报告只贡献根因串联 / 处置优先级。
 */
import { useEffect, useMemo, useState } from 'react';
import { Rail, StackedBar, RankList, Sparkline, Line, SEV, fmtValue, normalizePriority, type Level, type Unit } from '@opendb-dsh/chart-kit';

// 深挖要用 sessions / connection / workspaces：列进 inject 保证 apply 时服务已就绪
export const inject = ['slots', 'connection', 'workspaces', 'sessions'];

const T = {
  ink: '#0f1115', sub: '#61666b', dim: '#81858c', blue: '#4176e6', line: 'rgba(0,0,0,.08)', fill: '#f7f8fa',
  sev: {
    ok: { c: SEV.ok, soft: '#e8f5ec', cn: '正常', grad: 'linear-gradient(135deg,#3fa552,#2f8541)' },
    notice: { c: SEV.notice, soft: '#faf3e5', cn: '关注', grad: 'linear-gradient(135deg,#c9862d,#a96e1f)' },
    warn: { c: SEV.warn, soft: '#fdf0e3', cn: '告警', grad: 'linear-gradient(135deg,#e07a1f,#c9640f)' },
    critical: { c: SEV.critical, soft: '#fdecec', cn: '严重', grad: 'linear-gradient(135deg,#d64545,#b53434)' },
  } as Record<string, { c: string; soft: string; cn: string; grad: string }>,
};
const sev = (l: string) => T.sev[l] ?? T.sev.ok;
const ORDER: Record<string, number> = { critical: 3, warn: 2, notice: 1, ok: 0 };
const card: any = { background: '#fff', border: `1px solid ${T.line}`, borderRadius: 10, padding: '14px 16px', boxShadow: '0 4px 12px rgba(0,0,0,.02),0 2px 8px rgba(0,0,0,.03)' };
const mono = '"JetBrains Mono","SF Mono",Menlo,monospace';
const tnum: any = { fontVariantNumeric: 'tabular-nums' };
const asLevel = (l: unknown): Level => (['ok', 'notice', 'warn', 'critical'].includes(String(l)) ? (String(l) as Level) : 'ok');
const asUnit = (u: unknown): Unit => (['ratio', 'count', 'ms', 's', 'bytes', 'x', 'per_s', 'text'].includes(String(u)) ? (String(u) as Unit) : 'count');
const fmtM = (m: any): string => (typeof m?.value === 'number' ? fmtValue(m.value, asUnit(m.unit)) : String(m?.value ?? ''));

/** 客户端 ctx（apply 时捕获）：深挖要用 sessions / connection / workspaces */
let clientCtx: any;

function H2({ children, hint }: { children: any; hint?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '28px 0 12px', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 17, fontWeight: 600, color: T.ink }}>{children}</span>
      {hint !== undefined ? <span style={{ fontSize: 13, color: T.dim }}>{hint}</span> : null}
    </div>
  );
}
function Dot({ level, size = 8 }: { level: string; size?: number }) {
  return <span style={{ display: 'inline-block', width: size, height: size, borderRadius: size / 2, background: sev(level).c, flex: 'none' }} />;
}
function Tag({ level, title }: { level: string; title?: string }) {
  const s = sev(level);
  return <span title={title} style={{ fontSize: 12, fontWeight: 600, color: s.c, background: s.soft, borderRadius: 6, padding: '2px 8px', lineHeight: '16px', whiteSpace: 'nowrap' }}>{s.cn}</span>;
}
function Link({ onClick, children, busy, fail }: { onClick: () => void; children: any; busy?: boolean; fail?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={busy}
      style={{ font: 'inherit', fontSize: 12.5, color: fail ? T.sev.critical.c : T.blue, background: 'none', border: 'none', padding: 0, cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}>
      {children}
    </button>
  );
}

/** 13 维清单（与 collectors.ts COLLECTORS 对齐）；旧报告无 collect 时从 findings 派生每维状态 */
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
/** 发现规则码 → 趋势指标（发现行的迷你趋势） */
const CODE_METRIC: Record<string, string> = {
  CACHE_LOW: 'cache_hit', CONN_HIGH: 'connections', OS_LOAD_HIGH: 'load_per_core', OS_IOWAIT_HIGH: 'io_wait',
  SESS_ACTIVE_HIGH: 'active_sessions', LWLOCK_HOT: 'wait_lwlock', LOCK_CHAIN: 'waiting_locks', WAIT_CONC: 'wait_io',
};

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
function DigLink({ prompt, label }: { prompt: string; label: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'fail'>('idle');
  return (
    <Link busy={state === 'busy'} fail={state === 'fail'} onClick={() => { setState('busy'); digInSession(prompt).then(() => setState('idle')).catch(() => setState('fail')); }}>
      {state === 'busy' ? '开会话中…' : state === 'fail' ? '失败，重试' : `${label} →`}
    </Link>
  );
}
/** 深挖提示词：背景（实例/维度/指标/阈值/证据/同维指标）+ 任务 */
function digPrompt(node: string, when: string, f: any, dim?: any): string {
  const measures: any[] = dim?.measures ?? [];
  return [
    `【健康检查深挖】实例 ${node} · 报告时间 ${when}${dim !== undefined ? ` · 维度「${String(dim.title)}」` : ''}`,
    `发现：[${String(f.code ?? '')}] ${sev(String(f.level)).cn} · ${String(f.item ?? f.detail ?? '')}`,
    String(f.metric ?? '') !== '' ? `指标：${String(f.metric)} 实测 ${String(f.value ?? '')}（阈值 ${String(f.threshold ?? '')}）` : '',
    String(f.detail ?? '') !== '' ? `解读：${String(f.detail)}` : '',
    String(f.evidence ?? '') !== '' ? `证据：${String(f.evidence)}` : '',
    measures.length > 0 ? `同维关键指标：${measures.map((m) => `${String(m.label)}=${fmtM(m)}（${sev(String(m.level)).cn}）`).join('；')}` : '',
    '任务：请围绕这条发现深挖根因——先用工具（metrics_chart / metrics_recent / health_collect / sqlreview_collect 等）取最近数据取证，再给出：1) 根因判断与依据；2) 影响面；3) 处置建议（本平台只读，不执行任何变更）。不要向我反问，直接给结论。',
  ].filter((s) => s !== '').join('\n');
}

// ───────────────────────────────────────────── 可视化选型（按数据类型，不拘泥饼/柱）
function Viz({ c, tiers }: { c: any; tiers?: Record<string, number> }) {
  const unit = asUnit(c.unit);
  const items = (c.items ?? []).map((it: any) => ({ name: String(it.name), value: Number(it.value) }));
  if (items.length === 0) return null;
  if (c.kind === 'pie') {
    const total = items.reduce((s: number, i: any) => s + Math.max(0, i.value), 0);
    const meaningful = items.filter((i: any) => total > 0 && i.value / total >= 0.01);
    // 一项独占（≥99.5%）没有构成可言：一句话即可，不画图
    if (total <= 0 || meaningful.length < 2) {
      const top = [...items].sort((a: any, b: any) => b.value - a.value)[0];
      return <div style={{ fontSize: 12.5, color: T.sub, ...tnum }}>{String(c.label)}：{top.name} {fmtValue(top.value, unit)}{total > 0 ? `（${((top.value / total) * 100).toFixed(1)}%）` : ''}</div>;
    }
    return <VizBlock label={String(c.label)}><StackedBar items={items} unit={unit} /></VizBlock>;
  }
  if (c.kind === 'bar') {
    const ticks = tiers !== undefined ? (Object.entries(tiers) as [string, number][]).map(([l, v]) => ({ value: v, level: asLevel(l) })) : undefined;
    return <VizBlock label={String(c.label)}><RankList items={items} unit={unit} max={3} ticks={ticks} /></VizBlock>;
  }
  return null;   // gauge 由 KPI 的阈值轨道承担
}
function VizBlock({ label, children }: { label: string; children: any }) {
  return <div><div style={{ fontSize: 12, color: T.dim, marginBottom: 6 }}>{label}</div>{children}</div>;
}

// ───────────────────────────────────────────── 十三维 stat 卡
function DimCard({ d, node, when }: { d: any; node: string; when: string }) {
  const worst = String(d.worst ?? 'ok');
  const measures: any[] = d.measures ?? [];
  // 主指标 = 落档最重的那个；同级优先带阈值规则的（"对象与索引"里 0 个失效索引是观测值，6 个无用索引才是关注点）
  const ranked = [...measures].sort((a, b) => ((ORDER[String(b.level)] ?? 0) - (ORDER[String(a.level)] ?? 0)) || ((b.rule !== undefined ? 1 : 0) - (a.rule !== undefined ? 1 : 0)));
  const primary = ranked[0];
  const rest = measures.filter((m) => m !== primary);
  const charts: any[] = (d.charts ?? []).filter((c: any) => c.kind !== 'gauge');
  const findings: any[] = d.findingsOfDim ?? [];
  const pUnit = asUnit(primary?.unit);
  const pLevel = asLevel(primary?.level);
  const tiers = primary?.rule?.tiers ?? {};
  // Top-N 条上的刻度：与主指标同单位才有意义（慢 SQL 均耗时 / 长事务时长 / 膨胀率）
  const rankTiers = primary?.rule !== undefined && Object.keys(tiers).length > 0 ? tiers : undefined;
  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 12, height: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Dot level={worst} /><span style={{ fontSize: 14.5, fontWeight: 600, color: T.ink }}>{String(d.title)}</span>
        <span style={{ marginLeft: 'auto' }}><Tag level={worst} /></span>
      </div>

      {d.ok === false ? <div style={{ fontSize: 12.5, color: T.sev.warn.c }}>采集降级：{String(d.note ?? '')}（该维不产结论）</div> : null}

      {primary !== undefined ? (
        <div>
          <div style={{ fontSize: 12.5, color: T.dim }}>{String(primary.label)}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 2 }}>
            <span title={String(primary.why ?? '')} style={{ fontSize: pUnit === 'text' ? 16 : 24, fontWeight: 600, color: pLevel !== 'ok' ? sev(pLevel).c : T.ink, ...tnum, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmtM(primary)}</span>
            {/* 与标题行状态一致时不重复打标，只在主指标与本维最差级不同（如本维由别的指标拉高）时提示 */}
            {primary.rule !== undefined && pLevel !== worst ? <Tag level={pLevel} title={String(primary.why ?? '')} /> : null}
          </div>
          {primary.rule !== undefined && typeof primary.value === 'number' ? (
            <Rail value={primary.value} tiers={tiers} cmp={primary.rule.cmp} level={pLevel} unit={pUnit === 'text' ? 'count' : pUnit} />
          ) : null}
          <div style={{ fontSize: 12, color: T.dim, marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={String(primary.desc ?? '')}>{String(primary.desc ?? '')}</div>
          {pLevel !== 'ok' ? <div style={{ fontSize: 12.5, color: sev(pLevel).c, marginTop: 2 }} title={String(primary.why ?? '')}>{String(primary.why ?? '').replace(/（阶梯：.*$/, '')}</div> : null}
        </div>
      ) : (d.ok !== false ? <div style={{ fontSize: 12.5, color: T.dim }}>本维无可量化指标</div> : null)}

      {rest.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', rowGap: 5, columnGap: 12, fontSize: 12.5, borderTop: `1px solid ${T.line}`, paddingTop: 10 }}>
          {rest.map((m, i) => {
            const lv = asLevel(m.level);
            return (
              <div key={i} style={{ display: 'contents' }}>
                <span title={String(m.desc ?? '')} style={{ color: T.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(m.label)}</span>
                <span title={String(m.why ?? '')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end', color: lv !== 'ok' ? sev(lv).c : T.ink, fontWeight: 500, ...tnum }}>
                  {lv !== 'ok' ? <Dot level={lv} size={6} /> : null}{fmtM(m)}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      {charts.slice(0, 1).map((c, i) => <div key={i} style={{ borderTop: `1px solid ${T.line}`, paddingTop: 10 }}><Viz c={c} tiers={c.kind === 'bar' ? rankTiers : undefined} /></div>)}

      {findings.length > 0 ? (
        <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'flex-end', gap: 14, flexWrap: 'wrap', paddingTop: 4 }}>
          {findings.slice(0, 3).map((f, i) => <DigLink key={i} prompt={digPrompt(node, when, f, d)} label={`深挖 ${String(f.code ?? '')}`} />)}
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────────────────────────── 发现列表行
function FindingRow({ f, dim, node, when, trend, showViz = true }: { f: any; dim?: any; node: string; when: string; trend?: any; showViz?: boolean }) {
  const level = String(f.level);
  const s = sev(level);
  const metricKey = CODE_METRIC[String(f.code ?? '')];
  const tc = metricKey !== undefined ? (trend?.charts ?? []).find((c: any) => c.key === metricKey) : undefined;
  const chart: any = dim?.charts?.find((c: any) => c.kind !== 'gauge');
  // 模型常把维度键当 item（"xact" / "og5 xact"）：这种情况用维度中文名做标题，真正的描述性 item 才原样显示
  const item = String(f.item ?? '').trim();
  const looksLikeKey = item === '' || item === String(dim?.dim ?? dimOf(f)) || /^[\w-]+ [a-z_]+$/.test(item) || DIMS.some((d) => d.dim === item);
  const title = looksLikeKey ? (String(dim?.title ?? '') || DIMS.find((d) => d.dim === dimOf(f))?.title || String(f.code ?? '')) : item;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '3px minmax(0,1fr) auto', gap: 14, padding: '12px 14px 12px 0', borderTop: `1px solid ${T.line}` }}>
      <div style={{ background: s.c, borderRadius: 2 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Tag level={level} />
          <span style={{ fontSize: 15, fontWeight: 500, color: T.ink }}>{title}</span>
          {String(f.code ?? '') !== '' ? <span style={{ fontSize: 11.5, color: T.dim, fontFamily: mono }}>{String(f.code)}</span> : null}
          {String(f.node ?? '') !== '' ? <span style={{ fontSize: 12, color: T.dim }}>@{String(f.node)}</span> : null}
        </div>
        {String(f.detail ?? '') !== '' ? <div style={{ fontSize: 13.5, color: T.sub, marginTop: 4, lineHeight: 1.6 }}>{String(f.detail)}</div> : null}
        {String(f.evidence ?? '') !== '' ? <div title={String(f.evidence)} style={{ fontSize: 12, color: T.dim, marginTop: 3, fontFamily: mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(f.evidence)}</div> : null}
        {showViz && tc === undefined && chart !== undefined ? <div style={{ marginTop: 8, maxWidth: 460 }}><Viz c={chart} /></div> : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, minWidth: 150 }}>
        {String(f.value ?? '') !== '' ? (
          <div style={{ fontSize: 12.5, color: T.dim, ...tnum, textAlign: 'right' }}>
            实测 <b style={{ color: s.c, fontWeight: 600 }}>{String(f.value)}</b>{String(f.threshold ?? '') !== '' ? <span> · 阈值 {String(f.threshold)}</span> : null}
          </div>
        ) : null}
        {tc !== undefined ? (
          <div title={`${String(tc.label)} 最近 60 分钟`}>
            <Sparkline points={tc.points} unit={asUnit(tc.unit)} color={s.c} thresholds={(tc.thresholds ?? []).map((t: any) => ({ value: Number(t.value), level: asLevel(t.label) }))} width={150} height={34} />
          </div>
        ) : null}
        {level !== 'ok' ? <DigLink prompt={digPrompt(node, when, f, dim)} label="在会话里深挖" /> : null}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────── 趋势（平台指标库曲线 + 历次检查）
function TrendSection({ node, trend, err, runs }: { node: string; trend?: any; err: string; runs: any[] }) {
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
  const charts: any[] = trend?.charts ?? [];
  return (
    <>
      <H2 hint="指标库最近 60 分钟（虚线 = 当前生效阈值）· 历次检查 = 每次体检的关键指标">趋势</H2>
      {err !== '' ? <div style={{ fontSize: 13, color: T.dim }}>曲线加载失败：{err}</div> : null}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))', gap: 12 }}>
        {charts.map((c: any) => (
          <div key={String(c.key)} style={{ ...card, padding: '12px 14px 8px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: T.ink }}>{String(c.label)}</span>
              <span style={{ fontSize: 12, color: T.dim, marginLeft: 'auto', ...tnum }}>最新 {fmtValue(Number(c.stats?.last), asUnit(c.unit))} · 均 {fmtValue(Number(c.stats?.avg), asUnit(c.unit))} · 峰 {fmtValue(Number(c.stats?.max), asUnit(c.unit))}</span>
            </div>
            <Line series={[{ name: node, points: c.points }]} unit={asUnit(c.unit)} thresholds={(c.thresholds ?? []).map((t: any) => ({ label: String(t.label), value: Number(t.value), level: asLevel(t.label) }))} height={140} />
          </div>
        ))}
        {history.map((h) => (
          <div key={h.label} style={{ ...card, padding: '12px 14px 8px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: T.ink }}>{h.label}</span>
              <span style={{ fontSize: 12, color: T.dim, marginLeft: 'auto' }}>历次检查 · {h.series[0].points.length} 次</span>
            </div>
            <Line series={h.series} unit={h.unit} height={140} />
          </div>
        ))}
        {trend !== undefined && charts.length === 0 && history.length === 0 ? <div style={{ fontSize: 13, color: T.dim }}>指标库暂无该实例最近 60 分钟数据</div> : null}
      </div>
    </>
  );
}

// ───────────────────────────────────────────── 状态带（含缩小的环）
function Ring({ states, size = 92 }: { states: { dim: string; title: string; worst: string }[]; size?: number }) {
  const n = Math.max(states.length, 1);
  const R = size / 2 - 7; const C = 2 * Math.PI * R; const seg = C / n;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)', flex: 'none' }}>
      {states.map((d, i) => (
        <circle key={d.dim} cx={size / 2} cy={size / 2} r={R} fill="none" stroke={sev(d.worst).c} strokeWidth={9}
          strokeDasharray={`${Math.max(seg - 2.5, 1.5)} ${C - Math.max(seg - 2.5, 1.5)}`} strokeDashoffset={-i * seg}>
          <title>{d.title} · {sev(d.worst).cn}</title>
        </circle>
      ))}
    </svg>
  );
}
function StatusBand({ data, when, collect, states }: { data: any; when?: string; collect?: any; states: { dim: string; title: string; worst: string }[] }) {
  const worst = String(data?.det?.worst ?? collect?.worst ?? 'ok');
  const s = sev(worst);
  const counts = data?.det?.counts ?? collect?.counts ?? {};
  const driver = (data?.findings ?? []).slice().sort((a: any, b: any) => (ORDER[b.level] ?? 0) - (ORDER[a.level] ?? 0))[0];
  const notes = collect?.nodes?.flatMap((n: any) => n.collectionNotes ?? []) ?? data?.collectionNotes ?? [];
  const byLevel = ['critical', 'warn', 'notice', 'ok'].map((l) => ({ l, n: states.filter((d) => d.worst === l).length })).filter((x) => x.n > 0);
  return (
    <div style={{ ...card, padding: 0, display: 'grid', gridTemplateColumns: 'minmax(220px,300px) minmax(0,1fr) auto', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', color: '#fff', background: s.grad, display: 'flex', flexDirection: 'column', gap: 4, justifyContent: 'center' }}>
        <span style={{ fontSize: 12, opacity: 0.85, letterSpacing: '.08em' }}>{String(data?.scope ?? collect?.scope) === 'cluster' ? '集群总体状态' : '总体状态'}</span>
        <span style={{ fontSize: 26, fontWeight: 600, lineHeight: 1.2 }}>{s.cn}</span>
        {driver !== undefined && String(driver.level) !== 'ok' ? <span title={String(driver.detail ?? '')} style={{ fontSize: 12.5, opacity: 0.92, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any, overflow: 'hidden' }}>驱动：{String(driver.detail ?? driver.item ?? '')}</span> : null}
      </div>
      <div style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 6, justifyContent: 'center', minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 18, fontSize: 13.5, color: T.sub, ...tnum, flexWrap: 'wrap' }}>
          {(['critical', 'warn', 'notice'] as const).map((l) => <span key={l}><Dot level={l} size={7} /> <span style={{ marginLeft: 4 }}>{sev(l).cn}</span> <b style={{ color: T.ink, marginLeft: 2 }}>{Number(counts[l] ?? 0)}</b></span>)}
          {when !== undefined && when !== '' ? <span style={{ color: T.dim }}>完成于 {when}</span> : null}
        </div>
        <div style={{ fontSize: 12.5, color: T.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {collect !== undefined ? `数字直读采集器存档 #${String(collect.id)} · 阈值来源 ${String(collect.thresholds?.source ?? '')}` : '已锚定 · 确定性发现全覆盖'} · 状态不可被解读下调
        </div>
        <div style={{ fontSize: 12.5, color: notes.length > 0 ? T.sev.warn.c : T.dim }}>{notes.length > 0 ? `⚠ ${notes.length} 个维度采集降级（见底部 Collection Notes）` : '全部维度采集成功 · 报告已入库归档'}</div>
      </div>
      <div style={{ padding: '12px 20px 12px 0', display: 'flex', alignItems: 'center', gap: 14 }}>
        <Ring states={states} />
        <div style={{ fontSize: 12.5, color: T.sub, display: 'grid', gap: 2, ...tnum }}>
          <span style={{ color: T.dim }}>{states.length} 维</span>
          {byLevel.map((x) => <span key={x.l}><Dot level={x.l} size={7} /> <span style={{ marginLeft: 4 }}>{sev(x.l).cn} {x.n}</span></span>)}
        </div>
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
          <div key={String(n.node)} onClick={() => onSel(String(n.node))} style={{ ...card, padding: '10px 12px', cursor: 'pointer', outline: isSel ? `2px solid ${T.blue}` : 'none', display: 'flex', gap: 8, alignItems: 'center' }}>
            <Dot level={String(n.worst)} /><b style={{ fontSize: 14.5 }}>{String(n.node)}</b>
            <span style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600, color: s.c }}>{s.cn}</span>
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
      <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 24 }}>
        {cells.map((r: any) => {
          const lv = String(r.report?.data?.det?.worst ?? r.collect?.worst ?? (r.status === 'succeeded' ? 'ok' : 'notice'));
          const isSel = r.id === selId;
          return (
            <i key={String(r.id)} title={`${String(r.firedAt).replace('T', ' ').slice(0, 16)} · ${sev(lv).cn}`}
              onClick={() => (r.report !== undefined || r.collect !== undefined) && onSel(String(r.id))}
              style={{ flex: 1, maxWidth: 16, height: '100%', borderRadius: 3, background: sev(lv).c, cursor: 'pointer', fontStyle: 'normal', outline: isSel ? `2px solid ${T.ink}` : 'none', opacity: isSel ? 1 : 0.7 }} />
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
  const [trend, setTrend] = useState<any | undefined>();
  const [trendErr, setTrendErr] = useState('');
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
  const nodes: any[] = collect?.nodes ?? [];
  const node = nodes.find((n) => n.node === selNode) ?? nodes[0];
  const nodeName = String(node?.node ?? data?.det?.byNode?.[0]?.node ?? task?.config?.node ?? '');
  useEffect(() => {
    if (nodeName === '') return;
    let alive = true;
    call('health/trend', { node: nodeName, minutes: 60 }).then((v) => { if (alive) { setTrend(v); setTrendErr(''); } }).catch((e) => { if (alive) setTrendErr(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, [nodeName]);

  if (error !== '') return <div style={{ fontSize: 15, color: T.dim, padding: 16 }}>加载失败：{error}</div>;
  if (current === undefined) return <div style={{ fontSize: 15, color: T.dim, padding: 16 }}>还没有健康检查报告——任务触发后（cron 或在会话里说一声「立即跑一次健康检查」）这里会出现大盘。</div>;

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

  return (
    <div style={{ fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif', color: T.ink, lineHeight: 1.6, fontSize: 14, maxWidth: 1280 }}>
      <StatusBand data={data} when={when} collect={collect} states={states} />

      {isCluster ? (
        <>
          <H2 hint="每格一实例 · 点选后下方按该实例展开">实例健康矩阵</H2>
          <ClusterGrid byNode={data?.det?.byNode ?? nodes.map((n: any) => ({ node: n.node, worst: n.worst }))} selNode={String(node?.node ?? '')} onSel={setSelNode} />
          {(data?.clusterFindings ?? collect?.clusterFindings ?? []).length > 0 ? (
            <>
              <H2 hint="跨实例共性 / 配置漂移 / 最差上浮">集群级发现</H2>
              <div style={{ ...card, padding: '0 16px' }}>
                {(data?.clusterFindings ?? collect?.clusterFindings ?? []).map((f: any, i: number) => <FindingRow key={i} f={{ ...f, node: (f.nodes ?? []).join(', ') }} node={nodeName} when={when} />)}
              </div>
            </>
          ) : null}
        </>
      ) : null}

      <H2 hint={collect !== undefined ? `${isCluster ? `${nodeName} · ` : ''}每维关键值 · 含义 · 阈值 · 落档——全部直读采集器` : '旧报告：仅按发现反推每维状态'}>{states.length} 维体检</H2>
      {dims.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 12, alignItems: 'stretch' }}>
          {dims.map((d) => <DimCard key={String(d.dim)} d={d} node={nodeName} when={when} />)}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 8 }}>
          {dimStates(findingsAll).map((d) => (
            <div key={d.dim} style={{ ...card, padding: '9px 12px' }}>
              <div style={{ fontSize: 13, color: T.sub, display: 'flex', gap: 6, alignItems: 'center' }}><Dot level={d.worst} />{d.title}</div>
              <div style={{ fontSize: 15, fontWeight: 600, marginTop: 3, color: sev(d.worst).c }}>{d.top === undefined ? '正常' : `${String(d.top.value ?? '')} · ${String(d.top.code ?? '')}`}</div>
            </div>
          ))}
        </div>
      )}

      <H2 hint="按严重度排序 · 证据 → 阈值 → 解读 → 最近 60 分钟趋势 → 深挖">发现</H2>
      {abnormal.length === 0 ? <div style={{ ...card, fontSize: 14, color: T.sev.ok.c }}>✓ 无异常发现，各维在阈值内。</div>
        : <div style={{ ...card, padding: '0 16px 0 0', overflow: 'hidden' }}>{(() => {
          // 同一维的分布图只在该维第一条发现下画一次（两条 BLOAT_MID 各画一遍同样的 Top5 是噪音）
          const seen = new Set<string>();
          return abnormal.map((f: any, i: number) => {
            const k = dimOf(f); const first = !seen.has(k); seen.add(k);
            return <FindingRow key={i} f={f} dim={dimByKey.get(k)} node={String(f.node ?? nodeName)} when={when} trend={trend} showViz={first} />;
          });
        })()}</div>}

      {nodeName !== '' ? <TrendSection node={nodeName} trend={trend} err={trendErr} runs={runs} /> : null}

      {String(data?.rootCause ?? '') !== '' ? (
        <>
          <H2 hint="模型叙述">根因串联</H2>
          <div style={{ ...card, background: T.fill, border: 'none', boxShadow: 'none', fontSize: 14.5, color: T.sub, lineHeight: 1.7 }}>{String(data.rootCause)}</div>
        </>
      ) : null}

      {(data?.priorities ?? []).length > 0 ? (
        <>
          <H2 hint="P0/P1/P2 按影响面排 · 与严重度是两个维度 · 模型叙述">处置优先级</H2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 12 }}>
            {/* p 里偶尔被填成整句叙述（schema 只约束是字符串）——归一化后当标题，徽章退回序号 */}
            {(data.priorities ?? []).map((p: any, i: number) => {
              const np = normalizePriority(p, i);
              return (
                <div key={i} style={{ ...card }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: T.dim, letterSpacing: '.06em' }}>{np.badge}</div>
                  {np.title !== '' ? <div style={{ fontSize: 14, fontWeight: 600, marginTop: 6, lineHeight: 1.5 }}>{np.title}</div> : null}
                  <div style={{ fontSize: 14, marginTop: 6, lineHeight: 1.6 }}>{np.action}</div>
                  {(p.refs ?? []).length > 0 ? <div style={{ fontSize: 12, color: T.dim, marginTop: 6, fontFamily: mono }}>{(p.refs ?? []).join(' · ')}</div> : null}
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      <H2 hint="一格一次运行 · 点格子查看当次报告">检查历史</H2>
      <RunStrip runs={runs} selId={String(current?.id ?? '')} onSel={setSelId} />

      {(collect?.nodes?.flatMap((n: any) => n.collectionNotes ?? []) ?? data?.collectionNotes ?? []).length > 0 ? (
        <div style={{ fontSize: 13, color: T.dim, border: `1px dashed ${T.line}`, borderRadius: 8, padding: '8px 14px', marginTop: 16 }}>
          📋 Collection Notes：{(collect?.nodes?.flatMap((n: any) => n.collectionNotes ?? []) ?? data?.collectionNotes ?? []).map((n: any, i: number) => <div key={i}>{String(n)}</div>)}
        </div>
      ) : null}
    </div>
  );
}

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
