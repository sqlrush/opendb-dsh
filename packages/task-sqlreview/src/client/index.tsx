/**
 * task-sqlreview client 面板（R4 设计稿对齐版）：分级计数 → 违规分布环图 + 规则命中条形 →
 * 规则审核表（可展开）→ SQL 组概览 → 逐条卡片（原 SQL → 执行计划树行内标注 → 优化 SQL →
 * cost 对比 → 验证徽章 → 💬深挖）→ 检查历史趋势条（点格子切历史报告）。只读展示。
 */
import { useEffect, useState } from 'react';

export const inject = ['slots'];

const T = {
  ink: '#0f1115', sub: '#61666b', dim: '#81858c', blue: '#4176e6',
  line: 'rgba(0,0,0,.08)', fill: '#f7f8fa',
  sev: {
    ok: { c: '#3fa552', soft: '#e8f5ec', cn: '正常' },
    notice: { c: '#c9862d', soft: '#faf3e5', cn: '关注' },
    warn: { c: '#e07a1f', soft: '#fdf0e3', cn: '告警' },
    critical: { c: '#d64545', soft: '#fdecec', cn: '严重' },
  } as Record<string, { c: string; soft: string; cn: string }>,
};
const sev = (l: string) => T.sev[l] ?? T.sev.ok;
const ORDER: Record<string, number> = { critical: 3, warn: 2, notice: 1, ok: 0 };
const card: any = { background: '#fff', border: `1px solid ${T.line}`, borderRadius: 8, padding: '16px 20px', boxShadow: '0 4px 12px rgba(0,0,0,.02),0 2px 8px rgba(0,0,0,.04)' };
const mono = '"JetBrains Mono","SF Mono",Menlo,monospace';
const sqlBlock: any = { background: T.fill, borderRadius: 10, padding: '12px 14px', font: `13px/1.8 ${mono}`, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: T.ink, overflowX: 'auto' };

const VERIFY_BADGE: Record<string, { t: string; c: string; bg: string }> = {
  'explain-verified': { t: '✓ EXPLAIN 实证', c: '#3fa552', bg: '#e8f5ec' },
  estimated: { t: '预估 · 未实证（无 hypopg）', c: '#c9862d', bg: '#faf3e5' },
  'no-gain': { t: '无低风险优化空间', c: '#81858c', bg: '#f7f8fa' },
  'plan-unavailable': { t: '计划不可得', c: '#81858c', bg: '#f7f8fa' },
};

function H2({ children }: { children: any }) {
  return <div style={{ fontSize: 18, fontWeight: 600, margin: '30px 0 14px', color: T.ink, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{children}</div>;
}
function Hint({ children }: { children: any }) {
  return <span style={{ fontSize: 13.5, color: T.dim, fontWeight: 400 }}>{children}</span>;
}
function Dot({ level }: { level: string }) {
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: sev(level).c, marginRight: 6, flex: 'none' }} />;
}

function DigLink({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span style={{ fontSize: 13.5, color: copied ? T.sev.ok.c : T.blue, cursor: 'pointer' }}
      onClick={() => { try { void navigator.clipboard.writeText(text); } catch { /* noop */ } setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
      💬 {copied ? '已复制——到会话里粘贴发送即可' : `在会话里深挖：${text.length > 42 ? `${text.slice(0, 42)}…` : text}`}
    </span>
  );
}

/** 违规分布环图（中心=总数） */
function Donut({ counts }: { counts: any }) {
  const parts = [
    { k: 'critical', c: T.sev.critical.c }, { k: 'warn', c: T.sev.warn.c }, { k: 'notice', c: T.sev.notice.c },
  ].map((p) => ({ ...p, n: Number(counts?.[p.k] ?? 0) }));
  const total = parts.reduce((s, p) => s + p.n, 0);
  const R = 40; const C = 2 * Math.PI * R;
  let off = 0;
  return (
    <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
      <svg width={110} height={110} viewBox="0 0 110 110">
        <g transform="rotate(-90 55 55)">
          <circle cx={55} cy={55} r={R} fill="none" stroke="#f2f3f5" strokeWidth={16} />
          {total > 0 ? parts.filter((p) => p.n > 0).map((p) => {
            const len = (p.n / total) * C;
            const el = <circle key={p.k} cx={55} cy={55} r={R} fill="none" stroke={p.c} strokeWidth={16} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off} />;
            off += len;
            return el;
          }) : null}
        </g>
        <text x={55} y={52} textAnchor="middle" fontSize={20} fontWeight={600} fill={T.ink}>{total}</text>
        <text x={55} y={68} textAnchor="middle" fontSize={10} fill={T.dim}>条违规</text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13.5, color: T.sub }}>
        {parts.map((p) => (
          <span key={p.k}><i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 3, marginRight: 6, background: p.c, fontStyle: 'normal' }} />{sev(p.k).cn} {p.n}{total > 0 ? ` · ${Math.round((p.n / total) * 100)}%` : ''}</span>
        ))}
      </div>
    </div>
  );
}

/** 规则命中排行（条形列表） */
function RuleBars({ findings }: { findings: any[] }) {
  const byRule = new Map<string, { n: number; level: string }>();
  for (const f of findings) {
    const cur = byRule.get(String(f.rule)) ?? { n: 0, level: 'notice' };
    cur.n += 1;
    if ((ORDER[String(f.level)] ?? 0) > (ORDER[cur.level] ?? 0)) cur.level = String(f.level);
    byRule.set(String(f.rule), cur);
  }
  const rows = [...byRule.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 6);
  const max = Math.max(...rows.map(([, v]) => v.n), 1);
  return (
    <div style={{ display: 'grid', gap: 7, fontSize: 13.5, flex: 1, minWidth: 240 }}>
      <div style={{ fontSize: 13.5, color: T.dim }}>规则命中排行</div>
      {rows.map(([rule, v]) => (
        <div key={rule} style={{ display: 'grid', gridTemplateColumns: '64px 1fr 24px', gap: 8, alignItems: 'center' }}>
          <span style={{ font: `600 11.5px ${mono}`, background: T.fill, border: `1px solid ${T.line}`, borderRadius: 5, padding: '1px 6px', color: T.sub, textAlign: 'center' }}>{rule}</span>
          <div style={{ height: 12, borderRadius: 3, background: sev(v.level).c, width: `${Math.max(8, (v.n / max) * 100)}%`, opacity: 0.85 }} />
          <b style={{ fontVariantNumeric: 'tabular-nums' }}>{v.n}</b>
        </div>
      ))}
    </div>
  );
}

/** 执行计划树：行内标注优化点（设计稿反馈①：优化点直接标在计划行上） */
function PlanTree({ plan, cost }: { plan: string[]; cost: number }) {
  if (plan.length === 0) return null;
  const mark = (line: string): { level?: string; tag?: string } => {
    const seq = line.match(/Seq Scan on (\S+)/);
    if (seq !== null) {
      const rows = line.match(/rows=(\d+)/);
      const big = rows !== null && Number(rows[1]) > 100000;
      return { level: big ? 'critical' : 'warn', tag: big ? `🔴 全表扫描 ${seq[1]}（${Number(rows![1]).toLocaleString()} 行）——优先怀疑缺索引` : `⚠ 全表扫描 ${seq[1]}` };
    }
    if (/Sort Method: external|Disk:/i.test(line)) return { level: 'warn', tag: '⚠ 排序/聚合下盘（work_mem 不足）' };
    return {};
  };
  return (
    <div style={{ ...sqlBlock, whiteSpace: 'pre', lineHeight: 1.75 }}>
      {plan.map((line, i) => {
        const m = mark(line);
        return (
          <div key={i} style={m.level !== undefined ? { background: sev(m.level).soft, borderRadius: 4, margin: '0 -6px', padding: '0 6px', display: 'inline-block', minWidth: '100%' } : undefined}>
            {line}
            {m.tag !== undefined ? <b style={{ color: sev(m.level!).c, marginLeft: 10, fontWeight: 600 }}>{m.tag}</b> : null}
          </div>
        );
      })}
      {cost > 0 ? <div style={{ color: T.dim, marginTop: 4 }}>-- 总 cost {cost.toLocaleString()}</div> : null}
    </div>
  );
}

function CostBars({ orig, next }: { orig: number; next: number }) {
  const max = Math.max(orig, next, 1);
  const drop = orig > 0 ? Math.round((1 - next / orig) * 1000) / 10 : 0;
  const row = (label: string, v: number, color: string, txt: string) => (
    <div style={{ display: 'grid', gridTemplateColumns: '56px 1fr 130px', gap: 10, alignItems: 'center', fontSize: 13.5 }}>
      <span style={{ color: T.dim }}>{label}</span>
      <div style={{ height: 14, borderRadius: 4, background: color, width: `${Math.max(3, (v / max) * 100)}%`, minWidth: 20 }} />
      <b style={{ color, fontVariantNumeric: 'tabular-nums' }}>{txt}</b>
    </div>
  );
  return (
    <div style={{ display: 'grid', gap: 6, margin: '8px 0', maxWidth: 520 }}>
      {row('原计划', orig, '#e9b8b8', `cost ${orig.toLocaleString()}`)}
      {row('优化后', next, T.sev.ok.c, `${next.toLocaleString()} ${drop > 0 ? `↓${drop}%` : '持平'}`)}
    </div>
  );
}

function RuleTable({ findings }: { findings: any[] }) {
  const [showAll, setShowAll] = useState(false);
  const sorted = [...findings].sort((a, b) => (ORDER[String(b.level)] ?? 0) - (ORDER[String(a.level)] ?? 0));
  const shown = showAll ? sorted : sorted.slice(0, 6);
  const th: any = { color: T.dim, fontWeight: 500, fontSize: 13.5, textAlign: 'left', padding: '7px 10px', borderBottom: `1px solid ${T.line}`, whiteSpace: 'nowrap' };
  const td: any = { padding: '8px 10px', borderBottom: `1px solid ${T.line}`, verticalAlign: 'top', fontSize: 13.5 };
  return (
    <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead><tr><th style={th}>规则</th><th style={th}></th><th style={th}>对象</th><th style={th}>问题</th><th style={th}>整改建议</th></tr></thead>
        <tbody>
          {shown.map((f, i) => (
            <tr key={i}>
              <td style={td}><span style={{ font: `600 11.5px ${mono}`, background: T.fill, border: `1px solid ${T.line}`, borderRadius: 5, padding: '1px 6px', color: T.sub }}>{String(f.rule)}</span></td>
              <td style={td}><Dot level={String(f.level)} /></td>
              <td style={{ ...td, fontFamily: mono }}>{String(f.object).slice(0, 60)}</td>
              <td style={td}>{String(f.problem)}</td>
              <td style={td}>{String(f.advice ?? '')}</td>
            </tr>
          ))}
          {shown.length === 0 ? <tr><td style={{ ...td, color: sev('ok').c }} colSpan={5}>✓ 无违规——本轮规则全部通过</td></tr> : null}
        </tbody>
      </table>
      {sorted.length > 6 ? (
        <span style={{ fontSize: 16, color: T.blue, cursor: 'pointer', padding: '9px 16px', display: 'inline-block' }} onClick={() => setShowAll(!showAll)}>
          {showAll ? '收起 ▴' : `展开全部 ${sorted.length} 条 ▾`}
        </span>
      ) : null}
    </div>
  );
}

function SqlCard({ s }: { s: any }) {
  const badge = VERIFY_BADGE[String(s.verify)] ?? VERIFY_BADGE['plan-unavailable'];
  const orig = Number(s.origCost || 0);
  const next = Number(s.newCost || 0);
  return (
    <div style={{ ...card, marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ fontFamily: mono, fontSize: 14 }}>sql {String(s.key)}</b>
        {Number(s.avgMs ?? 0) > 0 ? <span style={{ fontSize: 13.5, color: T.dim }}>均耗时 {Number(s.avgMs).toLocaleString()}ms · calls {Number(s.calls).toLocaleString()}</span> : null}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 5, fontSize: 13.5, fontWeight: 600, color: badge.c, background: badge.bg, borderRadius: 6, padding: '2px 10px' }}>{badge.t}</span>
      </div>
      <div style={{ fontSize: 13.5, color: T.dim, margin: '10px 0 4px', fontWeight: 500 }}>原 SQL</div>
      <div style={sqlBlock}>{String(s.text)}</div>
      {(s.plan ?? []).length > 0 ? (
        <>
          <div style={{ fontSize: 13.5, color: T.dim, margin: '10px 0 4px', fontWeight: 500 }}>原执行计划 <span style={{ fontWeight: 400 }}>· 优化点直接标注在计划行上</span></div>
          <PlanTree plan={(s.plan ?? []).map(String)} cost={orig} />
        </>
      ) : (s.planNotes ?? []).length > 0 ? (
        <>
          <div style={{ fontSize: 13.5, color: T.dim, margin: '10px 0 4px', fontWeight: 500 }}>原计划优化点（脚本标注）{orig > 0 ? <span style={{ fontWeight: 400 }}>· 总 cost {orig.toLocaleString()}</span> : null}</div>
          {(s.planNotes ?? []).map((n: any, i: number) => (
            <div key={i} style={{ fontSize: 13.5, color: T.sev.warn.c, background: T.sev.warn.soft, borderRadius: 6, padding: '4px 10px', marginBottom: 4, fontFamily: mono }}>⚠ {String(n)}</div>
          ))}
        </>
      ) : null}
      {String(s.optimizedSql ?? '') !== '' ? (
        <>
          <div style={{ fontSize: 13.5, color: T.dim, margin: '10px 0 4px', fontWeight: 500 }}>优化方案</div>
          <div style={{ ...sqlBlock, background: T.sev.ok.soft }}>{String(s.optimizedSql)}</div>
          {String(s.verify) === 'explain-verified' && orig > 0 && next > 0 ? <CostBars orig={orig} next={next} /> : null}
        </>
      ) : null}
      {String(s.detail ?? '') !== '' ? <div style={{ fontSize: 16, color: T.sub, marginTop: 8 }}>{String(s.detail)}</div> : null}
      <div style={{ marginTop: 8 }}><DigLink text={`帮我评估 sql ${String(s.key)} 的进一步优化空间：${String(s.text).slice(0, 80)}…`} /></div>
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
          const lv = String(r.report?.data?.det?.worst ?? (r.status === 'succeeded' ? 'ok' : 'notice'));
          return (
            <i key={String(r.id)} title={`${String(r.firedAt).replace('T', ' ').slice(0, 16)} · ${lv}`}
              onClick={() => r.report !== undefined && onSel(String(r.id))}
              style={{ flex: 1, maxWidth: 16, height: '100%', borderRadius: 3, background: sev(lv).c, cursor: r.report !== undefined ? 'pointer' : 'default', fontStyle: 'normal', outline: r.id === selId ? `2px solid ${T.ink}` : 'none', outlineOffset: 1, opacity: r.report !== undefined ? 1 : 0.35 }} />
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

export function SqlReviewPanel({ task, call }: { task: any; call: (endpoint: string, payload?: unknown) => Promise<any> }) {
  const [runs, setRuns] = useState<any[]>([]);
  const [selId, setSelId] = useState('');
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

  const withReport = runs.filter((r) => r.report !== undefined);
  const current = withReport.find((r) => r.id === selId) ?? withReport[0];
  const data = current?.report?.data;
  if (error !== '') return <div style={{ fontSize: 16, color: T.dim, padding: 16 }}>加载失败：{error}</div>;
  if (data === undefined) return <div style={{ fontSize: 16, color: T.dim, padding: 16 }}>还没有 SQL 审核报告——任务触发后（cron 或在会话里说一声）报告会出现在这里。</div>;

  const worst = String(data.det?.worst ?? 'ok');
  const items = (data.sqlItems ?? []) as any[];
  const counts = data.det?.counts ?? {};
  const chip = (s: any) => {
    const b = VERIFY_BADGE[String(s.verify)] ?? VERIFY_BADGE['plan-unavailable'];
    const drop = String(s.costDropPct ?? '');
    return (
      <span key={String(s.key)} style={{ display: 'inline-flex', gap: 5, fontSize: 13.5, fontWeight: 600, color: b.c, background: b.bg, borderRadius: 6, padding: '2px 10px' }}>
        {String(s.key)}{String(s.verify) === 'explain-verified' ? (Number(drop) > 0 ? ` ✓ ↓${drop}%` : ' ✓ 已实证 · cost 持平') : ` · ${b.t}`}
      </span>
    );
  };

  return (
    <div style={{ fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif', color: T.ink, lineHeight: 1.75 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontSize: 18, fontWeight: 600, color: sev(worst).c }}>总体：{sev(worst).cn}</span>
        <span style={{ display: 'inline-flex', gap: 6, fontSize: 13.5, background: T.sev.ok.soft, color: T.sev.ok.c, borderRadius: 6, padding: '3px 10px', fontWeight: 500 }}>✓ 已锚定 · 规则判定由脚本产出 · 改写经 EXPLAIN 实证</span>
        <span style={{ fontSize: 13.5, color: T.dim }}>📄 报告已自动入库归档 · 只读展示</span>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'stretch' }}>
        <div style={{ ...card, minWidth: 260 }}><Donut counts={counts} /></div>
        <div style={{ ...card, flex: 1, minWidth: 260, display: 'flex' }}><RuleBars findings={(data.ruleFindings ?? []) as any[]} /></div>
      </div>

      <H2>规范审核 <Hint>确定性规则 · 级别不可被解读下调</Hint></H2>
      <RuleTable findings={data.ruleFindings ?? []} />

      <H2>SQL 优化 <Hint>本组 {items.length} 条 · 原计划标注 → 优化 → cost 对比</Hint></H2>
      <div style={{ ...card, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 13.5, color: T.dim }}>本组 {items.length} 条：</span>
        {items.map(chip)}
      </div>
      {items.map((s) => <SqlCard key={String(s.key)} s={s} />)}

      {String(data.rootCause ?? '') !== '' ? (
        <>
          <H2>根因串联</H2>
          <div style={{ ...card, background: T.fill, border: 'none' }}><div style={{ fontSize: 16, color: T.sub }}>{String(data.rootCause)}</div></div>
        </>
      ) : null}
      {(data.priorities ?? []).length > 0 ? (
        <>
          <H2>处置优先级</H2>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {(data.priorities ?? []).map((p: any, i: number) => (
              <div key={i} style={{ ...card, flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: T.sub, letterSpacing: '.05em' }}>{String(p.p)}</div>
                <div style={{ fontSize: 16, marginTop: 4 }}>{String(p.action)}</div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <H2>检查历史 <Hint>一格一次运行 · 点格子查看当次报告</Hint></H2>
      <RunStrip runs={runs} selId={String(current?.id ?? '')} onSel={setSelId} />

      {(data.collectionNotes ?? []).length > 0 ? (
        <div style={{ fontSize: 13.5, color: T.dim, border: `1px dashed ${T.line}`, borderRadius: 8, padding: '8px 14px', marginTop: 16 }}>
          📋 Collection Notes：{(data.collectionNotes ?? []).map((n: any, i: number) => <div key={i}>{String(n)}</div>)}
        </div>
      ) : null}
    </div>
  );
}

export function apply(_ctx: any): void {
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    const bridge = (window as any).__opendbHarness__;
    if (bridge?.registerTaskPanel !== undefined) { bridge.registerTaskPanel('sqlreview', SqlReviewPanel); clearInterval(timer); }
    else if (tries > 40) clearInterval(timer);
  }, 250);
}
