/**
 * task-capacity client 面板（R1，2026-08-31 user 通过 docs/prototypes/capacity-r1.html）：
 * 状态带 + 摘要 8 卡 → 增长趋势（chart-kit Line：无采集灰带 / 字典建删批次标线 / 外推虚线，范围可切）→ 容量构成（数据目录 vs 库内，点行筛选）
 * → Top 对象（增量、死元组、vacuum/analyze、深挖）→ 非表占用与保留策略（WAL / statement_history / pg_log / WDR）→ Vacuum 与统计信息
 * → CAP_* 发现（深挖）→ 解读与处置优先级（模型）→ 检查历史。数字全部来自采集存档 run.collect；模型只贡献解读。
 */
import { Component, useEffect, useMemo, useState } from 'react';
import { Line, StackedBar } from '@opendb-dsh/chart-kit';
import { T, sev, mono, FONT, tnum, card, keyChip, PALETTE, GIB, fmtBytes, fmtGbPerDay, fmtPct, fmtInt, mmdd, mmddhhmm, whenOrNever } from './format.ts';

export const inject = ['slots', 'connection', 'workspaces', 'sessions'];

const H = 3600_000; const DAY = 24 * H;

// ───────────────────────────────────────────── 小件
function H2({ children, hint, tight }: { children: any; hint?: string; tight?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: tight ? '0 0 10px' : '28px 0 12px', flexWrap: 'wrap' }}>
      <span style={{ fontSize: tight ? 16 : 18, fontWeight: 600, color: T.ink }}>{children}</span>
      {hint !== undefined ? <span style={{ fontSize: 13.5, color: T.dim }}>{hint}</span> : null}
    </div>
  );
}
function Chip({ level, children, small }: { level: string; children: any; small?: boolean }) {
  const s = sev(level);
  return <span style={{ display: 'inline-flex', gap: 5, fontSize: small ? 12 : 13.5, fontWeight: 500, color: s.c, background: s.soft, borderRadius: 6, padding: small ? '0 8px' : '2px 10px', whiteSpace: 'nowrap' }}>{children}</span>;
}
function Grey({ children }: { children: any }) { return <span style={{ display: 'inline-flex', fontSize: 12, color: T.sub, background: T.fill2, borderRadius: 6, padding: '0 8px', whiteSpace: 'nowrap' }}>{children}</span>; }
function Link({ onClick, children, busy, fail, title }: { onClick: () => void; children: any; busy?: boolean; fail?: boolean; title?: string }) {
  return <button type="button" onClick={onClick} disabled={busy} title={title} style={{ font: 'inherit', fontSize: 12.5, color: fail ? T.sev.critical.c : T.blue, background: 'none', border: 'none', padding: 0, cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}>{children}</button>;
}
let clientCtx: any;
async function digInSession(text: string): Promise<string> {
  if (clientCtx === undefined) throw new Error('客户端上下文未就绪');
  const ws = clientCtx.workspaces?.list?.getSnapshot?.()?.items?.[0];
  const sessionId: string = await clientCtx.sessions.create(ws?.workspaceId !== undefined ? { workspaceId: ws.workspaceId } : {});
  const bridge = (window as any).__opendbHarness__;
  if (typeof bridge?.openSession === 'function') bridge.openSession(sessionId); else clientCtx.sessions.open(sessionId);
  const r = await clientCtx.connection.rpc.call('/api', 'session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  if (r?.ok === false) throw new Error(String(r.error?.message ?? 'prompt rejected'));
  return sessionId;
}
function DigLink({ prompt, label }: { prompt: string; label: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'fail'>('idle');
  return <Link busy={state === 'busy'} fail={state === 'fail'} title="直接新建会话并把本条数据作为背景发出" onClick={() => { setState('busy'); digInSession(prompt).then(() => setState('idle')).catch(() => setState('fail')); }}>{state === 'busy' ? '开会话中…' : state === 'fail' ? '失败，重试' : `${label} →`}</Link>;
}
class Boundary extends Component<{ children: any }, { err?: string }> {
  state: { err?: string } = {};
  static getDerivedStateFromError(e: unknown) { return { err: String((e as Error)?.message ?? e) }; }
  render() { return this.state.err !== undefined ? <div style={{ fontSize: 14, color: T.sev.critical.c, padding: 12 }}>容量面板渲染失败：{this.state.err}</div> : this.props.children; }
}
const DIG_TAIL = '任务：先用工具取证（capacity_collect 同一节点、db_describe 看对象、db_query 只读核对 pg_stat_user_tables / pg_settings），再给出：1) 空间花在哪、为什么 2) 是否需要 ANALYZE / VACUUM / 调参数（平台只读，动作由 DBA 执行）3) 归档或保留策略建议。数字必须引用工具输出。';

// ───────────────────────────────────────────── 摘要卡
function Stats({ c }: { c: any }) {
  const s = c.summary ?? {}; const g = s.growth ?? {}; const disk = s.disk;
  const notice = T.sev.notice.c; const warn = T.sev.warn.c;
  const cells: { l: string; v: any; unit?: string; d: string; color?: string; dColor?: string }[] = [
    disk !== undefined ? { l: '磁盘（数据目录所在卷）', v: fmtBytes(disk.availBytes), unit: '可用', d: `已用 ${fmtPct(disk.usedBytes / disk.totalBytes)} · 总量 ${fmtBytes(disk.totalBytes)}`, color: disk.usedBytes / disk.totalBytes >= 0.9 ? warn : disk.usedBytes / disk.totalBytes >= 0.8 ? notice : undefined }
      : { l: '磁盘（数据目录所在卷）', v: '—', d: '主机侧未接入：openGauss 视图不暴露卷容量，满盘估算只给增速' },
    s.dataDirSource === 'db-only'
      ? { l: '数据目录', v: '—', d: `文件级需初始账号（omm）才能读；所有库合计 ${fmtBytes(s.dbBytesAll)}，WAL / 日志 / 审计 / core 未计入` }
      : { l: `数据目录${s.dataDirSource === 'estimate' ? '（估算）' : ''}`, v: fmtBytes(s.dataDirBytes), d: s.dataDirSource === 'estimate' ? '库 + WAL + 日志 + 审计 + core' : '容器内 du' },
    { l: `数据库 ${String(c.db ?? '')}`, v: fmtBytes(s.dbBytes), d: s.delta24 !== undefined && c.history?.points?.length > 1 ? dbChangeLine(c) : '所有库合计 ' + fmtBytes(s.dbBytesAll), dColor: dbChangeColor(c) },
    { l: `增速（观测窗 ${Number(g.windowHours ?? 0)} h 线性回归）`, v: g.points >= 2 ? fmtGbPerDay(Number(g.bytesPerDay ?? 0)) : '—', d: s.daysToFull !== undefined ? `满盘估计 ${s.daysToFull} 天` : g.points >= 2 ? `满盘估计 — · ${disk === undefined ? '无磁盘数据' : '增速低于 0.1 GB/天'}不外推` : '首次采样，下次起可得' },
    { l: s.filesAvailable === false ? '非表占用（不含 WAL / 日志）' : '非表占用', v: fmtBytes(s.nonTableBytes), unit: fmtPct(s.nonTableShare ?? 0), d: nonTableLine(c), color: s.nonTableShare >= 0.5 ? warn : s.nonTableShare >= 0.3 ? notice : undefined },
    { l: '膨胀待办', v: `${Number(s.bloatTodo ?? 0)} 张`, d: bloatLine(c), color: Number(s.bloatTodo ?? 0) > 0 ? warn : undefined },
    { l: '统计信息从未收集', v: `${Number(s.statsNeverCount ?? 0)} 张`, d: statsNeverLine(c), color: Number(s.statsNeverCount ?? 0) > 0 ? warn : undefined },
    { l: '采集覆盖', v: g.points >= 2 ? `${Number(g.windowHours ?? 0)} h` : '首采', unit: g.points >= 2 ? `/ ${Number(c.growthWindowDays ?? 7)} 天` : undefined, d: Number(s.gapHours ?? 0) > 24 ? `空窗 ${Number(s.gapHours)} h（上次采样 ${mmddhhmm(String(s.lastSampleAt ?? ''))}）` : s.firstRun ? '对象级增量自下次起可得' : `最近间隔 ${Number(s.gapHours ?? 0)} h · 样本 ${Number(g.points ?? 0)}`, color: Number(s.gapHours ?? 0) > 24 ? notice : undefined },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10 }}>
      {cells.map((x) => (
        <div key={x.l} style={{ background: T.fill, borderRadius: 8, padding: '11px 14px', minWidth: 0 }}>
          <div style={{ fontSize: 12.5, color: T.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.l}</div>
          <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.3, marginTop: 2, color: x.color, whiteSpace: 'nowrap', ...tnum }}>{String(x.v)}{x.unit !== undefined ? <span style={{ fontSize: 13, fontWeight: 500, color: T.dim, marginLeft: 4 }}>{x.unit}</span> : null}</div>
          <div style={{ fontSize: 12.5, color: x.dColor ?? T.dim, lineHeight: 1.45 }}>{x.d}</div>
        </div>
      ))}
    </div>
  );
}
/** 24h 变化：取 ≥20h 前最近一点与当前比 */
function dbChange(c: any): { bytes: number; hours: number } | undefined {
  const pts: { t: number; bytes: number }[] = c.history?.points ?? [];
  if (pts.length < 2) return undefined;
  const now = pts[pts.length - 1]; const ref = pts.slice(0, -1).reverse().find((p) => now.t - p.t >= 20 * H) ?? pts[0];
  return { bytes: now.bytes - ref.bytes, hours: Math.round((now.t - ref.t) / H) };
}
const dbChangeLine = (c: any): string => { const d = dbChange(c); return d === undefined ? '' : `${d.bytes >= 0 ? '▲' : '▼'} ${fmtBytes(Math.abs(d.bytes))} / ${d.hours >= 48 ? `${Math.round(d.hours / 24)} 天` : `${d.hours}h`}`; };
const dbChangeColor = (c: any): string | undefined => { const d = dbChange(c); return d === undefined ? undefined : d.bytes < -GIB ? T.sev.ok.c : d.bytes > GIB ? T.sev.warn.c : undefined; };
const nonTableLine = (c: any): string => { const s = c.sys ?? {}; return [s.wal?.available ? `WAL ${fmtBytes(s.wal.bytes)}` : '', s.stmt?.available ? `SQL 追踪 ${fmtBytes(s.stmt.bytes)}` : '', s.wdr?.enabled ? `WDR ${fmtBytes(s.wdr.bytes)}` : '', s.log?.available ? `日志/审计 ${fmtBytes((s.log?.bytes ?? 0) + (s.audit?.bytes ?? 0))}` : '', s.wal?.available ? '' : `WAL 上限 ≤ ${fmtBytes(s.wal?.capBytes ?? 0)}（按参数估）`].filter((x) => x !== '').join(' · '); };
const bloatLine = (c: any): string => { const f = (c.findings ?? []).find((x: any) => x.rule === 'CAP_STMT_HISTORY_BLOAT'); return f !== undefined && f.level !== 'ok' ? String(f.problem).split('——')[0] : (c.sys?.stmt?.available ? `statement_history ${fmtBytes(c.sys.stmt.bytes)} / ${fmtInt(c.sys.stmt.rows)} 行` : '无可评估系统表'); };
const statsNeverLine = (c: any): string => { const by = c.statsNever?.bySchema ?? {}; const top = Object.entries(by).sort((a: any, b: any) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ${v}`).join(' · '); return top !== '' ? `${top} · 最大 ${fmtInt(c.statsNever?.maxRows ?? 0)} 行` : `reltuples ≥ 100 万且从未 analyze 的表`; };

// ───────────────────────────────────────────── 趋势
function Trend({ c }: { c: any }) {
  const [range, setRange] = useState<number>(7);
  const pts: { t: number; bytes: number }[] = c.history?.points ?? [];
  const now = Date.parse(String(c.collectedAt)) || Date.now();
  const inRange = pts.filter((p) => p.t >= now - range * DAY);
  const use = inRange.length >= 1 ? inRange : pts;
  const g = c.summary?.growth ?? {}; const s = c.summary ?? {};
  const first = use[0]?.t ?? now - range * DAY;
  const bands = [
    ...(first > now - range * DAY + H ? [{ from: now - range * DAY, to: first, label: `无采集 ${mmddhhmm(now - range * DAY)} → ${mmddhhmm(first)}：容量任务尚未创建` }] : []),
    ...((c.history?.gaps ?? []) as any[]).map((gp) => ({ from: Number(gp.from), to: Number(gp.to), label: `无采集 ${Math.round((Number(gp.to) - Number(gp.from)) / H)} h：${mmddhhmm(Number(gp.from))} → ${mmddhhmm(Number(gp.to))}` })),
  ];
  const markers = ((c.history?.events ?? []) as any[]).map((e) => ({ t: Number(e.t), label: `${mmddhhmm(Number(e.t))} ${String(e.label)}`, level: (String(e.kind) === 'removed' ? 'critical' : 'ok') as any }));
  const last = use[use.length - 1];
  const forecast = last !== undefined && use.length >= 2 ? [{ name: '外推', points: [[last.t, last.bytes], [now + range * DAY * 0.12, last.bytes + Number(g.bytesPerDay ?? 0) * (range * 0.12)]] as [number, number][], color: PALETTE[0], dashed: true }] : [];
  const series = [{ name: `数据库 ${String(c.db ?? '')}（pg_database_size）`, points: use.map((p) => [p.t, p.bytes] as [number, number]), color: PALETTE[0], showPoints: use.length <= 3 }, ...forecast];
  const dc = dbChange(c);
  return (
    <div style={card}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 280px', gap: 20 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: T.dim, marginBottom: 8, flexWrap: 'wrap' }}>
            范围 {[7, 30, 90].map((r) => <span key={r} onClick={() => setRange(r)} style={{ border: `1px solid ${range === r ? T.blue : T.line}`, borderRadius: 8, padding: '2px 10px', color: range === r ? '#fff' : T.sub, background: range === r ? T.blue : '#fff', cursor: 'pointer' }}>{r} 天</span>)}
            <span style={{ marginLeft: 8 }}>{use.length} 个样本{String(c.history?.source ?? '') === 'health-backfill' ? ' · 首次运行，历史来自健康采集存档回填' : ''}</span>
          </div>
          <Line series={series} unit="bytes" height={230} bands={bands} markers={markers} breakGapMs={24 * H} yMin={0} xMin={now - range * DAY} xMax={now + range * DAY * 0.12} />
          <div style={{ display: 'flex', gap: 16, fontSize: 12.5, color: T.sub, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: '#e6e9ee', marginRight: 5, verticalAlign: 'middle' }} />无采集</span>
            <span><i style={{ display: 'inline-block', width: 14, borderTop: `2px dashed ${PALETTE[0]}`, marginRight: 5, verticalAlign: 'middle' }} />外推</span>
            <span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: T.sev.critical.c, marginRight: 5, verticalAlign: 'middle' }} />删除批次</span>
            <span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: T.sev.ok.c, marginRight: 5, verticalAlign: 'middle' }} />新建批次</span>
            <span style={{ color: T.dim }}>悬停看数值 · 事件来自平台字典的建/删批次</span>
          </div>
        </div>
        <div style={{ borderLeft: `1px solid ${T.line}`, paddingLeft: 20, fontSize: 13.5 }}>
          <Side t={g.segment === 'pre-reset' ? '观测窗（清理前段）' : '观测窗'} v={g.points >= 2 ? `${Number(g.windowHours ?? 0)} h` : '—'} d={g.points >= 2 && use.length >= 2 ? (g.segment === 'pre-reset' ? `${mmddhhmm(use[0].t)} → ${mmddhhmm(Number(g.resetAt))}` : `${mmddhhmm(g.resetAt !== undefined ? Number(g.resetAt) : use[0].t)} → ${mmddhhmm(now)}`) : '首次采样'} />
          <Side t="窗内净增" v={g.points >= 2 ? `${Number(g.netBytes) >= 0 ? '+' : '−'}${fmtBytes(Math.abs(Number(g.netBytes ?? 0)))}` : '—'} d={g.points >= 2 ? `≈ ${fmtGbPerDay(Number(g.bytesPerDay ?? 0))}` : ''} />
          <Side t="24 h 变化" v={dc !== undefined ? `${dc.bytes >= 0 ? '+' : '−'}${fmtBytes(Math.abs(dc.bytes))}` : '—'} d={dc !== undefined ? `较 ${dc.hours} h 前` : '需要两次采样'} color={dc !== undefined && dc.bytes < -GIB ? T.sev.ok.c : undefined} />
          <Side t="磁盘可用" v={s.disk !== undefined ? fmtBytes(s.disk.availBytes) : '—'} d={s.disk !== undefined ? `${fmtPct(s.disk.usedBytes / s.disk.totalBytes)} 已用` : '主机侧未接入'} />
          <Side t="满盘估计" v={s.daysToFull !== undefined ? `${s.daysToFull} 天` : '—'} d={s.daysToFull !== undefined ? '磁盘可用 ÷ 增速' : s.disk === undefined ? '无磁盘数据不外推' : '增速低于 0.1 GB/天不外推'} />
          <div style={{ fontSize: 13, color: T.dim, margin: '8px 0 2px' }}>置信度</div>
          <div><Chip level={g.confidence === 'high' ? 'ok' : g.confidence === 'medium' ? 'notice' : 'warn'} small>{g.confidence === 'high' ? '高' : g.confidence === 'medium' ? '中' : '低'}</Chip> <span style={{ fontSize: 12.5, color: T.dim }}>{confidenceWhy(c)}</span></div>
          <div style={{ marginTop: 12 }}><DigLink label="在会话里看增长明细" prompt={`请分析节点 ${String(c.node)} 库 ${String(c.db)} 的容量增长：当前 ${fmtBytes(s.dbBytes)}，观测窗 ${Number(g.windowHours ?? 0)} h 增速 ${fmtGbPerDay(Number(g.bytesPerDay ?? 0))}（置信度 ${String(g.confidence)}），非表占用 ${fmtBytes(s.nonTableBytes)}（${fmtPct(s.nonTableShare ?? 0)}）。${DIG_TAIL}`} /></div>
        </div>
      </div>
    </div>
  );
}
function Side({ t, v, d, color }: { t: string; v: string; d: string; color?: string }) {
  return <><div style={{ fontSize: 13, color: T.dim, margin: '8px 0 2px' }}>{t}</div><div style={{ fontSize: 18, fontWeight: 600, color, ...tnum }}>{v}<span style={{ fontSize: 12.5, color: T.dim, fontWeight: 400, marginLeft: 6 }}>{d}</span></div></>;
}
const confidenceWhy = (c: any): string => { const g = c.summary?.growth ?? {}; const s = c.summary ?? {}; const parts = [g.points < 2 ? '首次采样' : '', Number(s.gapHours ?? 0) > 24 ? `采集空窗 ${Number(s.gapHours)} h` : '', g.segment === 'pre-reset' ? '窗内刚发生清理悬崖，之后样本不足，暂用清理前的段' : g.segment === 'post-reset' ? '窗内有清理悬崖，只用其后的段' : '', g.points >= 2 && Number(g.windowHours) < 24 ? '观测不足 24 h' : ''].filter((x) => x !== ''); return parts.length > 0 ? parts.join('，') : `${Number(g.points)} 个样本跨 ${Number(g.windowHours)} h`; };

// ───────────────────────────────────────────── 构成
function Composition({ c, filter, onFilter }: { c: any; filter: string; onFilter: (k: string) => void }) {
  const dir: any[] = c.composition?.dir ?? []; const db: any[] = c.composition?.db ?? [];
  const dirTotal = Number(c.summary?.dataDirBytes ?? 0) || dir.reduce((a, d) => a + Number(d.bytes), 0);
  const dbTotal = Number(c.summary?.dbBytes ?? 0) || db.reduce((a, d) => a + Number(d.bytes), 0);
  const Rows = ({ items, total, clickable }: { items: any[]; total: number; clickable: boolean }) => {
    const top = Math.max(1, ...items.map((i) => Number(i.bytes)));
    return (
      <div style={{ fontSize: 13.5 }}>
        {items.slice(0, 10).map((it, i) => {
          const key = String(it.kind) === 'schema' ? String(it.name) : '';
          const sel = clickable && filter !== '' && key === filter;
          return (
            <div key={i} onClick={clickable && key !== '' ? () => onFilter(sel ? '' : key) : undefined} style={{ display: 'grid', gridTemplateColumns: '14px minmax(0,1fr) 72px 68px 52px', gap: 10, alignItems: 'center', padding: '6px 0', borderTop: i === 0 ? 'none' : `1px solid ${T.line}`, cursor: clickable && key !== '' ? 'pointer' : 'default', background: sel ? '#eef3ff' : undefined, borderRadius: 6 }}>
              <i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: PALETTE[i % PALETTE.length] }} />
              <span style={{ minWidth: 0, lineHeight: 1.35 }}>{String(it.name)}<small title={String(it.desc ?? '')} style={{ display: 'block', color: T.dim, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{String(it.desc ?? '')}</small></span>
              <span style={{ height: 6, borderRadius: 3, background: T.fill2, position: 'relative' }}><i style={{ position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3, width: `${Math.round(Number(it.bytes) / top * 100)}%`, background: PALETTE[i % PALETTE.length] }} /></span>
              <span style={{ textAlign: 'right', fontWeight: 600, ...tnum }}>{fmtBytes(Number(it.bytes))}</span>
              <span style={{ textAlign: 'right', color: T.dim, fontSize: 12.5, ...tnum }}>{total > 0 ? fmtPct(Number(it.bytes) / total) : ''}</span>
            </div>
          );
        })}
      </div>
    );
  };
  const items = (xs: any[]) => xs.slice(0, 10).map((x) => ({ name: String(x.name), value: Number(x.bytes) }));
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 12 }}>
      <div style={card}>
        <H2 tight hint={String(c.gucs?.data_directory ?? '')}>{c.summary?.dataDirSource === 'db-only' ? <>数据目录 <span style={{ fontSize: 12.5, color: T.dim, fontWeight: 400 }}>库内 {fmtBytes(dirTotal)}；WAL / 日志 / 审计 / core 需初始账号才能读，未列出</span></> : <>数据目录 {fmtBytes(dirTotal)}{c.summary?.dataDirSource === 'estimate' ? <span style={{ fontSize: 12.5, color: T.dim, fontWeight: 400 }}>（估算：无主机 du）</span> : null}</>}</H2>
        <div style={{ margin: '10px 0' }}><StackedBar items={items(dir)} unit="bytes" height={22} /></div>
        <Rows items={dir} total={dirTotal} clickable={false} />
      </div>
      <div style={card}>
        <H2 tight hint="按 schema / 系统表 · 点一行筛选下方 Top 对象">数据库 {String(c.db ?? '')} {fmtBytes(dbTotal)}</H2>
        <div style={{ margin: '10px 0' }}><StackedBar items={items(db)} unit="bytes" height={22} /></div>
        <Rows items={db} total={dbTotal} clickable />
      </div>
    </div>
  );
}

// ───────────────────────────────────────────── Top 对象
function TopTables({ c, filter, onFilter, sort, onSort }: { c: any; filter: string; onFilter: (k: string) => void; sort: 'size' | 'delta'; onSort: (s: 'size' | 'delta') => void }) {
  const all: any[] = c.topTables ?? [];
  const schemas = [...new Set(all.map((t) => String(t.sch)))];
  const hasDelta = all.some((t) => t.delta !== undefined);
  const rows = all.filter((t) => filter === '' || String(t.sch) === filter).slice().sort((a, b) => sort === 'delta' && hasDelta ? Number(b.delta?.bytes ?? Number.NEGATIVE_INFINITY) - Number(a.delta?.bytes ?? Number.NEGATIVE_INFINITY) : Number(b.total) - Number(a.total)).slice(0, Number(c.topN ?? 20));
  const th: any = { fontSize: 12.5, color: T.dim, fontWeight: 500, textAlign: 'left', padding: '8px 10px', borderBottom: `1px solid ${T.line}`, whiteSpace: 'nowrap' };
  const td: any = { padding: '7px 10px', borderBottom: `1px solid ${T.line}`, whiteSpace: 'nowrap', verticalAlign: 'top' };
  const chip = (on: boolean): any => ({ border: `1px solid ${on ? T.blue : T.line}`, borderRadius: 6, padding: '0 9px', color: on ? '#fff' : T.sub, background: on ? T.blue : '#fff', cursor: 'pointer', fontSize: 12.5 });
  return (
    <div style={{ ...card, padding: '12px 20px 6px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: T.dim, margin: '4px 0 10px', flexWrap: 'wrap' }}>
        筛选 <span onClick={() => onFilter('')} style={chip(filter === '')}>全部</span>{schemas.map((s) => <span key={s} onClick={() => onFilter(filter === s ? '' : s)} style={chip(filter === s)}>{s}</span>)}
        <span style={{ marginLeft: 14 }}>排序</span><span onClick={() => onSort('size')} style={chip(sort === 'size')}>总大小</span><span onClick={() => hasDelta && onSort('delta')} style={{ ...chip(sort === 'delta'), opacity: hasDelta ? 1 : 0.45, cursor: hasDelta ? 'pointer' : 'not-allowed' }} title={hasDelta ? '' : '首次采样没有增量，第二次运行起可用'}>24h 增量</span>
        <span style={{ marginLeft: 'auto' }}>{rows.length} 个对象 · 合计 {fmtBytes(rows.reduce((a, r) => a + Number(r.total), 0))}{filter !== '' ? ` · 筛选：${filter}` : ''}</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
          <thead><tr><th style={th}>#</th><th style={th}>对象</th><th style={{ ...th, textAlign: 'right' }}>总大小</th><th style={th}>堆 / 索引</th><th style={{ ...th, textAlign: 'right' }}>行数（reltuples）</th><th style={{ ...th, textAlign: 'right' }}>{hasDelta ? `${Math.round(Number(rows.find((r) => r.delta)?.delta?.hours ?? 24))}h 增量` : '24h 增量'}</th><th style={{ ...th, textAlign: 'right' }}>死元组</th><th style={th}>最后 vacuum</th><th style={th}>最后 analyze</th><th style={th}></th></tr></thead>
          <tbody>
            {rows.map((t, i) => {
              const heapPct = Number(t.total) > 0 ? Math.round(Number(t.heap) / Number(t.total) * 100) : 0; const idxPct = Number(t.total) > 0 ? Math.round(Number(t.idx) / Number(t.total) * 100) : 0;
              const never = (v: any) => v === undefined || v === null || v === '';
              return (
                <tr key={`${t.sch}.${t.name}`}>
                  <td style={{ ...td, color: T.dim, ...tnum }}>{i + 1}</td>
                  <td style={td}><span style={{ fontFamily: mono, fontSize: 12.5 }}><span style={{ color: T.dim }}>{String(t.sch)}.</span><b>{String(t.name)}</b></span></td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 600, ...tnum }}>{fmtBytes(Number(t.total))}</td>
                  <td style={td}><span style={{ display: 'inline-block', width: 90, height: 5, borderRadius: 3, background: T.fill2, position: 'relative', verticalAlign: 'middle', marginRight: 6 }}><i style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${heapPct}%`, background: PALETTE[0], borderRadius: 3 }} /><i style={{ position: 'absolute', left: `${heapPct}%`, top: 0, bottom: 0, width: `${idxPct}%`, background: PALETTE[1], borderRadius: 3 }} /></span><span style={{ fontSize: 12.5, color: T.sub, ...tnum }}>{fmtBytes(Number(t.heap))} / {fmtBytes(Number(t.idx))}</span></td>
                  <td style={{ ...td, textAlign: 'right', ...tnum }}>{fmtInt(Number(t.reltuples))}</td>
                  <td style={{ ...td, textAlign: 'right', ...tnum }}>{t.delta !== undefined ? <span style={{ color: Number(t.delta.bytes) > 0 ? T.sev.warn.c : Number(t.delta.bytes) < 0 ? T.sev.ok.c : T.dim }}>{Number(t.delta.bytes) === 0 ? '0' : `${Number(t.delta.bytes) > 0 ? '+' : '−'}${fmtBytes(Math.abs(Number(t.delta.bytes)))}`}</span> : <Grey>首采</Grey>}</td>
                  <td style={{ ...td, textAlign: 'right', ...tnum }}>{Number(t.dead) > 0 ? `${fmtInt(Number(t.dead))} (${fmtPct(Number(t.deadRatio))})` : <span>0 <span style={{ color: T.dim, fontSize: 12 }}>{Number(t.live) === 0 ? '(计数器 0)' : ''}</span></span>}</td>
                  <td style={{ ...td, color: never(t.lastVacuum) ? T.sev.warn.c : T.ink, fontWeight: never(t.lastVacuum) ? 500 : 400, ...tnum }}>{whenOrNever(t.lastVacuum)}</td>
                  <td style={{ ...td, color: never(t.lastAnalyze) ? T.sev.warn.c : T.ink, fontWeight: never(t.lastAnalyze) ? 500 : 400, ...tnum }}>{whenOrNever(t.lastAnalyze)}</td>
                  <td style={td}><DigLink label="深挖" prompt={`请分析节点 ${String(c.node)} 表 ${String(t.sch)}.${String(t.name)} 的容量：总 ${fmtBytes(Number(t.total))}（堆 ${fmtBytes(Number(t.heap))} / 索引 ${fmtBytes(Number(t.idx))}），reltuples ${fmtInt(Number(t.reltuples))}，死元组 ${fmtInt(Number(t.dead))}，最后 vacuum ${whenOrNever(t.lastVacuum)}，最后 analyze ${whenOrNever(t.lastAnalyze)}${t.delta !== undefined ? `，${t.delta.hours}h 增量 ${fmtBytes(Number(t.delta.bytes))}` : ''}。${DIG_TAIL}`} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────── 非表占用
function SysCards({ c }: { c: any }) {
  const s = c.sys ?? {}; const g = c.gucs ?? {}; const f = (rule: string) => ((c.findings ?? []) as any[]).find((x) => x.rule === rule);
  const kv = (rows: [string, string][]) => <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.6 }}>{rows.map(([l, v]) => <div key={l} style={{ margin: '2px 0' }}><span style={{ color: T.dim, marginRight: 6 }}>{l}</span><span style={{ fontFamily: mono, fontSize: 12.5, overflowWrap: 'break-word' }}>{v}</span></div>)}</div>;
  const Big = ({ v, d }: { v: string; d: string }) => <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.3, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 6, whiteSpace: 'nowrap', ...tnum }}>{v}<small style={{ fontSize: 12.5, color: T.dim, fontWeight: 400 }}>{d}</small></div>;
  const lvl = (rule: string, okText: string, badText: string) => { const x = f(rule); return x !== undefined && x.level !== 'ok' ? <Chip level={x.level} small>{badText}</Chip> : <Chip level="ok" small>{okText}</Chip>; };
  const wal = s.wal ?? {}; const st = s.stmt ?? {}; const lg = s.log ?? {}; const wd = s.wdr ?? {}; const au = s.audit ?? {}; const co = s.core ?? {};
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 12 }}>
      <div style={card}><H2 tight>WAL · {String(wal.dir ?? 'pg_xlog')} {lvl('CAP_WAL_SIZE', wal.available ? '正常' : '按参数估', '超限')}</H2>
        <Big v={wal.available ? fmtBytes(Number(wal.bytes)) : `≤ ${fmtBytes(Number(wal.capBytes ?? 0))}`} d={wal.available ? `${fmtInt(Number(wal.segments))} 段 × 16 MB` : `上限估算 · 目录需初始账号（omm）才能读`} />
        {kv([['上限由', `checkpoint_segments = ${String(g.checkpoint_segments ?? '?')}`], ['保留', `wal_keep_segments = ${String(g.wal_keep_segments ?? '?')}`], ['复制槽', `${Number(wal.slots ?? 0)}${Number(wal.slotsInactive ?? 0) > 0 ? `（${Number(wal.slotsInactive)} 个不活跃）` : Number(wal.slots ?? 0) > 0 ? '（均活跃）' : '（无滞留）'}`]])}
        <div style={{ fontSize: 12.5, color: T.sub, marginTop: 6 }}>段数由参数决定；不能手删，只能调参数。</div></div>
      <div style={card}><H2 tight>全量 SQL 追踪 {lvl('CAP_STMT_HISTORY_BLOAT', '正常', '膨胀')}</H2>
        <Big v={st.available ? fmtBytes(Number(st.bytes)) : '—'} d={st.available ? `statement_history · ${fmtInt(Number(st.rows))} 行` : '不可用'} />
        {kv([['开关', `enable_stmt_track = ${String(g.enable_stmt_track ?? '?')}`], ['级别', `track_stmt_stat_level = ${String(g.track_stmt_stat_level ?? '?')}`], ['保留', `${String(g.track_stmt_retention_time ?? '?')}（全量 s，慢 SQL s）`]])}
        <div style={{ fontSize: 12.5, color: T.sub, marginTop: 6 }}>{f('CAP_STMT_HISTORY_BLOAT')?.level !== 'ok' ? String(f('CAP_STMT_HISTORY_BLOAT')?.advice ?? '') : `最老 ${st.oldest !== undefined ? mmddhhmm(String(st.oldest)) : '—'}；按保留期滚动。`}</div></div>
      <div style={card}><H2 tight>运行日志 · {String(lg.dir ?? 'pg_log')} {lvl('CAP_LOG_RETENTION', lg.available ? '未超门槛' : '不可读', '无保留策略')}</H2>
        <Big v={lg.available ? fmtBytes(Number(lg.bytes)) : '—'} d={lg.available ? `${fmtInt(Number(lg.files))} 个文件${lg.oldest !== undefined ? ` · ${String(lg.oldest).replace(/^postgresql-/, '').slice(0, 10)} 起` : ''}` : '目录需初始账号（omm）才能读'} />
        {kv([['慢日志阈值', `log_min_duration_statement = ${String(g.log_min_duration_statement ?? '?')}`], ['轮转', `${String(g.log_rotation_age ?? '?')} / ${String(g.log_rotation_size ?? '?')}，无最长保留参数`]])}
        <div style={{ fontSize: 12.5, color: T.sub, marginTop: 6 }}>openGauss 只轮转不清理；保留天数需要外部策略。</div></div>
      <div style={card}><H2 tight>WDR 快照 {lvl('CAP_WDR_RETENTION', wd.enabled ? '保留生效' : '未开启', '需核对')}</H2>
        <Big v={fmtBytes(Number(wd.bytes ?? 0))} d={wd.enabled ? `${fmtInt(Number(wd.count))} 个快照 · 最老 ${Number(wd.oldestAgeDays ?? 0)} 天` : 'snapshot schema'} />
        {kv([['间隔', `wdr_snapshot_interval = ${String(g.wdr_snapshot_interval ?? '?')}`], ['保留', `wdr_snapshot_retention_days = ${String(g.wdr_snapshot_retention_days ?? '?')}`], ['审计 / core', `pg_audit ${au.available ? fmtBytes(Number(au.bytes)) : '—'} · core ${co.available ? (Number(co.bytes) > 0 ? fmtBytes(Number(co.bytes)) : '0') : '—'}`]])}
        <div style={{ fontSize: 12.5, color: T.sub, marginTop: 6 }}>{Number(co.bytes ?? 0) > 0 ? `core 文件：${(co.files ?? []).map((x: any) => String(x.name)).join(', ')}` : '快照表的死元组是正常周转，由 autovacuum 回收。'}</div></div>
    </div>
  );
}

// ───────────────────────────────────────────── Vacuum / 统计信息
function VacuumStats({ c }: { c: any }) {
  const dead: any[] = (c.deadTop ?? []).slice(0, 6); const sn = c.statsNever ?? {}; const items: any[] = sn.items ?? [];
  const th: any = { fontSize: 12.5, color: T.dim, fontWeight: 500, textAlign: 'left', padding: '6px 8px', borderBottom: `1px solid ${T.line}`, whiteSpace: 'nowrap' };
  const td: any = { padding: '6px 8px', borderBottom: `1px solid ${T.line}`, whiteSpace: 'nowrap', fontSize: 12.5 };
  const obj = (n: string) => { const i = n.indexOf('.'); return <span title={n} style={{ fontFamily: mono, fontSize: 12, display: 'inline-block', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'bottom' }}><span style={{ color: T.dim }}>{i > 0 ? n.slice(0, i + 1) : ''}</span><b>{i > 0 ? n.slice(i + 1) : n}</b></span>; };
  const by = Object.entries(sn.bySchema ?? {}).sort((a: any, b: any) => b[1] - a[1]) as [string, number][];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 12 }}>
      <div style={card}><H2 tight hint="n_dead / (live + dead) · pg_stat_user_tables">死元组 Top</H2>
        {dead.length === 0 ? <div style={{ fontSize: 13.5, color: T.dim }}>没有死元组累积。</div> : (
          <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>对象</th><th style={{ ...th, textAlign: 'right' }}>死元组</th><th style={{ ...th, textAlign: 'right' }}>占比</th><th style={th}>最后 autovacuum</th></tr></thead>
            <tbody>{dead.map((d) => <tr key={String(d.name)}><td style={td}>{obj(String(d.name))}</td><td style={{ ...td, textAlign: 'right', ...tnum }}>{fmtInt(Number(d.dead))}</td><td style={{ ...td, textAlign: 'right', ...tnum }}><span style={{ display: 'inline-block', width: 54, height: 5, borderRadius: 3, background: T.fill2, position: 'relative', verticalAlign: 'middle', marginRight: 6 }}><i style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.min(100, Math.round(Number(d.ratio) * 100))}%`, background: Number(d.ratio) >= 0.4 ? T.sev.warn.c : Number(d.ratio) >= 0.2 ? T.sev.notice.c : PALETTE[5], borderRadius: 3 }} /></span>{fmtPct(Number(d.ratio))}</td><td style={{ ...td, ...tnum }}>{whenOrNever(d.lastVacuum)}</td></tr>)}</tbody>
          </table></div>
        )}
        <div style={{ fontSize: 12.5, color: T.sub, marginTop: 8 }}>autovacuum = {String(c.gucs?.autovacuum ?? '?')} · naptime {String(c.gucs?.autovacuum_naptime ?? '?')} · scale_factor {String(c.gucs?.autovacuum_vacuum_scale_factor ?? '?')}。{(c.topTables ?? []).some((t: any) => Number(t.live) === 0 && Number(t.reltuples) > 0) ? '业务表 n_live_tup 计数为 0：从未 analyze，死元组统计不可信（见右）。' : ''}</div></div>
      <div style={card}><H2 tight>统计信息从未收集 {Number(sn.count ?? 0) > 0 ? <Chip level="warn" small>{Number(sn.count)} 张</Chip> : <Chip level="ok" small>0 张</Chip>}</H2>
        {Number(sn.count ?? 0) === 0 ? <div style={{ fontSize: 13.5, color: T.dim }}>没有 reltuples ≥ 100 万且从未 analyze 的表。</div> : (<>
          <div style={{ fontSize: 14, margin: '4px 0 8px' }}>{by.map(([k, v]) => `${k} ${v} 张`).join('、')} 的表 <span style={{ fontFamily: mono, fontSize: 12.5 }}>last_analyze = never</span>——优化器只有装载时写入的 reltuples，没有列级直方图。</div>
          <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>对象</th><th style={{ ...th, textAlign: 'right' }}>reltuples</th><th style={{ ...th, textAlign: 'right' }}>大小</th><th style={th}></th></tr></thead>
            <tbody>{items.slice(0, 6).map((r) => <tr key={`${r.sch}.${r.name}`}><td style={td}>{obj(`${String(r.sch)}.${String(r.name)}`)}</td><td style={{ ...td, textAlign: 'right', ...tnum }}>{fmtInt(Number(r.reltuples))}</td><td style={{ ...td, textAlign: 'right', ...tnum }}>{fmtBytes(Number(r.total))}</td><td style={td}><DigLink label="深挖" prompt={`节点 ${String(c.node)} 表 ${String(r.sch)}.${String(r.name)}（reltuples ${fmtInt(Number(r.reltuples))}，${fmtBytes(Number(r.total))}）从未 analyze。请核对它在 Top SQL 里的计划（是否全表扫/估算行数偏差），说明 ANALYZE 的预期收益与执行注意点（平台只读，由 DBA 执行）。`} /></td></tr>)}</tbody>
          </table></div>
          {items.length > 6 ? <div style={{ fontSize: 12.5, color: T.dim, marginTop: 6 }}>另 {items.length - 6} 张见存档 statsNever.items。</div> : null}
        </>)}</div>
    </div>
  );
}

// ───────────────────────────────────────────── 发现 / 解读 / 历史
function Findings({ c, notes }: { c: any; notes: Map<string, string> }) {
  const fs: any[] = c.findings ?? [];
  return (
    <div style={{ ...card, padding: '4px 20px' }}>
      {fs.map((f, i) => {
        const note = notes.get(`${String(f.rule)}|${String(f.object ?? '')}`) ?? notes.get(String(f.rule)) ?? '';
        return (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '8px 176px minmax(0,1fr) 170px', gap: 12, alignItems: 'start', padding: '10px 0', borderTop: i === 0 ? 'none' : `1px solid ${T.line}`, fontSize: 14 }}>
            <i style={{ width: 8, height: 8, borderRadius: 4, background: sev(String(f.level)).c, marginTop: 9, display: 'block' }} />
            <span style={keyChip}>{String(f.rule)}</span>
            <div style={{ minWidth: 0 }}>{String(f.problem)}<div style={{ fontSize: 12.5, color: T.dim, marginTop: 2 }}>evidence：{String(f.evidence)}{String(f.advice ?? '') !== '' ? <> · <b style={{ color: T.sub, fontWeight: 500 }}>建议</b> {String(f.advice)}</> : null}</div>{note !== '' ? <div style={{ fontSize: 13, color: T.sub, marginTop: 4 }}>解读：{note}</div> : null}</div>
            {String(f.level) !== 'ok' ? <DigLink label="在会话里深挖" prompt={`节点 ${String(c.node)} 容量发现 ${String(f.rule)}（${String(f.level)}）：${String(f.problem)}。证据：${String(f.evidence)}。${DIG_TAIL}`} /> : <span style={{ fontSize: 12.5, color: T.dim }}>{String(f.evidence).split(' · ').pop()}</span>}
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
    <div style={card}>
      <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 26 }}>
        {cells.map((r: any) => { const lv = String(r.collect?.det?.worst ?? r.report?.data?.det?.worst ?? (r.status === 'succeeded' ? 'ok' : 'notice')); const usable = r.report !== undefined || r.collect !== undefined; return (
          <i key={String(r.id)} title={`${String(r.firedAt).replace('T', ' ').slice(0, 16)} · ${lv}`} onClick={() => usable && onSel(String(r.id))} style={{ flex: 1, maxWidth: 16, height: '100%', borderRadius: 3, background: sev(lv).c, cursor: usable ? 'pointer' : 'default', fontStyle: 'normal', outline: r.id === selId ? `2px solid ${T.ink}` : 'none', outlineOffset: 1, opacity: usable ? 1 : 0.35 }} />); })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: T.dim, marginTop: 6 }}><span>{String(cells[0]?.firedAt ?? '').slice(5, 10)}</span><span>最新 ▲ · 点格子查看当次报告 · 对象级增量与增速置信度随格子增多而可信</span></div>
    </div>
  );
}

// ───────────────────────────────────────────── 面板
export function CapacityPanel({ task, runId, call }: { task: any; runId?: string; call: (endpoint: string, payload?: unknown) => Promise<any> }) {
  const [runs, setRuns] = useState<any[]>([]);
  const [selId, setSelId] = useState('');
  useEffect(() => { setSelId(typeof runId === 'string' ? runId : ''); }, [runId]);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<'size' | 'delta'>('size');
  useEffect(() => {
    let alive = true;
    const load = () => { call('runs/list', { taskId: task.id }).then((v) => { if (alive) { setRuns(v?.runs ?? []); setError(''); } }).catch((e) => { if (alive) setError(String(e?.message ?? e)); }); };
    load(); const timer = setInterval(load, 30000);
    return () => { alive = false; clearInterval(timer); };
  }, [task.id]);
  const usable = runs.filter((r) => r.report !== undefined || r.collect !== undefined);
  const current = usable.find((r) => r.id === selId) ?? usable[0];
  const data = current?.report?.data; const c = current?.collect;
  const findingNotes = useMemo(() => new Map<string, string>(((data?.findings ?? []) as any[]).flatMap((f) => [[`${String(f.rule)}|${String(f.object ?? '')}`, String(f.note ?? '')], [String(f.rule), String(f.note ?? '')]])), [data]);
  if (error !== '') return <div style={{ fontSize: 16, color: T.dim, padding: 16 }}>加载失败：{error}</div>;
  if (current === undefined) return <div style={{ fontSize: 16, color: T.dim, padding: 16 }}>还没有容量报告——任务触发后（cron 或在会话里说一声）报告会出现在这里。</div>;
  const worst = String(c?.det?.worst ?? data?.det?.worst ?? 'ok');
  if (c === undefined || String(c.scope) !== 'capacity') {
    return <div style={{ fontFamily: FONT, color: T.ink, lineHeight: 1.75 }}><div style={{ fontSize: 18, fontWeight: 600, color: sev(worst).c, marginBottom: 8 }}>容量态势：{sev(worst).cn}</div><div style={{ fontSize: 14, color: T.sub }}>{String(current.report?.summary ?? '')}</div><div style={{ fontSize: 13.5, color: T.sev.notice.c, background: T.sev.notice.soft, borderRadius: 8, padding: '8px 14px', margin: '12px 0' }}>这次运行没有采集存档（capacity_collect 未执行或存档失败），只能显示模型摘要。</div><H2 hint="一格一次运行">检查历史</H2><RunStrip runs={runs} selId={String(current.id)} onSel={setSelId} /></div>;
  }
  const counts = c.det?.counts ?? {}; const priorities: any[] = data?.priorities ?? [];
  return (
    <Boundary>
      <div style={{ fontFamily: FONT, color: T.ink, lineHeight: 1.75 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={{ fontSize: 18, fontWeight: 600, color: sev(worst).c }}>容量态势：{sev(worst).cn}</span>
          {Number(counts.warn ?? 0) + Number(counts.critical ?? 0) > 0 ? <Chip level="warn">告警 {Number(counts.warn ?? 0) + Number(counts.critical ?? 0)}</Chip> : null}
          {Number(counts.notice ?? 0) > 0 ? <Chip level="notice">关注 {Number(counts.notice)}</Chip> : null}
          <Chip level="ok">正常 {Number(counts.ok ?? 0)}</Chip>
          <span style={{ fontSize: 13.5, color: T.dim }}>节点 {String(c.node)} · 库 {String(c.db)} · 采集 {mmddhhmm(String(c.collectedAt))} · 数字来自采集存档，判定由脚本产出，模型只做解读</span>
        </div>
        {String(data?.situation ?? current.report?.summary ?? '') !== '' ? <div style={{ fontSize: 15, color: T.sub, marginBottom: 12 }}>{String(data?.situation ?? '') !== '' ? String(data.situation) : String(current.report?.summary ?? '')}</div> : null}
        <Stats c={c} />

        <H2 hint="逐次采样 · 灰带 = 无采集 · 竖线 = 字典里的建/删批次 · 虚线 = 按观测窗增速外推 · 悬停看数值">增长趋势</H2>
        <Trend c={c} />

        <H2 hint="左：数据目录构成 · 右：库内按 schema / 系统表（对象级为逻辑大小 pg_total_relation_size）· 点右侧一行筛选 Top 对象">容量构成</H2>
        <Composition c={c} filter={filter} onFilter={setFilter} />

        <H2 hint="按总大小 · 24h 增量自第二次采样起可得 · 死元组与 vacuum/analyze 来自 pg_stat_user_tables · 每行可深挖">Top 对象</H2>
        <TopTables c={c} filter={filter} onFilter={setFilter} sort={sort} onSort={setSort} />

        <H2 hint={`这些不是业务数据，却占了数据目录 ${fmtPct(c.summary?.nonTableShare ?? 0)}——每项给出"谁在决定它的大小"`}>非表占用与保留策略</H2>
        <SysCards c={c} />

        <H2 hint="膨胀看死元组比例，坏计划看 analyze 新鲜度——两者都只从 pg_stat_user_tables 读">Vacuum 与统计信息健康</H2>
        <VacuumStats c={c} />

        <H2 hint="阈值判定 · 级别由脚本产出，不可被解读下调 · 每条可直接深挖">发现</H2>
        <Findings c={c} notes={findingNotes} />

        {(String(data?.rootCause ?? '') !== '' || priorities.length > 0) ? (
          <>
            <H2 hint="模型解读 · 引用的数字均有出处 · 平台只读，处置由 DBA 执行">解读与处置优先级</H2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 12 }}>
              {String(data?.rootCause ?? '') !== '' ? <div style={{ ...card, background: T.fill, border: 'none' }}><div style={{ fontSize: 13.5, color: T.dim, fontWeight: 500, marginBottom: 4 }}>根因串联</div><div style={{ fontSize: 15, color: T.ink }}>{String(data.rootCause)}</div></div> : null}
              {priorities.length > 0 ? <div style={card}><div style={{ fontSize: 13.5, color: T.dim, fontWeight: 500, marginBottom: 4 }}>处置优先级</div><div style={{ display: 'grid', gap: 8 }}>{priorities.map((p, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: '34px minmax(0,1fr)', gap: 10, alignItems: 'start', fontSize: 15 }}><span style={{ font: `600 13px ${mono}`, background: T.fill2, borderRadius: 6, padding: '2px 0', textAlign: 'center', marginTop: 3 }}>{String(p.p)}</span><div style={{ minWidth: 0 }}><div style={{ overflowWrap: 'break-word' }}>{String(p.action)}</div>{(p.refs ?? []).length > 0 ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>{(p.refs ?? []).map((r: any) => <span key={String(r)} style={{ ...keyChip, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }} title={String(r)}>{String(r)}</span>)}</div> : null}</div></div>)}</div></div> : null}
            </div>
          </>
        ) : null}

        <H2 hint="一格一次运行 · 点格子查看当次报告">检查历史</H2>
        <RunStrip runs={runs} selId={String(current.id)} onSel={setSelId} />
        <div style={{ fontSize: 13.5, color: T.dim, border: `1px dashed ${T.line}`, borderRadius: 8, padding: '8px 14px', marginTop: 16 }}>
          📋 口径：大小按二进制（pg_size_pretty 口径）。数据目录 = {c.summary?.dataDirSource === 'estimate' ? '估算（库 + WAL + 日志 + 审计 + core，无主机 du）' : c.summary?.dataDirSource === 'db-only' ? '未估（openGauss 的 pg_ls_dir / pg_stat_file 只允许初始账号 omm，平台账号读不到 WAL / 日志 / 审计 / core；非表占用只含 statement_history 与 WDR）' : '容器内 du'}；对象级 = pg_total_relation_size（逻辑大小）。增速 = 观测窗内样本的线性回归斜率（检测到清理悬崖只用其后的段）；满盘天数 = 磁盘可用 ÷ 增速，增速低于门槛或无磁盘数据不外推。事件标注来自平台字典的建/删批次。数据源全部只读。
          {[...(c.collectionNotes ?? []), ...(data?.collectionNotes ?? [])].map((n: any, i: number) => <div key={i}>{String(n)}</div>)}
        </div>
      </div>
    </Boundary>
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
  registerPanel('capacity', CapacityPanel);
}
