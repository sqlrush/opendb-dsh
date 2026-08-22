/**
 * task-wdr client 面板（R4 原型③ 形态）：快照时间轴+窗口高亮 → AWS-PI 式 DB Time 堆叠条 →
 * Load Profile delta 表 → Top SQL 归因表（attr 徽章）→ 等待事件 → findings → 原生留底说明。
 * 只读展示；换窗口在会话里说（时间轴只做可见，不做拖拽——设计裁决）。
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
const card: any = { background: '#fff', border: `1px solid ${T.line}`, borderRadius: 8, padding: '16px 20px', boxShadow: '0 4px 12px rgba(0,0,0,.02),0 2px 8px rgba(0,0,0,.04)' };
const mono = '"JetBrains Mono","SF Mono",Menlo,monospace';
const CLASS_COLORS: Record<string, string> = { CPU: '#4658c9', IO: '#1d9d86', 网络: '#7a5af8', '解析/计划': '#5b8def', '其他/等待': '#9aa3b5' };
const ATTR_BADGE: Record<string, { t: string; c: string; bg: string }> = {
  cpu: { t: 'CPU 型', c: '#4658c9', bg: '#e8edff' },
  io: { t: 'IO 型', c: '#1d7d6d', bg: '#e5f4f1' },
  tmp: { t: 'temp 溢出型', c: '#e07a1f', bg: '#fdf0e3' },
  blk: { t: '等待/锁型', c: '#d64545', bg: '#fdecec' },
  other: { t: '混合', c: '#81858c', bg: '#f7f8fa' },
};

function H2({ children }: { children: any }) {
  return <div style={{ fontSize: 18, fontWeight: 600, margin: '30px 0 14px', color: T.ink }}>{children}</div>;
}
function Dot({ level }: { level: string }) {
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: sev(level).c, marginRight: 6 }} />;
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

/** DB Time 构成环图（与堆叠条同数据双视角，中心=平均活跃会话） */
function ClassDonut({ dbTime }: { dbTime: any }) {
  const classes = ((dbTime?.classes ?? []) as any[]).filter((c) => Number(c.share) > 0);
  if (classes.length === 0) return null;
  const R = 36; const C = 2 * Math.PI * R;
  let off = 0;
  return (
    <svg width={96} height={96} viewBox="0 0 96 96">
      <g transform="rotate(-90 48 48)">
        <circle cx={48} cy={48} r={R} fill="none" stroke="#f2f3f5" strokeWidth={13} />
        {classes.map((c: any, i: number) => {
          const len = Number(c.share) * C;
          const el = <circle key={i} cx={48} cy={48} r={R} fill="none" stroke={CLASS_COLORS[String(c.name)] ?? '#9aa3b5'} strokeWidth={13} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off} />;
          off += len;
          return el;
        })}
      </g>
      <text x={48} y={45} textAnchor="middle" fontSize={14} fontWeight={600} fill={T.ink}>{Number(dbTime?.avgActive ?? 0)}</text>
      <text x={48} y={60} textAnchor="middle" fontSize={8.5} fill={T.dim}>平均活跃会话</text>
    </svg>
  );
}

/** 检查历史趋势条：点格子切历史报告 */
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
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: T.dim, marginTop: 6 }}>
        <span>{String(cells[0]?.firedAt ?? '').slice(5, 10)}</span>
        <span>最新 ▲ · 点格子查看当次完整报告</span>
      </div>
    </div>
  );
}

function Timeline({ snaps }: { snaps: any[] }) {
  if (snaps.length === 0) return null;
  const w = 680; const pad = 14;
  const step = snaps.length > 1 ? (w - pad * 2) / (snaps.length - 1) : 0;
  const inWin = snaps.map((s, i) => ({ ...s, x: pad + i * step })).filter((s) => s.inWindow === true);
  const x0 = inWin.length > 0 ? inWin[0].x : pad;
  const x1 = inWin.length > 0 ? inWin[inWin.length - 1].x : pad;
  const fmt = (ts: string) => String(ts).slice(11, 16);
  return (
    <div style={{ ...card, overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${w} 56`} width="100%" height="56">
        <line x1={pad} y1={26} x2={w - pad} y2={26} stroke="#dde0e4" strokeWidth={2} />
        {inWin.length > 0 ? <rect x={x0 - 5} y={14} width={Math.max(10, x1 - x0 + 10)} height={24} fill={T.blueSoft} stroke={T.blue} rx={6} opacity={0.85} /> : null}
        {snaps.map((s, i) => (
          <circle key={i} cx={pad + i * step} cy={26} r={4.5} fill="#fff" stroke={s.inWindow ? T.blue : '#9aa3b5'} strokeWidth={2.5} />
        ))}
        {snaps.length > 0 ? <text x={pad} y={52} fontSize={9.5} fill="#81858c">{fmt(snaps[0].ts)}</text> : null}
        {snaps.length > 1 ? <text x={w - pad} y={52} fontSize={9.5} fill="#81858c" textAnchor="end">{fmt(snaps[snaps.length - 1].ts)}</text> : null}
        {inWin.length > 0 ? <text x={(x0 + x1) / 2} y={10} fontSize={9.5} fill={T.blue} textAnchor="middle">分析窗口</text> : null}
      </svg>
      <div style={{ fontSize: 12, color: T.dim }}>快照每小时自动产生（enable_wdr_snapshot）· 换窗口在会话里说一句（"看下 14 点到 15 点"）</div>
    </div>
  );
}

function LoadStack({ dbTime }: { dbTime: any }) {
  const classes = (dbTime?.classes ?? []) as any[];
  const total = Number(dbTime?.totalUs ?? 0);
  if (total <= 0 || classes.length === 0) return <div style={{ fontSize: 13.5, color: T.dim }}>窗口内 DB Time 近零——数据库基本空闲。</div>;
  return (
    <div>
      <div style={{ fontSize: 13.5, color: T.sub, marginBottom: 8 }}>
        DB Time <b style={{ fontVariantNumeric: 'tabular-nums' }}>{Math.round(total / 1_000_000)}s</b> · 平均活跃会话 <b style={{ fontVariantNumeric: 'tabular-nums' }}>{Number(dbTime?.avgActive ?? 0)}</b>
      </div>
      <div style={{ display: 'flex', height: 26, borderRadius: 6, overflow: 'hidden', maxWidth: 680, border: `1px solid ${T.line}` }}>
        {classes.map((c: any, i: number) => (
          <i key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, color: '#fff', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', fontStyle: 'normal', width: `${Math.max(2, Number(c.share) * 100)}%`, background: CLASS_COLORS[String(c.name)] ?? '#9aa3b5' }}>
            {Number(c.share) >= 0.08 ? `${String(c.name)} ${(Number(c.share) * 100).toFixed(0)}%` : ''}
          </i>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 14, fontSize: 13, color: T.sub, marginTop: 6, flexWrap: 'wrap' }}>
        {classes.map((c: any, i: number) => (
          <span key={i}><i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 3, marginRight: 4, background: CLASS_COLORS[String(c.name)] ?? '#9aa3b5', fontStyle: 'normal' }} />{String(c.name)} {(Number(c.share) * 100).toFixed(0)}%</span>
        ))}
      </div>
    </div>
  );
}

export function WdrPanel({ task, call }: { task: any; call: (endpoint: string, payload?: unknown) => Promise<any> }) {
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
  if (data === undefined) return <div style={{ fontSize: 16, color: T.dim, padding: 16 }}>还没有 WDR 窗口报告——任务触发后报告会出现在这里。</div>;

  const worst = String(data.det?.worst ?? 'ok');
  const findings = ((data.findings ?? []) as any[]).slice().sort((a, b) => (ORDER[String(b.level)] ?? 0) - (ORDER[String(a.level)] ?? 0));
  const th: any = { color: T.dim, fontWeight: 500, fontSize: 13.5, textAlign: 'left', padding: '7px 10px', borderBottom: `1px solid ${T.line}`, whiteSpace: 'nowrap' };
  const td: any = { padding: '8px 10px', borderBottom: `1px solid ${T.line}`, verticalAlign: 'top', fontSize: 13.5 };
  const num = (v: any) => Number(v ?? 0).toLocaleString();

  return (
    <div style={{ fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif', color: T.ink, lineHeight: 1.75 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontSize: 18, fontWeight: 600, color: sev(worst).c }}>窗口态势：{sev(worst).cn}</span>
        <span style={{ fontSize: 13.5, color: T.sub }}>
          {String(data.node)} · snap {Number(data.window?.beginSnap)}→{Number(data.window?.endSnap)} · {String(data.window?.beginTs ?? '').slice(11, 16)}–{String(data.window?.endTs ?? '').slice(11, 16)}（{Number(data.window?.minutes)} 分钟）
        </span>
        <span style={{ display: 'inline-flex', gap: 6, fontSize: 13.5, background: T.sev.ok.soft, color: T.sev.ok.c, borderRadius: 6, padding: '3px 10px', fontWeight: 500 }}>✓ 已锚定 · 七维 delta 由脚本产出 · 归因不可改</span>
        <span style={{ fontSize: 13.5, color: T.dim }}>📄 只读展示 · 不动快照配置</span>
      </div>

      <Timeline snaps={(data.snapshots ?? []) as any[]} />

      <H2>窗口负载构成 <span style={{ fontSize: 13.5, color: T.dim, fontWeight: 400 }}>DB Time 按构成分解（AWS-PI 式，堆叠条 + 环图双视角）</span></H2>
      <div style={{ ...card, display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 320 }}><LoadStack dbTime={data.dbTime} /></div>
        <ClassDonut dbTime={data.dbTime} />
      </div>

      <H2>Top SQL 归因表 <span style={{ fontSize: 13.5, color: T.dim, fontWeight: 400 }}>归因纪律：tmp=下盘 · cpu=cpu 占比 · io=物理读占比 · blk=elapsed 高而 cpu≈0</span></H2>
      <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead><tr><th style={th}>sql</th><th style={th}>归因</th><th style={{ ...th, textAlign: 'right' }}>elapsed</th><th style={{ ...th, textAlign: 'right' }}>calls</th><th style={{ ...th, textAlign: 'right' }}>cpu%</th><th style={{ ...th, textAlign: 'right' }}>io%</th><th style={{ ...th, textAlign: 'right' }}>占比</th><th style={th}>解读</th></tr></thead>
          <tbody>
            {((data.topSql ?? []) as any[]).map((s: any, i: number) => {
              const b = ATTR_BADGE[String(s.attr)] ?? ATTR_BADGE.other;
              return (
                <tr key={i}>
                  <td style={{ ...td, fontFamily: mono }}>{String(s.sqlId)}<div style={{ color: T.dim, fontSize: 12, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(s.text)}</div></td>
                  <td style={td}><span style={{ fontSize: 12, fontWeight: 600, borderRadius: 5, padding: '1px 7px', whiteSpace: 'nowrap', color: b.c, background: b.bg }}>{b.t}</span></td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{num(s.elapsedMs)}ms</td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{num(s.calls)}</td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{num(s.cpuPct)}</td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{num(s.ioPct)}</td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{(Number(s.share ?? 0) * 100).toFixed(0)}%</td>
                  <td style={{ ...td, maxWidth: 280 }}>{String(s.note ?? '')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {((data.topSql ?? []) as any[]).some((s: any) => String(s.attr) === 'blk') ? (
        <div style={{ margin: '8px 0 0' }}>
          <DigLink text={`WDR 窗口里 ${((data.topSql ?? []) as any[]).filter((s: any) => String(s.attr) === 'blk').map((s: any) => `sql ${String(s.sqlId)}`).join('、')} 是等待/锁型（elapsed 高而 cpu≈0）——帮我从健康检查的锁链视角查根因持锁者`} />
        </div>
      ) : null}

      {(data.loadProfile ?? []).length > 0 ? (
        <>
          <H2>Load Profile <span style={{ fontSize: 13.5, color: T.dim, fontWeight: 400 }}>窗口 delta（µs）</span></H2>
          <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr><th style={th}>指标</th><th style={{ ...th, textAlign: 'right' }}>Δ(µs)</th><th style={{ ...th, textAlign: 'right' }}>每秒</th></tr></thead>
              <tbody>
                {((data.loadProfile ?? []) as any[]).map((l: any, i: number) => (
                  <tr key={i}>
                    <td style={{ ...td, fontFamily: mono }}>{String(l.stat)}</td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{num(l.deltaUs)}</td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: T.dim }}>{Number(data.window?.minutes) > 0 ? Math.round(Number(l.deltaUs) / (Number(data.window.minutes) * 60)).toLocaleString() : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {(data.waits ?? []).length > 0 ? (
        <>
          <H2>等待事件 <span style={{ fontSize: 13.5, color: T.dim, fontWeight: 400 }}>窗口 delta · 已剔除空闲 STATUS 类</span></H2>
          <div style={card}>
            {((data.waits ?? []) as any[]).slice(0, 8).map((w: any, i: number) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 70px', gap: 10, alignItems: 'center', fontSize: 13.5, marginBottom: 5 }}>
                <span style={{ color: T.dim, fontFamily: mono }}>{String(w.type)}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ height: 12, borderRadius: 3, background: '#5b8def', width: `${Math.max(2, Number(w.share ?? 0) * 100)}%`, minWidth: 4 }} />
                  <span>{String(w.event)}</span>
                </div>
                <b style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{(Number(w.share ?? 0) * 100).toFixed(0)}%</b>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <H2>发现 <span style={{ fontSize: 13.5, color: T.dim, fontWeight: 400 }}>七维阈值判定 · 级别不可被解读下调</span></H2>
      {findings.filter((f) => String(f.level) !== 'ok').length === 0
        ? <div style={{ fontSize: 16, color: T.sev.ok.c }}>✓ 窗口内各维在阈值内。</div>
        : findings.map((f: any, i: number) => (
          <div key={i} style={{ ...card, borderLeft: `3px solid ${sev(String(f.level)).c}`, marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Dot level={String(f.level)} /><b style={{ fontSize: 16 }}>{String(f.detail)}</b>
              <span style={{ font: `600 11.5px ${mono}`, background: T.fill, border: `1px solid ${T.line}`, borderRadius: 5, padding: '1px 6px', color: T.sub }}>{String(f.code)}</span>
              {String(f.value ?? '') !== '' ? <span style={{ marginLeft: 'auto', fontSize: 12, color: T.dim }}>实测 <b style={{ color: sev(String(f.level)).c }}>{String(f.value)}</b> · 阈值 {String(f.threshold)}</span> : null}
            </div>
            {String(f.evidence ?? '') !== '' ? <div style={{ fontSize: 13, color: T.dim, marginTop: 4, fontFamily: mono }}>证据 {String(f.evidence)}</div> : null}
          </div>
        ))}

      {String(data.rootCause ?? '') !== '' ? (
        <>
          <H2>根因串联</H2>
          <div style={{ ...card, background: T.fill, border: 'none' }}><div style={{ fontSize: 16, color: T.sub }}>{String(data.rootCause)}</div></div>
        </>
      ) : null}

      {String(data.nativeReport ?? '') !== '' ? (
        <div style={{ display: 'flex', gap: 10, background: T.fill, borderRadius: 10, padding: '12px 16px', fontSize: 13.5, color: T.sub, marginTop: 16 }}>📄 {String(data.nativeReport)}</div>
      ) : null}
      {(data.collectionNotes ?? []).length > 0 ? (
        <div style={{ fontSize: 13.5, color: T.dim, border: `1px dashed ${T.line}`, borderRadius: 8, padding: '8px 14px', marginTop: 10 }}>
          📋 Collection Notes：{((data.collectionNotes ?? []) as any[]).map((n: any, i: number) => <div key={i}>{String(n)}</div>)}
        </div>
      ) : null}
      <H2>检查历史 <span style={{ fontSize: 13.5, color: T.dim, fontWeight: 400 }}>一格一次运行 · 点格子查看当次报告</span></H2>
      <RunStrip runs={runs} selId={String(current?.id ?? '')} onSel={setSelId} />
    </div>
  );
}

export function apply(_ctx: any): void {
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    const bridge = (window as any).__opendbHarness__;
    if (bridge?.registerTaskPanel !== undefined) { bridge.registerTaskPanel('wdr', WdrPanel); clearInterval(timer); }
    else if (tries > 40) clearInterval(timer);
  }, 250);
}
