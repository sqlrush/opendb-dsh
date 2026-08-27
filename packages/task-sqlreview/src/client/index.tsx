/**
 * task-sqlreview client 面板（R5，2026-08-27 user 定稿 docs/prototypes/sqlreview-r5.html）：
 * 状态带 + 负载总量 → Top SQL 资源占比（配置维度各一根 100% 堆叠条 + 脚本生成的一眼结论）→
 * 按维度榜单（每个维度一张，同一条 SQL 可上多榜）→ 逐条分析卡（指标·计划·归到本条的违规·优化·解读·一键深挖）→
 * 与上榜 SQL 无关的违规（折叠）→ 根因/优先级 → 检查历史。
 * 数字全部来自采集存档 run.collect（确定性直读），模型报告 run.report.data 只贡献逐条解读/优先级/根因。
 * 只读展示；深挖 = 直接新建会话并发送（不再复制提示词）。
 */
import { useEffect, useMemo, useState } from 'react';

export const inject = ['slots'];

const T = {
  ink: '#0f1115', sub: '#61666b', dim: '#81858c', blue: '#4176e6',
  line: 'rgba(0,0,0,.08)', fill: '#f7f8fa', fill2: '#f2f3f5', rest: '#dde0e5',
  sev: {
    ok: { c: '#3fa552', soft: '#e8f5ec', cn: '正常' },
    notice: { c: '#c9862d', soft: '#faf3e5', cn: '关注' },
    warn: { c: '#e07a1f', soft: '#fdf0e3', cn: '告警' },
    critical: { c: '#d64545', soft: '#fdecec', cn: '严重' },
  } as Record<string, { c: string; soft: string; cn: string }>,
};
const sev = (l: string) => T.sev[l] ?? T.sev.ok;
const PALETTE = ['#4176e6', '#2fa79a', '#8b6be0', '#e0963f', '#d9607a', '#5ba95b', '#4fa3d9', '#b08a5a', '#7a8aa6', '#c67bb5'];
const colorOf = (label: string): string => {
  const n = Number(String(label).replace(/\D/g, '')) || 1;
  return String(label).startsWith('Q') ? '#9aa3ad' : PALETTE[(n - 1) % PALETTE.length];
};
const mono = '"JetBrains Mono","SF Mono",Menlo,Consolas,monospace';
const tnum: any = { fontVariantNumeric: 'tabular-nums' };
const card: any = { background: '#fff', border: `1px solid ${T.line}`, borderRadius: 8, padding: '16px 20px', boxShadow: '0 4px 12px rgba(0,0,0,.02),0 2px 8px rgba(0,0,0,.04)' };
const codeBlock: any = { background: T.fill, borderRadius: 10, padding: '12px 14px', font: `13px/1.8 ${mono}`, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: T.ink, overflowX: 'auto' };
const keyChip: any = { font: `600 12px ${mono}`, background: T.fill, border: `1px solid ${T.line}`, borderRadius: 5, padding: '1px 7px', color: T.sub, whiteSpace: 'nowrap' };

const DIM_LABEL: Record<string, string> = { elapsed: '总耗时', calls: '执行次数', avg: '平均耗时', cpu: 'CPU 时间', io: 'IO 时间', blocks: '逻辑读', dbtime: 'DB Time', spill: '下盘', rows: '返回行数' };
const DIM_SUB: Record<string, string> = { elapsed: 'elapsed', calls: 'n_calls', avg: 'elapsed / calls', cpu: 'cpu_time', io: 'data_io_time', blocks: 'n_blocks_fetched', dbtime: 'db_time', spill: 'spill bytes', rows: 'n_returned_rows' };
const VERIFY_BADGE: Record<string, { t: string; c: string; bg: string }> = {
  'explain-verified': { t: '✓ EXPLAIN 实证', c: '#3fa552', bg: '#e8f5ec' },
  estimated: { t: '预估 · 未实证（无 hypopg）', c: '#c9862d', bg: '#faf3e5' },
  'no-gain': { t: '无低风险优化空间', c: '#81858c', bg: '#f7f8fa' },
  'plan-unavailable': { t: '计划不可得', c: '#81858c', bg: '#f7f8fa' },
};

// ───────────────────────────────────────────── 格式化
const fmtUs = (us: number): string => {
  if (!(us > 0)) return '0';
  if (us >= 3600e6) return `${(us / 3600e6).toFixed(1)} h`;
  if (us >= 60e6) return `${(us / 60e6).toFixed(1)} min`;
  if (us >= 1e6) return `${(us / 1e6).toFixed(us >= 10e6 ? 1 : 2)} s`;
  return `${(us / 1e3).toFixed(us < 10e3 ? 2 : 0)} ms`;
};
const fmtCount = (n: number): string => {
  if (!(n > 0)) return '0';
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(n >= 1e6 ? 0 : 1)} 万`;
  return n.toLocaleString();
};
const fmtBytes = (b: number): string => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(0)} KB` : `${Math.round(b)} B`);
const fmtDim = (dim: string, v: number): string => (dim === 'calls' || dim === 'rows' || dim === 'blocks' ? fmtCount(v) : dim === 'spill' ? fmtBytes(v) : fmtUs(v));
const fmtPct = (p: number | null | undefined): string => (p === null || p === undefined ? '' : `${p}%`);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

// ───────────────────────────────────────────── 小件
function H2({ children, hint }: { children: any; hint?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '28px 0 12px', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 18, fontWeight: 600, color: T.ink }}>{children}</span>
      {hint !== undefined ? <span style={{ fontSize: 13.5, color: T.dim }}>{hint}</span> : null}
    </div>
  );
}
function Sw({ color, size = 10 }: { color: string; size?: number }) {
  return <i style={{ display: 'inline-block', width: size, height: size, borderRadius: 3, background: color, flex: 'none', fontStyle: 'normal' }} />;
}
function Chip({ level, children }: { level: string; children: any }) {
  const s = sev(level);
  return <span style={{ display: 'inline-flex', gap: 5, fontSize: 13.5, fontWeight: 500, color: s.c, background: s.soft, borderRadius: 6, padding: '2px 10px', whiteSpace: 'nowrap' }}>{children}</span>;
}
function Tag({ children }: { children: any }) {
  return <span style={{ fontSize: 12, borderRadius: 4, padding: '0 7px', border: `1px solid ${T.line}`, color: T.sub, background: '#fff', whiteSpace: 'nowrap' }}>{children}</span>;
}
function Btn({ onClick, children, primary, busy, fail, title }: { onClick: () => void; children: any; primary?: boolean; busy?: boolean; fail?: boolean; title?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={busy} title={title}
      style={primary
        ? { font: 'inherit', fontSize: 14, fontWeight: 500, color: '#fff', background: fail ? T.sev.critical.c : T.blue, border: 'none', borderRadius: 10, padding: '6px 14px', cursor: busy ? 'wait' : 'pointer', display: 'inline-flex', gap: 6, alignItems: 'center', opacity: busy ? 0.7 : 1 }
        : { font: 'inherit', fontSize: 14, color: fail ? T.sev.critical.c : T.sub, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
      {children}
    </button>
  );
}

// ───────────────────────────────────────────── 深挖：一键开会话并发送（同健康报告）
let clientCtx: any;
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
function digPrompt(node: string, when: string, it: any, rules: any[], narrative: any): string {
  const m = it.metrics ?? {};
  const shares = Object.entries(it.shares ?? {}).filter(([, v]) => Number(v) >= 1).map(([d, v]) => `${DIM_LABEL[d] ?? d} ${v}%`).join('、');
  const ranks = Object.entries(it.ranks ?? {}).map(([d, n]) => `${DIM_LABEL[d] ?? d} #${n}`).join(' · ');
  return [
    `【Top SQL 深挖】节点 ${node} · 报告时间 ${when} · ${String(it.label)}（${String(it.key)}）· 类型 ${String(it.kind)}${ranks !== '' ? ` · 榜位 ${ranks}` : ''}`,
    `指标：调用 ${fmtCount(m.calls)} 次 · 均 ${fmtUs(m.avgUs)} · 最长 ${fmtUs(m.maxUs)} · 总耗时 ${fmtUs(m.elapsedUs)} · CPU ${fmtUs(m.cpuUs)} · IO ${fmtUs(m.ioUs)} · 逻辑读 ${fmtCount(m.blocks)}${m.spillBytes > 0 ? ` · 下盘 ${fmtBytes(m.spillBytes)}` : ''}${shares !== '' ? `；占全库：${shares}` : ''}`,
    `SQL：${oneLine(String(it.text))}`,
    String(it.origCost ?? '') !== '' ? `原计划总 cost ${String(it.origCost)}${(it.planFindings ?? []).length > 0 ? `；脚本标注：${(it.planFindings ?? []).map((f: any) => String(f.detail)).join('；')}` : ''}` : String(it.note ?? '') !== '' ? `计划：${String(it.note)}` : '',
    rules.length > 0 ? `归到本条的规范违规：${rules.map((f) => `[${String(f.rule)}] ${String(f.object)} ${String(f.problem)}`).join('；')}` : '',
    narrative !== undefined && String(narrative.detail ?? '') !== '' ? `报告里的解读：${String(narrative.detail)}${String(narrative.optimizedSql ?? '') !== '' ? `；已给出改写（verify=${String(narrative.verify)}）：${oneLine(String(narrative.optimizedSql))}` : ''}` : '',
    '任务：请围绕这条 SQL 深挖——先用工具（db_query EXPLAIN / db_overview / metrics_chart / sqlreview_collect 等）取证，再给出：1) 瓶颈根因与依据；2) 可行的优化方案（改写请用 EXPLAIN 实证 cost 对比；索引类注明需人工执行）；3) 预期收益与风险。本平台只读，不执行任何变更。不要向我反问，直接给结论。',
  ].filter((s) => s !== '').join('\n');
}
function DigButton({ prompt }: { prompt: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'fail'>('idle');
  return (
    <Btn primary busy={state === 'busy'} fail={state === 'fail'} title="直接新建会话并把本条 SQL 的背景发出去" onClick={() => { setState('busy'); digInSession(prompt).then(() => setState('idle')).catch(() => setState('fail')); }}>
      💬 {state === 'busy' ? '开会话中…' : state === 'fail' ? '失败，点击重试' : '在新会话中深挖 →'}
    </Btn>
  );
}
function CopyBtn({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return <Btn onClick={() => { try { void navigator.clipboard.writeText(text); } catch { /* noop */ } setDone(true); setTimeout(() => setDone(false), 1500); }}>{done ? '已复制' : label}</Btn>;
}

// ───────────────────────────────────────────── ① 负载总量
function Stats({ w }: { w: any }) {
  const hit = Number(w.blocks) > 0 ? `${((Number(w.blocksHit) / Number(w.blocks)) * 100).toFixed(1)}%` : '—';
  const cells = [
    ['唯一 SQL', fmtCount(Number(w.nSql)), '条 · 已过滤平台查询'],
    ['总调用', fmtCount(Number(w.calls)), '次'],
    ['总耗时', fmtUs(Number(w.elapsedUs)), `= ${Math.round(Number(w.elapsedUs) / 1e6).toLocaleString()} s`],
    ['DB Time', fmtUs(Number(w.dbTimeUs)), '含并行'],
    ['CPU 时间', fmtUs(Number(w.cpuUs)), `= ${Math.round(Number(w.cpuUs) / 1e6).toLocaleString()} s`],
    ['IO 时间', fmtUs(Number(w.ioUs)), `= ${Math.round(Number(w.ioUs) / 1e6).toLocaleString()} s`],
    ['逻辑读', fmtCount(Number(w.blocks)), `块 · 命中率 ${hit}`],
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
      {cells.map(([l, v, u]) => (
        <div key={l} style={{ background: T.fill, borderRadius: 8, padding: '12px 14px', minWidth: 0 }}>
          <div style={{ fontSize: 13, color: T.dim }}>{l}</div>
          <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.3, marginTop: 2, ...tnum }}>{v}</div>
          <div style={{ fontSize: 13, color: T.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u}</div>
        </div>
      ))}
    </div>
  );
}

// ───────────────────────────────────────────── ② 资源占比（配置维度各一根 100% 条）
function ShareCard({ dims, items, workload, insights }: { dims: string[]; items: any[]; workload: any; insights: any[] }) {
  const shareable = dims.filter((d) => d !== 'avg');
  const byKey = new Map(items.map((it) => [String(it.key), it]));
  const rows = shareable.map((dim) => {
    const segs = items
      .filter((it) => String(it.kind) !== '指定')
      .map((it) => ({ label: String(it.label), key: String(it.key), pct: Number(it.shares?.[dim] ?? 0) }))
      .filter((s) => s.pct > 0).sort((a, b) => b.pct - a.pct);
    const sum = Math.min(100, Math.round(segs.reduce((s, x) => s + x.pct, 0) * 10) / 10);
    return { dim, segs, sum };
  });
  return (
    <div style={card}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 24 }}>
        <div style={{ minWidth: 0 }}>
          {rows.length === 0 ? <div style={{ fontSize: 14, color: T.dim }}>配置的维度只有平均耗时——它不是可分摊的资源，无占比条。</div> : null}
          <div style={{ display: 'grid', gap: 12 }}>
            {rows.map(({ dim, segs, sum }) => (
              <div key={dim} style={{ display: 'grid', gridTemplateColumns: '96px minmax(0,1fr) 128px', gap: 12, alignItems: 'center' }}>
                <div style={{ fontSize: 13.5, color: T.sub, textAlign: 'right' }}>{DIM_LABEL[dim] ?? dim}<div style={{ fontSize: 12, color: T.dim }}>{DIM_SUB[dim] ?? ''}</div></div>
                <div style={{ display: 'flex', height: 26, borderRadius: 5, overflow: 'hidden', background: T.rest }}>
                  {segs.map((s) => (
                    <div key={s.key} title={`${s.label} · ${oneLine(String(byKey.get(s.key)?.text ?? '')).slice(0, 80)} · ${s.pct}%`}
                      style={{ width: `${s.pct}%`, background: colorOf(s.label), display: 'flex', alignItems: 'center', justifyContent: 'center', font: `600 11.5px ${mono}`, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                      {s.pct >= 6 ? `${s.pct}%` : ''}
                    </div>
                  ))}
                  <div title={`其余 ${Math.max(0, Number(workload.nSql) - items.length)} 条 · ${Math.round((100 - sum) * 10) / 10}%`} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', font: `600 11.5px ${mono}`, color: T.sub }}>{100 - sum >= 6 ? `${Math.round((100 - sum) * 10) / 10}%` : ''}</div>
                </div>
                <div style={{ fontSize: 13.5, color: T.sub }}>上榜合计 <b style={{ color: T.ink, ...tnum }}>{sum}%</b></div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 14, fontSize: 13, color: T.sub }}>
            {items.filter((it) => String(it.kind) !== '指定').map((it) => (
              <a key={String(it.key)} href={`#topsql-${String(it.key)}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: T.sub, textDecoration: 'none', maxWidth: 360 }}>
                <Sw color={colorOf(String(it.label))} /><span style={keyChip}>{String(it.label)}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: mono, fontSize: 12 }}>{oneLine(String(it.text)).slice(0, 60)}</span>
              </a>
            ))}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Sw color={T.rest} />其余 {fmtCount(Math.max(0, Number(workload.nSql) - items.length))} 条</span>
          </div>
        </div>
        <div style={{ borderLeft: `1px solid ${T.line}`, paddingLeft: 24, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, color: T.dim, marginBottom: 8 }}>一眼结论（脚本按占比自动生成）</div>
          {insights.length === 0 ? <div style={{ fontSize: 14, color: T.dim }}>没有单条占比达到高亮线的 SQL。</div> : null}
          {insights.map((i, k) => {
            const it = i.key !== undefined ? byKey.get(String(i.key)) : undefined;
            return (
              <div key={k} style={{ display: 'flex', gap: 10, marginBottom: 12, fontSize: 14.5, lineHeight: 1.6 }}>
                <span style={{ marginTop: 8 }}><Sw color={it !== undefined ? colorOf(String(it.label)) : i.level === 'warn' ? T.sev.warn.c : T.rest} /></span>
                <div>{it !== undefined ? <a href={`#topsql-${String(it.key)}`} style={{ color: 'inherit', textDecoration: 'none' }}>{String(i.text)}</a> : String(i.text)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────── ③ 榜单（每个维度一张）
function Board({ board, items, rulesCount }: { board: any; items: Map<string, any>; rulesCount: (key: string) => number }) {
  const dim = String(board.dim);
  const values: number[] = (board.values ?? []).map(Number);
  const max = Math.max(...values, 1e-9);
  return (
    <div style={{ ...card, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <b style={{ fontSize: 16, fontWeight: 600 }}>按{String(board.label)} Top {values.length}</b>
        <span style={{ fontSize: 12.5, color: T.dim }}>{String(board.desc ?? DIM_SUB[dim] ?? '')}</span>
      </div>
      {(board.keys ?? []).map((k: string, i: number) => {
        const it = items.get(String(k));
        if (it === undefined) return null;
        const share = board.shares?.[i];
        const v = values[i];
        const m = it.metrics ?? {};
        const n = rulesCount(String(k));
        return (
          <a key={String(k)} href={`#topsql-${String(k)}`} style={{ display: 'grid', gridTemplateColumns: '18px minmax(0,1fr)', gap: 10, padding: '9px 0', borderTop: i === 0 ? 'none' : `1px solid ${T.line}`, alignItems: 'start', color: 'inherit', textDecoration: 'none', minWidth: 0 }}>
            <div style={{ font: `600 13px ${mono}`, color: T.dim, paddingTop: 3 }}>{i + 1}</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <Sw color={colorOf(String(it.label))} /><span style={keyChip}>{String(it.label)}</span>
                <span style={{ font: `12.5px ${mono}`, color: T.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0 }}>{oneLine(String(it.text))}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 150px', gap: 10, alignItems: 'center', marginTop: 5 }}>
                <div style={{ height: 8, borderRadius: 3, background: T.fill2, overflow: 'hidden' }}><i style={{ display: 'block', height: '100%', borderRadius: 3, width: `${Math.max(2, (v / max) * 100)}%`, background: colorOf(String(it.label)) }} /></div>
                <div style={{ fontSize: 13, color: T.sub, textAlign: 'right', whiteSpace: 'nowrap', ...tnum }}><b style={{ color: T.ink, fontWeight: 600 }}>{fmtDim(dim, v)}</b>{share !== null && share !== undefined ? ` · ${share}%` : dim === 'avg' ? ' / 次' : ''}</div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, color: T.dim, marginTop: 3, flexWrap: 'wrap' }}>
                <Tag>{String(it.kind)}</Tag>
                <span>{fmtCount(Number(m.calls))} 次 · 均 {fmtUs(Number(m.avgUs))}{Number(m.spillBytes) > 0 ? ' · 下盘' : ''}</span>
                <span style={{ fontSize: 11.5, borderRadius: 4, padding: '0 6px', fontWeight: n > 0 ? 600 : 500, background: n > 0 ? T.sev.warn.soft : T.fill, color: n > 0 ? T.sev.warn.c : T.dim }}>规范 {n}</span>
              </div>
            </div>
          </a>
        );
      })}
    </div>
  );
}

// ───────────────────────────────────────────── ④ 逐条分析卡
function Metric({ l, v, s, hot }: { l: string; v: string; s?: string; hot?: boolean }) {
  return (
    <div style={{ padding: '10px 16px', borderRight: `1px solid ${T.line}`, minWidth: 0 }}>
      <div style={{ fontSize: 12.5, color: T.dim }}>{l}</div>
      <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.35, ...tnum }}>{v}</div>
      {s !== undefined ? <div style={{ fontSize: 12, color: hot ? T.sev.warn.c : T.dim, fontWeight: hot ? 600 : 400, ...tnum }}>{s}</div> : null}
    </div>
  );
}
function PlanBlock({ plan, findings, cost, note }: { plan: string[]; findings: any[]; cost: string; note?: string }) {
  const byLine = new Map<number, any>(findings.map((f) => [Number(f.line), f]));
  return (
    <div>
      <div style={{ fontSize: 13.5, color: T.dim, fontWeight: 500, marginBottom: 4 }}>原执行计划{cost !== '' ? <span style={{ fontWeight: 400 }}> · 总 cost {Number(cost).toLocaleString()}</span> : null}<span style={{ fontWeight: 400 }}> · 优化点标在计划行上</span>{note !== undefined && note !== '' ? <span style={{ fontWeight: 400 }}> · {note}</span> : null}</div>
      <div style={{ ...codeBlock, whiteSpace: 'pre', lineHeight: 1.75 }}>
        {plan.map((line, i) => {
          const f = byLine.get(i);
          const lv = f !== undefined ? (String(f.level) === 'warn' ? 'critical' : 'warn') : undefined;
          return (
            <div key={i} style={lv !== undefined ? { background: sev(lv).soft, borderRadius: 4, margin: '0 -6px', padding: '0 6px', display: 'inline-block', minWidth: '100%' } : undefined}>
              {line}{f !== undefined ? <b style={{ color: sev(lv!).c, marginLeft: 10, fontWeight: 600 }}>{lv === 'critical' ? '🔴' : '⚠'} {String(f.detail)}</b> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
function RuleRows({ rules }: { rules: any[] }) {
  if (rules.length === 0) return <div style={{ fontSize: 13.5, color: T.dim }}>0 条——本条涉及的对象没有规则命中</div>;
  return (
    <div style={{ display: 'grid', gap: 0 }}>
      {rules.map((f, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '8px 64px minmax(0,1fr)', gap: 10, alignItems: 'start', fontSize: 13.5, padding: '6px 0', borderTop: i === 0 ? 'none' : `1px solid ${T.line}` }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: sev(String(f.level)).c, marginTop: 9 }} />
          <span style={keyChip}>{String(f.rule)}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: mono, fontSize: 12.5, color: T.sub, wordBreak: 'break-all' }}>{String(f.object)}</div>
            <div>{String(f.problem)}</div>
            {String(f.advice ?? '') !== '' ? <div style={{ fontSize: 13, color: T.dim }}>{String(f.advice)}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
function CostBars({ orig, next }: { orig: number; next: number }) {
  const max = Math.max(orig, next, 1);
  const drop = orig > 0 ? Math.round((1 - next / orig) * 1000) / 10 : 0;
  const row = (label: string, v: number, color: string, txt: string) => (
    <div style={{ display: 'grid', gridTemplateColumns: '56px minmax(0,1fr) 150px', gap: 10, alignItems: 'center', fontSize: 13.5 }}>
      <span style={{ color: T.dim }}>{label}</span>
      <div style={{ height: 12, borderRadius: 4, background: color, width: `${Math.max(3, (v / max) * 100)}%`, minWidth: 20 }} />
      <b style={{ color, ...tnum }}>{txt}</b>
    </div>
  );
  return (
    <div style={{ display: 'grid', gap: 6, marginTop: 10, maxWidth: 520 }}>
      {row('原计划', orig, '#e9b8b8', `cost ${orig.toLocaleString()}`)}
      {row('优化后', next, T.sev.ok.c, `${next.toLocaleString()} ${drop > 0 ? `↓${drop}%` : '持平'}`)}
    </div>
  );
}
function SqlCard({ it, rules, narrative, node, when }: { it: any; rules: any[]; narrative: any; node: string; when: string }) {
  const m = it.metrics ?? {}; const sh = it.shares ?? {};
  const verify = String(narrative?.verify ?? (it.explainOk ? 'no-gain' : 'plan-unavailable'));
  const badge = VERIFY_BADGE[verify] ?? VERIFY_BADGE['plan-unavailable'];
  const drop = String(narrative?.costDropPct ?? '');
  const orig = Number(it.origCost || 0); const next = Number(narrative?.newCost || 0);
  const ranks = Object.entries(it.ranks ?? {}) as [string, number][];
  const hot = (p: unknown) => Number(p) >= 10;
  const hitPct = Number(m.blocks) > 0 ? `${((Number(m.blocksHit) / Number(m.blocks)) * 100).toFixed(1)}%` : '—';
  const isSpecified = String(it.kind) === '指定';
  return (
    <div id={`topsql-${String(it.key)}`} style={{ ...card, padding: 0, overflow: 'hidden', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px', borderBottom: `1px solid ${T.line}`, flexWrap: 'wrap' }}>
        <Sw color={colorOf(String(it.label))} /><span style={keyChip}>{String(it.label)}</span>
        <span style={{ font: `12.5px ${mono}`, color: T.dim }}>{String(it.key)}</span>
        {ranks.length > 0 ? <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', fontSize: 12.5, color: T.sub }}>{ranks.map(([d, n]) => <span key={d} style={{ background: T.fill, borderRadius: 4, padding: '0 7px' }}>{DIM_LABEL[d] ?? d} #{n}</span>)}</span> : null}
        <Tag>{String(it.kind)}</Tag>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 5, fontSize: 13.5, fontWeight: 600, color: badge.c, background: badge.bg, borderRadius: 6, padding: '2px 10px', whiteSpace: 'nowrap' }}>
          {badge.t}{verify === 'explain-verified' && Number(drop) > 0 ? ` · cost ↓${drop}%` : ''}
        </span>
      </div>
      {!isSpecified ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', borderBottom: `1px solid ${T.line}` }}>
          <Metric l="调用次数" v={fmtCount(Number(m.calls))} s={`占 ${fmtPct(sh.calls)}`} hot={hot(sh.calls)} />
          <Metric l="平均耗时" v={fmtUs(Number(m.avgUs))} s={`最长 ${fmtUs(Number(m.maxUs))}`} />
          <Metric l="总耗时" v={fmtUs(Number(m.elapsedUs))} s={`占 ${fmtPct(sh.elapsed)}`} hot={hot(sh.elapsed)} />
          <Metric l="CPU 时间" v={fmtUs(Number(m.cpuUs))} s={`占 ${fmtPct(sh.cpu)}`} hot={hot(sh.cpu)} />
          <Metric l="IO 时间" v={fmtUs(Number(m.ioUs))} s={`占 ${fmtPct(sh.io)}`} hot={hot(sh.io)} />
          <Metric l="逻辑读" v={fmtCount(Number(m.blocks))} s={`占 ${fmtPct(sh.blocks)} · 命中 ${hitPct}`} hot={hot(sh.blocks)} />
          <Metric l="下盘" v={Number(m.spillBytes) > 0 ? fmtBytes(Number(m.spillBytes)) : '无'} s={Number(m.spillBytes) > 0 ? '排序/哈希外存' : undefined} hot={Number(m.spillBytes) > 0} />
        </div>
      ) : null}
      <div style={{ padding: '14px 20px 16px', display: 'grid', gap: 14 }}>
        <div><div style={{ fontSize: 13.5, color: T.dim, fontWeight: 500, marginBottom: 4 }}>{isSpecified ? '指定 SQL' : '原 SQL'}</div><div style={codeBlock}>{String(it.text)}</div></div>
        {(it.plan ?? []).length > 0 ? <PlanBlock plan={(it.plan ?? []).map(String)} findings={it.planFindings ?? []} cost={String(it.origCost ?? '')} note={it.note} />
          : String(it.note ?? '') !== '' ? <div style={{ fontSize: 13.5, color: T.dim }}>执行计划：{String(it.note)}</div> : null}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 18 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, color: T.dim, fontWeight: 500, marginBottom: 4 }}>违反规范 <span style={{ fontWeight: 400 }}>· 本条涉及对象{(it.tables ?? []).length > 0 ? ` ${(it.tables as string[]).join(' / ')}` : ''} · {rules.length} 条（规则与级别来自脚本，不可下调）</span></div>
            <RuleRows rules={rules} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, color: T.dim, fontWeight: 500, marginBottom: 4 }}>优化方案{verify === 'explain-verified' ? <span style={{ fontWeight: 400 }}> · 改写类 · 已用 db_query EXPLAIN 实证</span> : verify === 'estimated' ? <span style={{ fontWeight: 400 }}> · 索引类 · 预估</span> : null}</div>
            {String(narrative?.optimizedSql ?? '') !== '' ? <div style={{ ...codeBlock, background: T.sev.ok.soft }}>{String(narrative.optimizedSql)}</div>
              : <div style={{ fontSize: 13.5, color: T.dim }}>{narrative === undefined ? '模型解读尚未生成（报告未提交或本条未被解读）' : badge.t}</div>}
            {verify === 'explain-verified' && orig > 0 && next > 0 ? <CostBars orig={orig} next={next} /> : null}
          </div>
        </div>
        {String(narrative?.detail ?? '') !== '' ? <div style={{ fontSize: 15, color: T.sub }}>{String(narrative.detail)}</div> : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 20px', background: T.fill, borderTop: `1px solid ${T.line}`, flexWrap: 'wrap' }}>
        <DigButton prompt={digPrompt(node, when, it, rules, narrative)} />
        <CopyBtn text={String(it.text)} label="复制 SQL" />
        {String(narrative?.optimizedSql ?? '') !== '' ? <CopyBtn text={String(narrative.optimizedSql)} label="复制优化后 SQL" /> : null}
        <span style={{ marginLeft: 'auto', fontSize: 12.5, color: T.dim }}>点击即新建会话并把本条 SQL、指标、计划与违规作为背景发出</span>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────── 其他：未归因违规 / 根因优先级 / 历史
function OtherRules({ rules }: { rules: any[] }) {
  const [open, setOpen] = useState(false);
  if (rules.length === 0) return null;
  const byRule = new Map<string, { n: number; level: string }>();
  for (const f of rules) {
    const cur = byRule.get(String(f.rule)) ?? { n: 0, level: String(f.level) };
    byRule.set(String(f.rule), { n: cur.n + 1, level: cur.level });
  }
  return (
    <>
      <H2 hint={`与上榜 SQL 无关的 ${rules.length} 条 · 默认折叠`}>其他对象的规范发现</H2>
      <div style={{ ...card, padding: '12px 20px' }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: 14 }}>
          {[...byRule.entries()].map(([rule, v]) => <span key={rule} style={{ fontSize: 11.5, borderRadius: 4, padding: '0 6px', fontWeight: 600, background: sev(v.level).soft, color: sev(v.level).c }}>{rule} ×{v.n}</span>)}
          <Btn onClick={() => setOpen(!open)}><span style={{ color: T.blue, marginLeft: 6 }}>{open ? '收起 ▴' : `展开 ${rules.length} 条 ▾`}</span></Btn>
        </div>
        {open ? <div style={{ marginTop: 10 }}><RuleRows rules={rules} /></div> : null}
      </div>
    </>
  );
}
function RunStrip({ runs, selId, onSel }: { runs: any[]; selId: string; onSel: (id: string) => void }) {
  const cells = runs.slice(0, 30).reverse();
  if (cells.length === 0) return null;
  return (
    <div style={card}>
      <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 26 }}>
        {cells.map((r: any) => {
          const lv = String(r.collect?.det?.worst ?? r.report?.data?.det?.worst ?? (r.status === 'succeeded' ? 'ok' : 'notice'));
          const usable = r.report !== undefined || r.collect !== undefined;
          return (
            <i key={String(r.id)} title={`${String(r.firedAt).replace('T', ' ').slice(0, 16)} · ${lv}`} onClick={() => usable && onSel(String(r.id))}
              style={{ flex: 1, maxWidth: 16, height: '100%', borderRadius: 3, background: sev(lv).c, cursor: usable ? 'pointer' : 'default', fontStyle: 'normal', outline: r.id === selId ? `2px solid ${T.ink}` : 'none', outlineOffset: 1, opacity: usable ? 1 : 0.35 }} />
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: T.dim, marginTop: 6 }}>
        <span>{String(cells[0]?.firedAt ?? '').slice(5, 10)}</span><span>最新 ▲ · 点格子查看当次报告</span>
      </div>
    </div>
  );
}

/** 旧版报告（R5 前，无采集存档）：只把叙述摆出来，提示重新运行 */
function LegacyView({ data }: { data: any }) {
  const items = (data.sqlItems ?? []) as any[];
  return (
    <>
      <div style={{ fontSize: 13.5, color: T.sev.notice.c, background: T.sev.notice.soft, borderRadius: 8, padding: '8px 14px', marginBottom: 12 }}>这份报告由旧版生成（没有采集存档），只能显示模型叙述；重新运行任务后即为 Top SQL 大盘。</div>
      {items.map((s) => (
        <div key={String(s.key)} style={{ ...card, marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap' }}><b style={{ fontFamily: mono, fontSize: 14 }}>sql {String(s.key)}</b>{Number(s.avgMs ?? 0) > 0 ? <span style={{ fontSize: 13.5, color: T.dim }}>均耗时 {Number(s.avgMs).toLocaleString()}ms · calls {Number(s.calls).toLocaleString()}</span> : null}<span style={{ marginLeft: 'auto', fontSize: 13.5, color: T.dim }}>{String(s.verify ?? '')}</span></div>
          {String(s.text ?? '') !== '' ? <div style={{ ...codeBlock, marginTop: 8 }}>{String(s.text)}</div> : null}
          {String(s.optimizedSql ?? '') !== '' ? <div style={{ ...codeBlock, background: T.sev.ok.soft, marginTop: 8 }}>{String(s.optimizedSql)}</div> : null}
          {String(s.detail ?? '') !== '' ? <div style={{ fontSize: 15, color: T.sub, marginTop: 8 }}>{String(s.detail)}</div> : null}
        </div>
      ))}
    </>
  );
}

// ───────────────────────────────────────────── 面板
export function SqlReviewPanel({ task, runId, call }: { task: any; runId?: string; call: (endpoint: string, payload?: unknown) => Promise<any> }) {
  const [runs, setRuns] = useState<any[]>([]);
  const [selId, setSelId] = useState('');
  useEffect(() => { setSelId(typeof runId === 'string' ? runId : ''); }, [runId]);
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

  const usable = runs.filter((r) => r.report !== undefined || r.collect !== undefined);
  const current = usable.find((r) => r.id === selId) ?? usable[0];
  const data = current?.report?.data;
  const collect = current?.collect;
  const narrativeByKey = useMemo(() => new Map<string, any>(((data?.sqlItems ?? []) as any[]).map((s) => [String(s.key), s])), [data]);

  if (error !== '') return <div style={{ fontSize: 16, color: T.dim, padding: 16 }}>加载失败：{error}</div>;
  if (current === undefined) return <div style={{ fontSize: 16, color: T.dim, padding: 16 }}>还没有 Top SQL 报表——任务触发后（cron 或在会话里说一声）报告会出现在这里。</div>;

  const worst = String(collect?.det?.worst ?? data?.det?.worst ?? 'ok');
  const font = '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
  if (collect === undefined) {
    return (
      <div style={{ fontFamily: font, color: T.ink, lineHeight: 1.75 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}><span style={{ fontSize: 18, fontWeight: 600, color: sev(worst).c }}>总体：{sev(worst).cn}</span><span style={{ fontSize: 14, color: T.sub }}>{String(current.report?.summary ?? '')}</span></div>
        {data !== undefined ? <LegacyView data={data} /> : null}
        <H2 hint="一格一次运行 · 点格子查看当次报告">检查历史</H2>
        <RunStrip runs={runs} selId={String(current.id)} onSel={setSelId} />
      </div>
    );
  }

  const items: any[] = collect.items ?? [];
  const itemsByKey = new Map<string, any>(items.map((it) => [String(it.key), it]));
  const ruleFindings: any[] = collect.ruleFindings ?? [];
  const rulesOf = (it: any): any[] => ((it.ruleRefs ?? []) as number[]).map((i) => ruleFindings[i]).filter(Boolean);
  const otherRules = ((collect.unattributedRules ?? []) as number[]).map((i) => ruleFindings[i]).filter(Boolean);
  const dims: string[] = collect.dimensions ?? [];
  const when = String(collect.collectedAt ?? current.firedAt ?? '').replace('T', ' ').slice(0, 16);
  const node = String(collect.node ?? task.config?.node ?? '');
  const boards: any[] = collect.boards ?? [];

  return (
    <div style={{ fontFamily: font, color: T.ink, lineHeight: 1.75 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontSize: 18, fontWeight: 600, color: sev(worst).c }}>总体：{sev(worst).cn}</span>
        <Chip level="ok">✓ 数字来自采集器直读 · 分析由模型解读</Chip>
        <span style={{ fontSize: 13.5, color: T.dim }}>统计口径：dbe_perf.statement 累计值（自统计重置起）· 采集 {when} · 节点 {node}</span>
      </div>
      {String(current.report?.summary ?? '') !== '' ? <div style={{ fontSize: 15, color: T.sub, marginBottom: 12 }}>{String(current.report.summary)}</div> : null}
      <Stats w={collect.workload ?? {}} />

      <H2 hint={`每根横条 = 该资源的 100% · 彩色段 = 上榜 SQL · 灰色 = 其余 ${fmtCount(Math.max(0, Number(collect.workload?.nSql ?? 0) - items.length))} 条`}>Top SQL 资源占比</H2>
      <ShareCard dims={dims} items={items} workload={collect.workload ?? {}} insights={collect.insights ?? []} />

      <H2 hint={`任务配置的维度各出一榜（${dims.map((d) => DIM_LABEL[d] ?? d).join(' · ')}）· 同一条 SQL 可同时上多榜 · 在会话里说一句即可加减维度`}>Top SQL 榜单</H2>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${boards.length >= 3 ? 320 : 360}px, 1fr))`, gap: 12 }}>
        {boards.map((b) => <Board key={String(b.dim)} board={b} items={itemsByKey} rulesCount={(k) => (itemsByKey.get(k)?.ruleRefs ?? []).length} />)}
      </div>

      <H2 hint={`上榜 SQL 去重后 ${items.length} 条 · 每条：指标 → 计划 → 违反规范 → 优化 → 解读 · 违规不在顶部汇总`}>逐条分析</H2>
      {items.map((it) => <SqlCard key={String(it.key)} it={it} rules={rulesOf(it)} narrative={narrativeByKey.get(String(it.key))} node={node} when={when} />)}

      <OtherRules rules={otherRules} />

      {(String(data?.rootCause ?? '') !== '' || (data?.priorities ?? []).length > 0) ? (
        <>
          <H2 hint="模型解读 · 引用的数字均有出处">根因串联与处置优先级</H2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 18 }}>
            {String(data?.rootCause ?? '') !== '' ? <div style={{ ...card, background: T.fill, border: 'none' }}><div style={{ fontSize: 13.5, color: T.dim, fontWeight: 500, marginBottom: 4 }}>根因串联</div><div style={{ fontSize: 15, color: T.sub }}>{String(data.rootCause)}</div></div> : null}
            {(data?.priorities ?? []).length > 0 ? (
              <div style={card}><div style={{ fontSize: 13.5, color: T.dim, fontWeight: 500, marginBottom: 4 }}>处置优先级</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {(data.priorities as any[]).map((p, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '34px minmax(0,1fr)', gap: 10, alignItems: 'start', fontSize: 15 }}>
                      <span style={{ font: `600 13px ${mono}`, background: T.fill2, borderRadius: 6, textAlign: 'center', padding: '2px 0', marginTop: 4 }}>P{String(p.p).replace(/^P/i, '')}</span>
                      <div>{String(p.action)} {(p.refs ?? []).length > 0 ? <span style={{ display: 'inline-flex', gap: 4, marginLeft: 6, verticalAlign: 'middle' }}>{(p.refs as any[]).map((r, k) => <span key={k} style={keyChip}>{itemsByKey.get(String(r))?.label ?? String(r)}</span>)}</span> : null}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      <H2 hint="一格一次运行 · 点格子查看当次报告">检查历史</H2>
      <RunStrip runs={runs} selId={String(current.id)} onSel={setSelId} />

      {((collect.collectionNotes ?? []).length > 0 || (data?.collectionNotes ?? []).length > 0) ? (
        <div style={{ fontSize: 13.5, color: T.dim, border: `1px dashed ${T.line}`, borderRadius: 8, padding: '8px 14px', marginTop: 16 }}>
          📋 Collection Notes：{[...(collect.collectionNotes ?? []), ...(data?.collectionNotes ?? [])].map((n: any, i: number) => <div key={i}>{String(n)}</div>)}
        </div>
      ) : null}
    </div>
  );
}

/** 注册面板：桥已在就直接注册，否则排进 __pending 由后到的 ui-harness 兑现（2026-08-24 竞态修复） */
function registerPanel(key: string, Comp: any): void {
  if (typeof window === 'undefined') return;
  const w = window as any;
  if (w.__opendbHarness__?.registerTaskPanel !== undefined) { w.__opendbHarness__.registerTaskPanel(key, Comp); return; }
  w.__opendbHarness__ = w.__opendbHarness__ ?? {};
  w.__opendbHarness__.__pending = [...(w.__opendbHarness__.__pending ?? []), { kind: 'task', key, comp: Comp }];
}

export function apply(ctx: any): void {
  clientCtx = ctx;
  registerPanel('sqlreview', SqlReviewPanel);
}
