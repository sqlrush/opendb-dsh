/**
 * task-ddl client 面板：变更历史时间轴（按日分组竖轴：时刻点+动作色+对象+用户徽章+SQL 折叠）
 * + 统计条 + 规范扫描表。dsh 原版视觉 token；只读展示。
 */
import { useEffect, useState } from 'react';

export const inject = ['slots'];

const T = {
  ink: '#0f1115', sub: '#61666b', dim: '#81858c', blue: '#4176e6',
  line: 'rgba(0,0,0,.08)', fill: '#f7f8fa', blueSoft: '#e4edfd',
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

const ACTION: Record<string, { cn: string; c: string; bg: string }> = {
  added: { cn: '新增', c: '#3fa552', bg: '#e8f5ec' },
  removed: { cn: '删除', c: '#d64545', bg: '#fdecec' },
  changed: { cn: '变更', c: '#e07a1f', bg: '#fdf0e3' },
  ddl: { cn: 'DDL', c: '#4176e6', bg: '#e4edfd' },
  baseline: { cn: '批量', c: '#81858c', bg: '#f7f8fa' },
};

function H2({ children }: { children: any }) {
  return <div style={{ fontSize: 14, fontWeight: 500, margin: '22px 0 10px', color: T.ink }}>{children}</div>;
}
function Dot({ level }: { level: string }) {
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: sev(level).c, marginRight: 6 }} />;
}

/** 北京时间显示（数据是 ISO/UTC） */
function localParts(isoTs: string): { day: string; hm: string } {
  const d = new Date(new Date(isoTs).getTime() + 8 * 3600 * 1000);
  const p = d.toISOString();
  return { day: p.slice(0, 10), hm: p.slice(11, 16) };
}

function TimelineEntryRow({ e }: { e: any }) {
  const [open, setOpen] = useState(false);
  const a = ACTION[String(e.action)] ?? ACTION.ddl;
  const { hm } = localParts(String(e.time));
  return (
    <div style={{ display: 'flex', gap: 12, padding: '7px 0', borderBottom: `1px solid ${T.line}`, alignItems: 'flex-start' }}>
      <span style={{ fontFamily: mono, fontSize: 12, color: T.dim, width: 42, flex: 'none', paddingTop: 2 }}>{hm}</span>
      <span style={{ width: 10, height: 10, borderRadius: 5, background: a.c, flex: 'none', marginTop: 5, boxShadow: `0 0 0 3px ${a.bg}` }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: a.c, background: a.bg, borderRadius: 5, padding: '1px 7px' }}>{a.cn}</span>
          {String(e.kind) !== 'bulk' && String(e.kind) !== '' ? <span style={{ fontSize: 11, color: T.dim }}>{String(e.kind)}</span> : null}
          <span style={{ fontFamily: mono, fontSize: 12.5, fontWeight: 600, wordBreak: 'break-all' }}>{String(e.object)}</span>
          {String(e.user ?? '') !== '' ? <span style={{ fontSize: 11, fontWeight: 600, color: '#0e3074', background: T.blueSoft, borderRadius: 999, padding: '1px 9px' }}>👤 {String(e.user)}</span> : null}
          {(e.sources ?? []).includes('audit') ? <span style={{ fontSize: 10.5, color: T.sev.ok.c }}>✓ 审计</span> : null}
        </div>
        {String(e.note ?? '') !== '' ? <div style={{ fontSize: 12, color: T.sub, marginTop: 3 }}>{String(e.note)}</div> : null}
        {String(e.sqlText ?? '') !== '' ? (
          <div style={{ fontSize: 11.5, color: T.dim, marginTop: 3, fontFamily: mono, cursor: 'pointer', wordBreak: 'break-all' }} onClick={() => setOpen(!open)}>
            {open || String(e.sqlText).length <= 90 ? String(e.sqlText) : `${String(e.sqlText).slice(0, 90)}…`}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Timeline({ entries }: { entries: any[] }) {
  const byDay = new Map<string, any[]>();
  for (const e of entries) {
    const { day } = localParts(String(e.time));
    byDay.set(day, [...(byDay.get(day) ?? []), e]);
  }
  const days = [...byDay.entries()];
  if (days.length === 0) return <div style={{ fontSize: 13, color: T.dim }}>窗口内没有任何数据字典变更。</div>;
  return (
    <div>
      {days.map(([day, list]) => (
        <div key={day} style={{ ...card, marginBottom: 12, paddingTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{day}</span>
            <span style={{ fontSize: 11, color: T.dim }}>{list.length} 条 · 北京时间</span>
          </div>
          {list.map((e: any, i: number) => <TimelineEntryRow key={i} e={e} />)}
        </div>
      ))}
    </div>
  );
}

function RunStrip({ runs, selId, onSel }: { runs: any[]; selId: string; onSel: (id: string) => void }) {
  const cells = runs.slice(0, 30).reverse();
  if (cells.length === 0) return null;
  return (
    <div style={card}>
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
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: T.dim, marginTop: 6 }}>
        <span>{String(cells[0]?.firedAt ?? '').slice(5, 10)}</span>
        <span>最新 ▲ · 点格子查看当次完整报告</span>
      </div>
    </div>
  );
}

export function DdlPanel({ task, call }: { task: any; call: (endpoint: string, payload?: unknown) => Promise<any> }) {
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
  if (error !== '') return <div style={{ fontSize: 13, color: T.dim, padding: 16 }}>加载失败：{error}</div>;
  if (data === undefined) return <div style={{ fontSize: 13, color: T.dim, padding: 16 }}>还没有 DDL 追溯报告——任务触发后报告会出现在这里；在会话里问"最近一周谁改过表"也能即席出缩减版。</div>;

  const worst = String(data.det?.worst ?? 'ok');
  const stats = data.stats ?? {};
  const rules = ((data.ruleFindings ?? []) as any[]).slice().sort((a, b) => (ORDER[String(b.level)] ?? 0) - (ORDER[String(a.level)] ?? 0));
  const th: any = { color: T.dim, fontWeight: 500, fontSize: 12, textAlign: 'left', padding: '7px 10px', borderBottom: `1px solid ${T.line}`, whiteSpace: 'nowrap' };
  const td: any = { padding: '8px 10px', borderBottom: `1px solid ${T.line}`, verticalAlign: 'top', fontSize: 12 };

  return (
    <div style={{ fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif', color: T.ink, lineHeight: 1.6 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontSize: 16, fontWeight: 600, color: sev(worst).c }}>变更态势：{sev(worst).cn}</span>
        <span style={{ fontSize: 12, color: T.sub }}>{String(data.node)} · 回溯 {Number(data.windowHours)} 小时</span>
        <span style={{ display: 'inline-flex', gap: 6, fontSize: 12, background: T.sev.ok.soft, color: T.sev.ok.c, borderRadius: 6, padding: '3px 10px', fontWeight: 500 }}>✓ 已锚定 · 时间轴与规则由脚本产出</span>
        {data.auditAvailable === true
          ? <span style={{ fontSize: 12, color: T.sev.ok.c }}>👤 审计归因已启用</span>
          : <span style={{ fontSize: 12, color: T.sev.notice.c }}>👤 用户归因不可用（见底部 Notes 解锁方法）</span>}
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {[
          { label: '变更总数', v: stats.total, c: T.ink },
          { label: '新增', v: stats.added, c: T.sev.ok.c },
          { label: '删除', v: stats.removed, c: T.sev.critical.c },
          { label: '结构变更', v: stats.changed, c: T.sev.warn.c },
          { label: '涉及用户', v: (stats.users ?? []).length > 0 ? (stats.users ?? []).join(', ') : '未归因', c: T.sub },
        ].map((it, i) => (
          <div key={i} style={{ ...card, flex: 1, minWidth: 110 }}>
            <b style={{ fontSize: 18, fontWeight: 600, color: it.c, fontVariantNumeric: 'tabular-nums', wordBreak: 'break-all' }}>{String(it.v ?? 0)}</b>
            <span style={{ display: 'block', fontSize: 12, color: T.dim, marginTop: 1 }}>{it.label}</span>
          </div>
        ))}
      </div>

      {rules.length > 0 ? (
        <>
          <H2>规范扫描 <span style={{ fontSize: 12, color: T.dim, fontWeight: 400 }}>确定性规则 · 级别不可被解读下调</span></H2>
          <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr><th style={th}>规则</th><th style={th}></th><th style={th}>对象</th><th style={th}>问题</th><th style={th}>建议</th></tr></thead>
              <tbody>
                {rules.map((f: any, i: number) => (
                  <tr key={i}>
                    <td style={td}><span style={{ font: `600 10.5px ${mono}`, background: T.fill, border: `1px solid ${T.line}`, borderRadius: 5, padding: '1px 6px', color: T.sub }}>{String(f.rule)}</span></td>
                    <td style={td}><Dot level={String(f.level)} /></td>
                    <td style={{ ...td, fontFamily: mono }}>{String(f.object).slice(0, 50)}</td>
                    <td style={td}>{String(f.problem)}</td>
                    <td style={td}>{String(f.advice ?? '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <H2>变更时间轴 <span style={{ fontSize: 12, color: T.dim, fontWeight: 400 }}>什么时间 · 由哪个用户 · 做过什么变更（按日分组，新→旧）</span></H2>
      <Timeline entries={(data.timeline ?? []) as any[]} />

      {String(data.rootCause ?? '') !== '' ? (
        <>
          <H2>变更故事线</H2>
          <div style={{ ...card, background: T.fill, border: 'none' }}><div style={{ fontSize: 13, color: T.sub }}>{String(data.rootCause)}</div></div>
        </>
      ) : null}
      {(data.priorities ?? []).length > 0 ? (
        <>
          <H2>处置优先级</H2>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {((data.priorities ?? []) as any[]).map((p: any, i: number) => (
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
          📋 Collection Notes：{((data.collectionNotes ?? []) as any[]).map((n: any, i: number) => <div key={i}>{String(n)}</div>)}
        </div>
      ) : null}
      <H2>检查历史 <span style={{ fontSize: 12, color: T.dim, fontWeight: 400 }}>一格一次运行 · 点格子查看当次报告</span></H2>
      <RunStrip runs={runs} selId={String(current?.id ?? '')} onSel={setSelId} />
    </div>
  );
}

export function apply(_ctx: any): void {
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    const bridge = (window as any).__opendbHarness__;
    if (bridge?.registerTaskPanel !== undefined) { bridge.registerTaskPanel('ddl', DdlPanel); clearInterval(timer); }
    else if (tries > 40) clearInterval(timer);
  }, 250);
}
