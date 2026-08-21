/**
 * task-sqlreview client 面板（R4 原型② 形态）：分级计数 → 规则审核表 → SQL 组概览 →
 * 逐条卡片（原 SQL → 原计划[脚本标注优化点] → 优化 SQL → cost 对比 → 验证徽章）。
 * 只读展示，无操作按钮；视觉 token = dsh 原版基准。
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
const card: any = { background: '#fff', border: `1px solid ${T.line}`, borderRadius: 8, padding: '13px 16px', boxShadow: '0 4px 12px rgba(0,0,0,.02),0 2px 8px rgba(0,0,0,.04)' };
const mono = '"JetBrains Mono","SF Mono",Menlo,monospace';
const sqlBlock: any = { background: T.fill, borderRadius: 10, padding: '12px 14px', font: `12px/1.7 ${mono}`, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: T.ink, overflowX: 'auto' };

const VERIFY_BADGE: Record<string, { t: string; c: string; bg: string }> = {
  'explain-verified': { t: '✓ EXPLAIN 实证', c: '#3fa552', bg: '#e8f5ec' },
  estimated: { t: '预估 · 未实证（无 hypopg）', c: '#c9862d', bg: '#faf3e5' },
  'no-gain': { t: '无低风险优化空间', c: '#81858c', bg: '#f7f8fa' },
  'plan-unavailable': { t: '计划不可得', c: '#81858c', bg: '#f7f8fa' },
};

function H2({ children }: { children: any }) {
  return <div style={{ fontSize: 14, fontWeight: 500, margin: '22px 0 10px', color: T.ink }}>{children}</div>;
}

function Dot({ level }: { level: string }) {
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: sev(level).c, marginRight: 6 }} />;
}

function StatRow({ counts }: { counts: any }) {
  const items = [
    { k: 'critical', label: '严重违规' }, { k: 'warn', label: '告警违规' }, { k: 'notice', label: '建议项' },
  ];
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      {items.map((it) => (
        <div key={it.k} style={{ ...card, flex: 1, minWidth: 110 }}>
          <b style={{ fontSize: 22, fontWeight: 600, color: sev(it.k).c, fontVariantNumeric: 'tabular-nums' }}>{Number(counts?.[it.k] ?? 0)}</b>
          <span style={{ display: 'block', fontSize: 12, color: T.dim, marginTop: 1 }}><Dot level={it.k} />{it.label}</span>
        </div>
      ))}
    </div>
  );
}

function RuleTable({ findings }: { findings: any[] }) {
  const [showAll, setShowAll] = useState(false);
  const sorted = [...findings].sort((a, b) => (ORDER[b.level] ?? 0) - (ORDER[a.level] ?? 0));
  const shown = showAll ? sorted : sorted.slice(0, 6);
  const th: any = { color: T.dim, fontWeight: 500, fontSize: 12, textAlign: 'left', padding: '7px 10px', borderBottom: `1px solid ${T.line}`, whiteSpace: 'nowrap' };
  const td: any = { padding: '8px 10px', borderBottom: `1px solid ${T.line}`, verticalAlign: 'top', fontSize: 12 };
  return (
    <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead><tr><th style={th}>规则</th><th style={th}></th><th style={th}>对象</th><th style={th}>问题</th><th style={th}>整改建议</th></tr></thead>
        <tbody>
          {shown.map((f, i) => (
            <tr key={i}>
              <td style={td}><span style={{ font: `600 10.5px ${mono}`, background: T.fill, border: `1px solid ${T.line}`, borderRadius: 5, padding: '1px 6px', color: T.sub }}>{String(f.rule)}</span></td>
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
        <span style={{ fontSize: 13, color: T.blue, cursor: 'pointer', padding: '9px 16px', display: 'inline-block' }} onClick={() => setShowAll(!showAll)}>
          {showAll ? '收起 ▴' : `展开全部 ${sorted.length} 条 ▾`}
        </span>
      ) : null}
    </div>
  );
}

function CostBars({ orig, next }: { orig: number; next: number }) {
  const max = Math.max(orig, next, 1);
  const row = (label: string, v: number, color: string, txt: string) => (
    <div style={{ display: 'grid', gridTemplateColumns: '56px 1fr 120px', gap: 10, alignItems: 'center', fontSize: 12 }}>
      <span style={{ color: T.dim }}>{label}</span>
      <div style={{ height: 14, borderRadius: 4, background: color, width: `${Math.max(3, (v / max) * 100)}%`, minWidth: 20 }} />
      <b style={{ color, fontVariantNumeric: 'tabular-nums' }}>{txt}</b>
    </div>
  );
  const drop = orig > 0 ? Math.round((1 - next / orig) * 1000) / 10 : 0;
  return (
    <div style={{ display: 'grid', gap: 6, margin: '8px 0', maxWidth: 520 }}>
      {row('原计划', orig, '#e9b8b8', `cost ${orig.toLocaleString()}`)}
      {row('优化后', next, T.sev.ok.c, `${next.toLocaleString()} ↓${drop}%`)}
    </div>
  );
}

function SqlCard({ s }: { s: any }) {
  const [open, setOpen] = useState(false);
  const badge = VERIFY_BADGE[String(s.verify)] ?? VERIFY_BADGE['plan-unavailable'];
  const orig = Number(s.origCost || 0);
  const next = Number(s.newCost || 0);
  return (
    <div style={{ ...card, marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ fontFamily: mono, fontSize: 12.5 }}>sql {String(s.key)}</b>
        {Number(s.avgMs ?? 0) > 0 ? <span style={{ fontSize: 12, color: T.dim }}>均耗时 {Number(s.avgMs).toLocaleString()}ms · calls {Number(s.calls).toLocaleString()}</span> : null}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 5, fontSize: 12, fontWeight: 600, color: badge.c, background: badge.bg, borderRadius: 6, padding: '2px 10px' }}>{badge.t}</span>
      </div>
      <div style={{ fontSize: 12, color: T.dim, margin: '10px 0 4px', fontWeight: 500 }}>原 SQL</div>
      <div style={sqlBlock}>{String(s.text)}</div>
      {(s.planNotes ?? []).length > 0 ? (
        <>
          <div style={{ fontSize: 12, color: T.dim, margin: '10px 0 4px', fontWeight: 500 }}>原执行计划优化点（脚本标注） {orig > 0 ? <span style={{ fontWeight: 400 }}>· 总 cost {orig.toLocaleString()}</span> : null}</div>
          {(s.planNotes ?? []).map((n: any, i: number) => (
            <div key={i} style={{ fontSize: 12, color: T.sev.warn.c, background: T.sev.warn.soft, borderRadius: 6, padding: '4px 10px', marginBottom: 4, fontFamily: mono }}>⚠ {String(n)}</div>
          ))}
        </>
      ) : null}
      {String(s.optimizedSql ?? '') !== '' ? (
        <>
          <div style={{ fontSize: 12, color: T.dim, margin: '10px 0 4px', fontWeight: 500 }}>优化方案</div>
          <div style={{ ...sqlBlock, background: T.sev.ok.soft }}>{String(s.optimizedSql)}</div>
          {String(s.verify) === 'explain-verified' && orig > 0 && next > 0 ? <CostBars orig={orig} next={next} /> : null}
        </>
      ) : null}
      {String(s.detail ?? '') !== '' ? (
        <div style={{ fontSize: 12.5, color: T.sub, marginTop: 8, cursor: 'pointer' }} onClick={() => setOpen(!open)}>
          {open || String(s.detail).length <= 160 ? String(s.detail) : `${String(s.detail).slice(0, 160)}…（点开全文）`}
        </div>
      ) : null}
    </div>
  );
}

export function SqlReviewPanel({ task, call }: { task: any; call: (endpoint: string, payload?: unknown) => Promise<any> }) {
  const [runs, setRuns] = useState<any[]>([]);
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

  const latest = runs.find((r) => r.report !== undefined);
  const data = latest?.report?.data;
  if (error !== '') return <div style={{ fontSize: 13, color: T.dim, padding: 16 }}>加载失败：{error}</div>;
  if (data === undefined) return <div style={{ fontSize: 13, color: T.dim, padding: 16 }}>还没有 SQL 审核报告——任务触发后（cron 或在会话里说一声）报告会出现在这里。</div>;

  const worst = String(data.det?.worst ?? 'ok');
  const items = (data.sqlItems ?? []) as any[];
  const chip = (s: any) => {
    const b = VERIFY_BADGE[String(s.verify)] ?? VERIFY_BADGE['plan-unavailable'];
    const drop = String(s.costDropPct ?? '');
    return (
      <span key={String(s.key)} style={{ display: 'inline-flex', gap: 5, fontSize: 12, fontWeight: 600, color: b.c, background: b.bg, borderRadius: 6, padding: '2px 10px' }}>
        {String(s.key)}{String(s.verify) === 'explain-verified' && drop !== '' ? ` ✓ ↓${drop}%` : ` · ${b.t}`}
      </span>
    );
  };

  return (
    <div style={{ fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif', color: T.ink, lineHeight: 1.6 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontSize: 16, fontWeight: 600, color: sev(worst).c }}>总体：{sev(worst).cn}</span>
        <span style={{ display: 'inline-flex', gap: 6, fontSize: 12, background: T.sev.ok.soft, color: T.sev.ok.c, borderRadius: 6, padding: '3px 10px', fontWeight: 500 }}>✓ 已锚定 · 规则判定由脚本产出 · 改写经 EXPLAIN 实证</span>
        <span style={{ fontSize: 12, color: T.dim }}>📄 报告已自动入库归档 · 只读展示</span>
      </div>
      <StatRow counts={data.det?.counts} />

      <H2>规范审核 <span style={{ fontSize: 12, color: T.dim, fontWeight: 400 }}>确定性规则 · 级别不可被解读下调</span></H2>
      <RuleTable findings={data.ruleFindings ?? []} />

      <H2>SQL 优化 <span style={{ fontSize: 12, color: T.dim, fontWeight: 400 }}>本组 {items.length} 条 · 原计划标注 → 优化 → cost 对比</span></H2>
      <div style={{ ...card, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 12, color: T.dim }}>本组 {items.length} 条：</span>
        {items.map(chip)}
      </div>
      {items.map((s) => <SqlCard key={String(s.key)} s={s} />)}

      {String(data.rootCause ?? '') !== '' ? (
        <>
          <H2>根因串联</H2>
          <div style={{ ...card, background: T.fill, border: 'none' }}><div style={{ fontSize: 13, color: T.sub }}>{String(data.rootCause)}</div></div>
        </>
      ) : null}
      {(data.priorities ?? []).length > 0 ? (
        <>
          <H2>处置优先级</H2>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {(data.priorities ?? []).map((p: any, i: number) => (
              <div key={i} style={{ ...card, flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: T.sub, letterSpacing: '.05em' }}>{String(p.p)}</div>
                <div style={{ fontSize: 13, marginTop: 4 }}>{String(p.action)}</div>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {(data.collectionNotes ?? []).length > 0 ? (
        <div style={{ fontSize: 12, color: T.dim, border: `1px dashed ${T.line}`, borderRadius: 8, padding: '8px 14px', marginTop: 16 }}>
          📋 Collection Notes：{(data.collectionNotes ?? []).map((n: any, i: number) => <div key={i}>{String(n)}</div>)}
        </div>
      ) : null}
      <div style={{ fontSize: 12, color: T.dim, marginTop: 16 }}>
        近 {runs.length} 次运行：{runs.slice(0, 10).map((r: any, i: number) => (
          <span key={i} style={{ marginRight: 8 }}>
            <Dot level={r.report?.data?.det?.worst ?? (r.status === 'succeeded' ? 'ok' : 'notice')} />
            {String(r.firedAt ?? '').slice(5, 16).replace('T', ' ')}
          </span>
        ))}
      </div>
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
