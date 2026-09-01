/**
 * 资源 › 模型用量（R2，2026-08-31 user 通过 docs/prototypes/usage-r2.html）。
 * 摘要 6 卡 → 用量趋势（逐日堆叠：缓存读 / 输入 / 输出；调用次数单独一条细带，不与柱子抢轴）
 * → 用量构成（按来源 / 按模型）+ 单次调用规模 → Top 会话。
 * 数据来自 platform-status 的 /opendb-status usage 端点；四个 token 字段都由模型 API 原样返回，平台不估算。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { T, FONT, mono, tnum, fmtInt } from './format.ts';

const CACHE = '#2FA79A'; const IN = '#4176E6'; const OUT = '#8B6BE0'; const CALL = '#C9862D';
const SRC_CN: Record<string, string> = { task: '任务运行', dig: '报告深挖', manual: '人工会话' };
const SRC_DESC: Record<string, string> = { task: '定时 / 手动触发的任务', dig: '从报告里点「深挖」开的会话', manual: '你在会话里直接问的' };
const SRC_COLOR: Record<string, string> = { task: IN, dig: OUT, manual: CACHE };

export interface Usage {
  windowDays: number;
  totals: { input: number; output: number; cacheRead: number; reasoning: number; calls: number; sessions: number };
  today: { input: number; output: number; cacheRead: number; calls: number };
  daily: { day: string; input: number; output: number; cacheRead: number; calls: number }[];
  bySource: { kind: string; tokens: number; calls: number; sessions: number }[];
  byModel: { model: string; tokens: number; calls: number }[];
  sizes: { bucket: string; count: number }[];
  topSessions: { sessionId: string; title: string; kind: string; tokens: number; calls: number; model: string }[];
}

const fmt = (v: number): string => (v >= 1e6 ? `${(v / 1e6).toFixed(1)} M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)} k` : String(Math.round(v)));
const pct = (a: number, b: number): string => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');
const card: any = { background: '#fff', border: `1px solid ${T.line}`, borderRadius: 10, padding: '14px 18px', boxShadow: '0 4px 12px rgba(0,0,0,.02),0 2px 8px rgba(0,0,0,.04)', minWidth: 0 };
const dayTotal = (d: Usage['daily'][number]) => d.input + d.output + d.cacheRead;

/** 圆角顶的柱（只圆上面两角，堆叠段之间不断开） */
const barPath = (x: number, y: number, w: number, h: number, r: number): string => {
  const rr = Math.min(r, w / 2, Math.max(0, h));
  return `M${x} ${y + h} V${y + rr} q0 ${-rr} ${rr} ${-rr} h${w - 2 * rr} q${rr} 0 ${rr} ${rr} V${y + h} z`;
};

function Trend({ u, days, onDays }: { u: Usage; days: number; onDays: (d: number) => void }) {
  const [mode, setMode] = useState<'tok' | 'call'>('tok');
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const W = 900, H = 252, L = 52, R = 16, TP = 26, B = 34, iw = W - L - R, ih = H - TP - B;
  const rows = u.daily;
  const val = (d: Usage['daily'][number]) => (mode === 'tok' ? dayTotal(d) : d.calls);
  const max = Math.max(...rows.map(val), 1) * 1.16;
  const Y = (v: number) => TP + ih - (v / max) * ih;
  const bw = rows.length > 0 ? iw / rows.length : iw;
  const w = Math.min(38, bw * 0.52);
  const maxCall = Math.max(...rows.map((d) => d.calls), 1);
  const sumTok = rows.reduce((a, d) => a + dayTotal(d), 0);
  const sumCall = rows.reduce((a, d) => a + d.calls, 0);
  const pill = (on: boolean): any => ({ border: `1px solid ${on ? T.blue : T.line}`, borderRadius: 6, padding: '0 9px', fontSize: 12.5, color: on ? '#fff' : T.sub, background: on ? T.blue : '#fff', cursor: 'pointer', whiteSpace: 'nowrap' });

  return (
    <div style={card}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, color: T.dim, flexWrap: 'wrap', marginBottom: 10 }}>
        范围 <span onClick={() => onDays(7)} style={pill(days === 7)}>近 7 日</span><span onClick={() => onDays(30)} style={pill(days === 30)}>近 30 日</span>
        <span style={{ marginLeft: 10 }}>口径</span>
        <span onClick={() => setMode('tok')} style={pill(mode === 'tok')}>tokens</span>
        <span onClick={() => setMode('call')} style={pill(mode === 'call')}>调用次数</span>
        <span style={{ marginLeft: 'auto' }}>合计 {fmt(sumTok)} tokens · {fmtInt(sumCall)} 次调用</span>
      </div>
      {rows.length === 0 ? <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.dim, fontSize: 13.5 }}>窗口内还没有模型调用</div> : (
        <div style={{ position: 'relative' }}>
          <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
            {[0, 1, 2].map((k) => {
              const v = (max * k) / 2, y = Y(v);
              return (
                <g key={k}>
                  <line x1={L} x2={W - R} y1={y} y2={y} stroke={k === 0 ? '#E4E7EC' : '#F1F3F6'} />
                  <text x={L - 10} y={y + 4} textAnchor="end" fontSize={10.5} fill={T.dim}>{mode === 'tok' ? fmt(v) : Math.round(v)}</text>
                </g>
              );
            })}
            {rows.map((d, i) => {
              const cx = L + i * bw + bw / 2, bx = cx - w / 2, total = val(d);
              const segs = (mode === 'tok'
                ? [{ v: d.cacheRead, c: CACHE }, { v: d.input, c: IN }, { v: d.output, c: OUT }]
                : [{ v: d.calls, c: CALL }]).filter((s) => s.v > 0);
              let y = TP + ih;
              return (
                <g key={d.day}>
                  <rect x={L + i * bw + 1} y={TP - 14} width={Math.max(0, bw - 2)} height={ih + 14} rx={6}
                    fill={hover?.i === i ? T.fill : 'transparent'}
                    onMouseMove={(e) => setHover({ i, x: e.clientX, y: e.clientY })} onMouseLeave={() => setHover(null)} />
                  {segs.map((s, si) => {
                    const h = (s.v / max) * ih; y -= h;
                    const top = si === segs.length - 1;
                    return <path key={si} d={top ? barPath(bx, y, w, h, 4) : `M${bx} ${y} h${w} v${h} h${-w} z`} fill={s.c} pointerEvents="none" />;
                  })}
                  {total > 0 && (days === 7 || total > max * 0.25)
                    ? <text x={cx} y={y - 7} textAnchor="middle" fontSize={10.5} fill={T.sub} style={tnum} pointerEvents="none">{mode === 'tok' ? fmt(total) : total}</text> : null}
                  {days === 7 || i % 5 === 0 || i === rows.length - 1
                    ? <text x={cx} y={H - 12} textAnchor="middle" fontSize={10.5} fill={T.dim} pointerEvents="none">{d.day}</text> : null}
                </g>
              );
            })}
          </svg>
          {mode === 'tok' ? (
            <svg width="100%" height={44} viewBox={`0 0 ${W} 44`} style={{ display: 'block', marginTop: -2 }}>
              <text x={L - 10} y={26} textAnchor="end" fontSize={10.5} fill={T.dim}>调用次数</text>
              <text x={L - 10} y={38} textAnchor="end" fontSize={10} fill={T.dim}>峰值 {maxCall}</text>
              {rows.map((d, i) => d.calls > 0
                ? <path key={d.day} d={barPath(L + i * bw + bw / 2 - w / 2, 28 - Math.max(2, (d.calls / maxCall) * 20), w, Math.max(2, (d.calls / maxCall) * 20), 2)} fill={CALL} opacity={0.55} />
                : null)}
            </svg>
          ) : null}
          {hover !== null && rows[hover.i] !== undefined ? (
            <div style={{ position: 'fixed', left: Math.min(hover.x + 14, window.innerWidth - 260), top: hover.y + 14, background: '#fff', border: `1px solid ${T.line}`, borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,.12)', padding: '8px 12px', fontSize: 12.5, lineHeight: 1.6, pointerEvents: 'none', zIndex: 9 }}>
              <b>{rows[hover.i].day}</b><br />
              缓存读 {fmt(rows[hover.i].cacheRead)}<br />输入 {fmt(rows[hover.i].input)}<br />输出 {fmt(rows[hover.i].output)}<br />
              合计 <b>{fmt(dayTotal(rows[hover.i]))}</b> · {rows[hover.i].calls} 次调用
            </div>
          ) : null}
        </div>
      )}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5, color: T.sub, marginTop: 10, alignItems: 'center' }}>
        {[[CACHE, '缓存读（命中的重复输入 · 计费远低于新增）'], [IN, '输入（新增）'], [OUT, '输出']].map(([c, label]) => (
          <span key={label}><i style={{ width: 9, height: 9, borderRadius: 3, display: 'inline-block', marginRight: 5, verticalAlign: 'middle', background: c }} />{label}</span>
        ))}
        <span style={{ color: T.dim }}>悬停看当日四项明细</span>
      </div>
    </div>
  );
}

function Comp({ label, items }: { label: string; items: { name: string; desc: string; tokens: number; color: string }[] }) {
  const total = items.reduce((a, x) => a + x.tokens, 0);
  if (total === 0) return <div style={{ fontSize: 12.5, color: T.dim, margin: '4px 0 10px' }}>{label}：窗口内无数据</div>;
  return (
    <>
      <div style={{ fontSize: 12.5, color: T.dim, marginBottom: 2 }}>{label}</div>
      <div style={{ display: 'flex', height: 22, borderRadius: 6, overflow: 'hidden', margin: '2px 0 10px' }}>
        {items.map((x) => <i key={x.name} title={`${x.name} ${fmt(x.tokens)}`} style={{ display: 'block', height: '100%', width: `${(x.tokens / total * 100).toFixed(2)}%`, background: x.color }} />)}
      </div>
      <div style={{ fontSize: 13.5 }}>
        {items.map((x, i) => (
          <div key={x.name} style={{ display: 'grid', gridTemplateColumns: '14px minmax(0,1fr) 78px 52px', gap: 10, alignItems: 'center', padding: '6px 0', borderTop: i === 0 ? 'none' : `1px solid ${T.line}` }}>
            <i style={{ width: 10, height: 10, borderRadius: 3, background: x.color, display: 'inline-block' }} />
            <span style={{ minWidth: 0, lineHeight: 1.35 }}>{x.name}<small style={{ display: 'block', color: T.dim, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.desc}</small></span>
            <span style={{ textAlign: 'right', fontWeight: 600, ...tnum }}>{fmt(x.tokens)}</span>
            <span style={{ textAlign: 'right', color: T.dim, fontSize: 12.5, ...tnum }}>{(x.tokens / total * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </>
  );
}

export function UsagePanel({ call, openSession }: { call: (endpoint: string, payload?: unknown) => Promise<any>; openSession: (id: string) => void }) {
  const [u, setU] = useState<Usage | null>(null);
  const [err, setErr] = useState('');
  const [days, setDays] = useState(7);
  const daysRef = useRef(days);
  useEffect(() => {
    daysRef.current = days;
    let live = true;
    const load = () => call('usage', { days: daysRef.current }).then((v) => { if (live) { setU(v); setErr(''); } }).catch((e) => { if (live) setErr(String(e?.message ?? e)); });
    load();
    const t = setInterval(load, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [days]);

  const stats = useMemo(() => {
    if (u === null) return [];
    const t = u.totals;
    const total = t.input + t.output + t.cacheRead;
    const promptAll = t.input + t.cacheRead;
    const task = u.bySource.find((s) => s.kind === 'task');
    const todayTotal = u.today.input + u.today.output + u.today.cacheRead;
    return [
      { l: `近 ${u.windowDays} 日总量`, v: fmt(total), unit: 'tokens', d: `输入 ${fmt(t.input)} · 输出 ${fmt(t.output)} · 缓存读 ${fmt(t.cacheRead)}` },
      { l: '缓存读占比', v: pct(t.cacheRead, total), color: T.lv.ok, d: `${fmt(t.cacheRead)} 走缓存 · 命中率 ${pct(t.cacheRead, promptAll)}（省下的重复输入）` },
      { l: '调用次数', v: fmtInt(t.calls), d: t.calls > 0 ? `平均每次 ${fmt(Math.round(total / t.calls))} · ${fmtInt(t.sessions)} 个会话` : '窗口内无调用' },
      { l: '任务运行占比', v: task === undefined ? '—' : pct(task.tokens, total), d: task === undefined ? '窗口内没有任务触发' : `${fmt(task.tokens)} / ${fmtInt(task.sessions)} 个会话` },
      { l: '推理 tokens', v: fmt(t.reasoning), d: t.output > 0 ? `占输出的 ${pct(t.reasoning, t.output)}（已含在输出里）` : '—' },
      { l: '今日', v: todayTotal === 0 ? '0' : fmt(todayTotal), color: todayTotal === 0 ? T.dim : undefined, d: todayTotal === 0 ? '今天还没有模型调用' : `${u.today.calls} 次调用` },
    ];
  }, [u]);

  if (err !== '') return <div style={{ fontSize: 14, color: T.lv.crit, padding: 12 }}>加载失败：{err}</div>;
  if (u === null) return <div style={{ color: T.dim, fontSize: 14, padding: 12 }}>加载中…</div>;
  const total = u.totals.input + u.totals.output + u.totals.cacheRead;
  const maxSize = Math.max(...u.sizes.map((s) => s.count), 1);
  const totSize = u.sizes.reduce((a, s) => a + s.count, 0);

  return (
    <div style={{ fontFamily: FONT, color: T.ink, lineHeight: 1.75 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>模型用量</h1>
        {total > 0 ? <span style={{ fontSize: 13, borderRadius: 6, padding: '1px 9px', fontWeight: 500, background: T.soft.ok, color: T.lv.ok }}>缓存命中 {pct(u.totals.cacheRead, u.totals.input + u.totals.cacheRead)}</span> : null}
        <span style={{ fontSize: 13.5, color: T.dim }}>
          近 {u.windowDays} 日 · {fmtInt(u.totals.calls)} 次调用 · {u.byModel.length} 个模型 · 数据源：会话事件里的 usage（输入 / 输出 / 缓存读 / 推理）
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(158px, 1fr))', gap: 10, margin: '14px 0 18px' }}>
        {stats.map((s) => (
          <div key={s.l} style={{ background: T.fill, borderRadius: 8, padding: '10px 13px', minWidth: 0 }}>
            <div style={{ fontSize: 12.5, color: T.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.l}</div>
            <div style={{ fontSize: 21, fontWeight: 600, lineHeight: 1.3, marginTop: 1, whiteSpace: 'nowrap', color: s.color, ...tnum }}>
              {s.v}{s.unit !== undefined ? <span style={{ fontSize: 12.5, fontWeight: 500, color: T.dim, marginLeft: 4 }}>{s.unit}</span> : null}
            </div>
            <div style={{ fontSize: 12, color: T.dim, lineHeight: 1.45 }}>{s.d}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '26px 0 12px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 18, fontWeight: 600 }}>用量趋势</span>
        <span style={{ fontSize: 13.5, color: T.dim }}>逐日堆叠 · 缓存读 / 输入 / 输出 · 调用次数单独一条，不与柱子抢轴</span>
      </div>
      <Trend u={u} days={days} onDays={setDays} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 12, marginTop: 14 }}>
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 16, fontWeight: 600 }}>用量构成</span>
            <span style={{ fontSize: 13, color: T.dim }}>近 {u.windowDays} 日 · 按来源与模型</span>
          </div>
          <Comp label="按来源" items={u.bySource.map((s) => ({
            name: SRC_CN[s.kind] ?? s.kind, color: SRC_COLOR[s.kind] ?? T.dim,
            desc: `${SRC_DESC[s.kind] ?? ''} · ${fmtInt(s.sessions)} 个会话 · ${fmtInt(s.calls)} 次调用`, tokens: s.tokens,
          }))} />
          <div style={{ marginTop: 14 }}>
            <Comp label="按模型" items={u.byModel.map((m, i) => ({
              name: m.model, color: [IN, OUT, CACHE, CALL][i % 4], desc: `${fmtInt(m.calls)} 次调用`, tokens: m.tokens,
            }))} />
          </div>
        </div>
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 16, fontWeight: 600 }}>单次调用规模</span>
            <span style={{ fontSize: 13, color: T.dim }}>近 {u.windowDays} 日 · 每次请求的 tokens（含缓存读）</span>
          </div>
          {u.sizes.map((s) => (
            <div key={s.bucket} style={{ display: 'grid', gridTemplateColumns: '78px minmax(0,1fr) 96px', gap: 10, alignItems: 'center', fontSize: 13, padding: '5px 0' }}>
              <span style={{ color: T.sub, fontFamily: mono, fontSize: 12.5 }}>{s.bucket}</span>
              <span style={{ height: 14, borderRadius: 4, background: T.fill2, position: 'relative', overflow: 'hidden' }}>
                <i style={{ position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 4, background: IN, width: `${s.count === 0 ? 0 : Math.max(1.5, (s.count / maxSize) * 100)}%` }} />
              </span>
              <span style={{ textAlign: 'right', whiteSpace: 'nowrap', ...tnum }}>{fmtInt(s.count)}<span style={{ color: T.dim, fontSize: 11.5 }}> · {totSize > 0 ? Math.round((s.count / totSize) * 100) : 0}%</span></span>
            </div>
          ))}
          <div style={{ fontSize: 13, color: T.sub, marginTop: 10, lineHeight: 1.7 }}>
            每次调用都带着完整的 SOP 与工具定义，靠 prompt 缓存把这部分变成缓存读——所以<b>缓存读占比越高越省</b>。
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '26px 0 12px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 18, fontWeight: 600 }}>Top 会话</span>
        <span style={{ fontSize: 13.5, color: T.dim }}>近 {u.windowDays} 日按 tokens 排序 · 点「打开会话」进入</span>
      </div>
      <div style={{ ...card, padding: '4px 18px 8px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
          <thead>
            <tr>{['会话', '来源', 'tokens', '调用', '平均每次', '模型', ''].map((h, i) => (
              <th key={h + i} style={{ textAlign: i >= 2 && i <= 4 ? 'right' : 'left', fontSize: 12.5, color: T.dim, fontWeight: 500, padding: '9px 10px', borderBottom: `1px solid ${T.line}`, whiteSpace: 'nowrap' }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {u.topSessions.map((s) => (
              <tr key={s.sessionId}>
                <td style={{ padding: '8px 10px', borderTop: `1px solid ${T.line}`, maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.title}>{s.title}</td>
                <td style={{ padding: '8px 10px', borderTop: `1px solid ${T.line}` }}><span style={{ fontSize: 12, borderRadius: 6, padding: '1px 8px', background: T.fill2, color: T.sub, whiteSpace: 'nowrap' }}>{SRC_CN[s.kind] ?? s.kind}</span></td>
                <td style={{ padding: '8px 10px', borderTop: `1px solid ${T.line}`, textAlign: 'right', fontWeight: 600, ...tnum }}>{fmt(s.tokens)}</td>
                <td style={{ padding: '8px 10px', borderTop: `1px solid ${T.line}`, textAlign: 'right', ...tnum }}>{s.calls}</td>
                <td style={{ padding: '8px 10px', borderTop: `1px solid ${T.line}`, textAlign: 'right', ...tnum }}>{s.calls > 0 ? fmt(Math.round(s.tokens / s.calls)) : '—'}</td>
                <td style={{ padding: '8px 10px', borderTop: `1px solid ${T.line}`, fontFamily: mono, fontSize: 12.5, color: T.sub }}>{s.model}</td>
                <td style={{ padding: '8px 10px', borderTop: `1px solid ${T.line}` }}>
                  <button type="button" onClick={() => openSession(s.sessionId)} style={{ font: 'inherit', fontSize: 12.5, color: T.blue, background: 'none', border: 'none', padding: 0, cursor: 'pointer', whiteSpace: 'nowrap' }}>打开会话 →</button>
                </td>
              </tr>
            ))}
            {u.topSessions.length === 0 ? <tr><td colSpan={7} style={{ padding: '12px 10px', color: T.dim }}>窗口内还没有模型调用</td></tr> : null}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 13, color: T.dim, border: `1px dashed ${T.line}`, borderRadius: 8, padding: '8px 14px', marginTop: 18 }}>
        口径：数字来自会话事件 <span style={{ fontFamily: mono }}>assistant/message.usage</span>，四个字段都由模型 API 原样返回——
        缓存读取自 <span style={{ fontFamily: mono }}>prompt_tokens_details.cached_tokens</span>（OpenAI 系）/
        <span style={{ fontFamily: mono }}> prompt_cache_hit_tokens</span>（DeepSeek）/
        <span style={{ fontFamily: mono }}> cache_read_input_tokens</span>（Anthropic），提供方不返回就是 0，平台不估算。
        「输入」已扣掉缓存部分，所以总量 = 输入 + 输出 + 缓存读不会双算；「推理」已含在输出里，不另计入总量。
        来源按会话标题归类。<b>不做费用换算</b>：平台不存单价，要看钱请按各模型官方价自行折算。
      </div>
    </div>
  );
}
