/**
 * task-wdr client 面板（R2，2026-08-29 user 定稿 docs/prototypes/wdr-r2.html）：
 * 状态带 + 窗口选择 → 摘要卡（vs 上一窗口）→ 负载趋势（24 窗口 AAS 堆叠柱 + 一眼结论）→ DB Time 构成 | 等待事件 Top10 →
 * Load Profile（AWR 式 + 效率条）→ Top SQL（维度切换 / 行展开 / 探针隐藏 / 深挖）→ IO·WAL | Checkpoint | 主机 →
 * 发现（含通过项，逐条可深挖）→ 根因 / 优先级 → 检查历史。
 * 数字全部来自采集存档 run.collect（确定性直读），模型报告 run.report.data 只贡献解读。深挖 = 直接新建会话并发送。
 */
import { useEffect, useMemo, useState } from 'react';
import { Priorities } from '@opendb-dsh/chart-kit';
import { T, sev, mono, FONT, tnum, card, keyChip, CLASS_COLOR, WAIT_COLOR, WAIT_CN, ATTR_BADGE, fmtUs, fmtS, fmtCount, fmtBytes, fmtMs, fmtLp, fmtCheckNum, oneLine, hhmm, mmddhhmm, changeText, type Tone } from './format.ts';
import { AasTrend } from './trend.tsx';

// 深挖要用 sessions / connection / workspaces：必须列进 inject（2026-08-27 行为测试抓到；与 task-health / task-sqlreview 同一份清单）
export const inject = ['slots', 'connection', 'workspaces', 'sessions'];

const ORDER: Record<string, number> = { critical: 3, warn: 2, notice: 1, ok: 0 };
const TONE_COLOR: Record<Tone, string> = { bad: T.sev.warn.c, good: T.sev.ok.c, flat: T.dim };

// ───────────────────────────────────────────── 小件
function H2({ children, hint, tight }: { children: any; hint?: string; tight?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: tight ? '0 0 10px' : '28px 0 12px', flexWrap: 'wrap' }}>
      <span style={{ fontSize: tight ? 16 : 18, fontWeight: 600, color: T.ink }}>{children}</span>
      {hint !== undefined ? <span style={{ fontSize: 13.5, color: T.dim }}>{hint}</span> : null}
    </div>
  );
}
function Sw({ color, size = 10 }: { color: string; size?: number }) {
  return <i style={{ display: 'inline-block', width: size, height: size, borderRadius: 3, background: color, flex: 'none', fontStyle: 'normal' }} />;
}
function Chip({ level, children, small }: { level: string; children: any; small?: boolean }) {
  const s = sev(level);
  return <span style={{ display: 'inline-flex', gap: 5, fontSize: small ? 12 : 13.5, fontWeight: 500, color: s.c, background: s.soft, borderRadius: 6, padding: small ? '0 8px' : '2px 10px', whiteSpace: 'nowrap' }}>{children}</span>;
}
/** 与监控（健康检查）面板同一个链接样式：12.5px 蓝色文字链，无边框 */
function Link({ onClick, children, busy, fail, title }: { onClick: () => void; children: any; busy?: boolean; fail?: boolean; title?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={busy} title={title}
      style={{ font: 'inherit', fontSize: 12.5, color: fail ? T.sev.critical.c : T.blue, background: 'none', border: 'none', padding: 0, cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}>
      {children}
    </button>
  );
}

// ───────────────────────────────────────────── 深挖：一键开会话并发送（同健康报告 / Top SQL 报表）
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
/** 同 task-health 的 DigLink：文案与三态（`${label} →` / 开会话中… / 失败，重试）一字不差 */
function DigLink({ prompt, label }: { prompt: string; label: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'fail'>('idle');
  return (
    <Link busy={state === 'busy'} fail={state === 'fail'} title="直接新建会话并把窗口背景与本条数据作为背景发出" onClick={() => { setState('busy'); digInSession(prompt).then(() => setState('idle')).catch(() => setState('fail')); }}>
      {state === 'busy' ? '开会话中…' : state === 'fail' ? '失败，重试' : `${label} →`}
    </Link>
  );
}
function CopyLink({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return <Link onClick={() => { try { void navigator.clipboard.writeText(text); } catch { /* noop */ } setDone(true); setTimeout(() => setDone(false), 1500); }}>{done ? '已复制' : label}</Link>;
}
function windowLine(c: any): string {
  const w = c.window ?? {};
  return `窗口 snap ${Number(w.beginSnap)}→${Number(w.endSnap)}（${mmddhhmm(String(w.beginTs ?? ''))}–${hhmm(String(w.endTs ?? ''))}，${Number(w.minutes)} 分钟）`;
}
function backgroundLine(c: any): string {
  const s = c.summary ?? {}; const w0 = (c.waits?.top ?? [])[0]; const other = (c.breakdown?.classes ?? []).find((x: any) => String(x.name) === '其他等待');
  return `窗口背景：AAS ${Number(s.aas)}${s.prevAas !== null && s.prevAas !== undefined ? `（上窗 ${Number(s.prevAas)}）` : ''} · DB Time ${Number(s.dbTimeS).toLocaleString()} s · 等待占 DB Time ${Math.round(Number(other?.share ?? 0) * 100)}%${w0 !== undefined ? ` · 主导等待 ${String(w0.event)} ${Math.round(Number(w0.waitUs) / 1e6)} s` : ''} · 临时文件 ${fmtBytes(Number(s.tempBytes))} · 命中率 ${(Number(s.hitRatio) * 100).toFixed(2)}% · TPS ${Number(s.tps)}/s`;
}
function sqlDigPrompt(c: any, it: any, note: string): string {
  return [
    `【WDR 深挖】节点 ${String(c.node)} · ${windowLine(c)} · sql ${String(it.sqlId)} · 归因 ${String(it.attr)} · 占窗口 SQL 耗时 ${(Number(it.share) * 100).toFixed(1)}%`,
    `窗口内：${fmtCount(Number(it.calls))} 次 × 均 ${fmtMs(Number(it.avgMs))} · 总耗时 ${fmtS(Number(it.elapsedUs))} · CPU ${fmtS(Number(it.cpuMs) * 1000)} · IO ${fmtS(Number(it.ioMs) * 1000)} · 逻辑读 ${fmtCount(Number(it.blocks))}（命中 ${Number(it.hitPct)}%）· 返回 ${fmtCount(Number(it.rowsRet))} 行${Number(it.spillBytes) > 0 ? ` · 下盘 ${fmtBytes(Number(it.spillBytes))}` : ''}`,
    backgroundLine(c),
    `SQL：${oneLine(String(it.text))}`,
    note !== '' ? `报告里的解读：${note}` : '',
    `任务：请围绕这条 SQL 在该窗口的表现深挖——先用工具（db_query EXPLAIN / sqlreview_collect / wdr_collect 传同一窗口 beginSnap=${Number(c.window?.beginSnap)}, endSnap=${Number(c.window?.endSnap)}）取证，再给出：1) 它为什么在这个窗口占这么多（执行方式 / 下盘 / 扫描）；2) 可行的优化方案（改写请用 EXPLAIN 实证 cost 对比；索引类注明需人工执行）；3) 预期收益与风险。只谈性能不谈规范。本平台只读，不执行任何变更。不要向我反问，直接给结论。`,
  ].filter((s) => s !== '').join('\n');
}
function checkDigPrompt(c: any, ck: any, note: string): string {
  const top = ((c.topSql ?? []) as any[]).filter((s) => s.probe !== true).slice(0, 3).map((s, i) => `#${i + 1} ${String(s.sqlId)}（${String(s.attr)}，${(Number(s.share) * 100).toFixed(1)}%）`).join('、');
  return [
    `【WDR 发现深挖】节点 ${String(c.node)} · ${windowLine(c)} · ${String(ck.code)}（${sev(String(ck.level)).cn}）· 实测 ${String(ck.value)} · 阈值 ${String(ck.threshold)}`,
    `判定：${String(ck.detail)}${String(ck.evidence ?? '') !== '' ? `；证据：${String(ck.evidence)}` : ''}`,
    backgroundLine(c),
    top !== '' ? `窗口 Top SQL：${top}` : '',
    note !== '' ? `报告里的解读：${note}` : '',
    `任务：请围绕这条发现深挖根因并给出处置建议——先用工具取证（wdr_collect 传同一窗口 beginSnap=${Number(c.window?.beginSnap)}, endSnap=${Number(c.window?.endSnap)}、db_query 只读、health_collect），再给出：1) 根因与跨维度互证；2) 处置建议（参数 / SQL / 架构，只读平台不代改）；3) 是否需要持续跟踪。不要向我反问，直接给结论。`,
  ].filter((s) => s !== '').join('\n');
}

// ───────────────────────────────────────────── ② 摘要卡
function Stat({ l, v, d, tone, vColor }: { l: string; v: any; d: string; tone: Tone; vColor?: string }) {
  return (
    <div style={{ background: T.fill, borderRadius: 8, padding: '11px 13px', minWidth: 0 }}>
      <div style={{ fontSize: 12.5, color: T.dim, whiteSpace: 'nowrap' }}>{l}</div>
      <div style={{ fontSize: 21, fontWeight: 600, lineHeight: 1.3, marginTop: 2, whiteSpace: 'nowrap', color: vColor, ...tnum }}>{v}</div>
      {/* 副行允许折两行：08-29 实拍 "▲ ×11 · 上窗 0.97 · 18 核" 在 7 列布局里被截成 "1…" */}
      <div style={{ fontSize: 12, lineHeight: 1.45, color: TONE_COLOR[tone], ...tnum }}>{d}</div>
    </div>
  );
}
function Stats({ s, hitWarn }: { s: any; hitWarn: boolean }) {
  const n = (v: any) => Number(v ?? 0);
  const nn = (v: any): number | null => (v === null || v === undefined ? null : Number(v));
  const db = changeText(n(s.dbTimeS), nn(s.prevDbTimeS), { kind: 'ratio', fmt: (v) => `${v.toLocaleString()} s` });
  const aas = changeText(n(s.aas), nn(s.prevAas), { kind: 'ratio', fmt: (v) => String(v) });
  const tps = changeText(n(s.tps), nn(s.prevTps), { kind: 'ratio', fmt: (v) => `${v} /s`, badWhenUp: false });
  const hit = changeText(n(s.hitRatio), nn(s.prevHitRatio), { kind: 'pt', fmt: (v) => `${(v * 100).toFixed(2)}%`, badWhenUp: false });
  const pr = changeText(n(s.physReadsPerSec), nn(s.prevPhysReadsPerSec), { kind: 'ratio', fmt: (v) => `${v.toLocaleString()} 块/s` });
  const tmp = changeText(n(s.tempBytesPerSec), nn(s.prevTempBytesPerSec), { kind: 'ratio', fmt: (v) => `${fmtBytes(v)}/s` });
  const wal = changeText(n(s.walBytesPerSec), nn(s.prevWalBytesPerSec), { kind: 'ratio', fmt: (v) => `${fmtBytes(v)}/s` });
  const ck = n(s.ckptReq) > 0 ? 'bad' : 'flat';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 10 }}>
      <Stat l="DB Time" v={`${n(s.dbTimeS).toLocaleString()} s`} d={db.text} tone={db.tone} />
      <Stat l={`平均活跃会话 AAS${n(s.cores) > 0 ? ` · ${n(s.cores)} 核` : ''}`} v={String(n(s.aas))} d={aas.text} tone={aas.tone} />
      <Stat l="事务 TPS" v={`${n(s.tps)} /s`} d={tps.text} tone={tps.tone} />
      <Stat l="缓存命中" v={`${(n(s.hitRatio) * 100).toFixed(2)}%`} d={hit.text} tone={hit.tone} vColor={hitWarn ? T.sev.warn.c : undefined} />
      <Stat l="物理读" v={`${n(s.physReadsPerSec).toLocaleString()} 块/s`} d={pr.text} tone={pr.tone} />
      <Stat l={`临时文件${n(s.tempBytesPerSec) > 0 ? ` · ${fmtBytes(n(s.tempBytesPerSec))}/s` : ''}`} v={fmtBytes(n(s.tempBytes))} d={tmp.text} tone={tmp.tone} />
      <Stat l="WAL 写" v={`${fmtBytes(n(s.walBytesPerSec))}/s`} d={wal.text} tone={wal.tone} />
      <Stat l="Checkpoint" v={<>{n(s.ckptTimed)} <span style={{ fontSize: 13, fontWeight: 500, color: T.dim }}>定时</span></>} d={`被动 ${n(s.ckptReq)} · 刷脏 ${fmtBytes(n(s.ckptBufBytes))}`} tone={ck} />
    </div>
  );
}

// ───────────────────────────────────────────── ③ 趋势 + 一眼结论
const INSIGHT_COLOR: Record<string, string> = { warn: T.sev.warn.c, notice: '#6b4fc7', ok: T.rest };
function TrendCard({ c }: { c: any }) {
  const insights: any[] = c.insights ?? [];
  return (
    <div style={card}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px', gap: 24 }}>
        <div style={{ minWidth: 0 }}>
          <AasTrend points={c.trend ?? []} beginSnap={Number(c.window?.beginSnap)} endSnap={Number(c.window?.endSnap)} cores={Number(c.host?.cores ?? 0)} />
          <div style={{ display: 'flex', gap: 16, fontSize: 12.5, color: T.sub, marginTop: 6, flexWrap: 'wrap' }}>
            <span><Sw color={CLASS_COLOR.CPU} /> CPU</span><span><Sw color={CLASS_COLOR.IO} /> IO</span><span><Sw color={CLASS_COLOR.其他等待} /> 其他等待（锁 / LWLock / 网络 / 空闲）</span>
            <span><i style={{ display: 'inline-block', width: 8, height: 8, border: `2px solid ${T.ink}`, borderRadius: 2, fontStyle: 'normal' }} /> 分析窗口</span>
          </div>
        </div>
        <div style={{ borderLeft: `1px solid ${T.line}`, paddingLeft: 24, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, color: T.dim, marginBottom: 8 }}>一眼结论（脚本按增量自动生成）</div>
          {insights.map((i, k) => (
            <div key={k} style={{ display: 'flex', gap: 10, marginBottom: 10, fontSize: 14, lineHeight: 1.55 }}>
              <span style={{ marginTop: 7 }}><Sw color={INSIGHT_COLOR[String(i.level)] ?? T.rest} /></span>
              <div>{String(i.text)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────── ④ DB Time 构成 | 等待事件
function Seg({ share, color, label, light }: { share: number; color: string; label: string; light?: boolean }) {
  // 段内文字只在 ≥ 12% 时画（08-29 实拍 7.5% 的 IO 段装不下 "IO 7.5%"，被截成半个字）；窄段靠图例与 title
  return <div title={label} style={{ width: `${Math.max(0, share * 100)}%`, background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', font: `600 11.5px ${mono}`, color: light ? T.sub : '#fff', whiteSpace: 'nowrap', overflow: 'hidden' }}>{share >= 0.12 ? label : ''}</div>;
}
function BreakdownCard({ c }: { c: any }) {
  const total = Number(c.breakdown?.totalUs ?? 0); const secs = Math.max(1, Number(c.window?.secs ?? 1));
  const classes: any[] = c.breakdown?.classes ?? [];
  return (
    <div style={card}>
      <H2 tight hint={`${fmtS(total)} · 按 instance_time 分解`}>DB Time 构成</H2>
      {total <= 0 ? <div style={{ fontSize: 13.5, color: T.dim }}>窗口内 DB Time 近零——数据库基本空闲。</div> : (
        <>
          <div style={{ display: 'flex', height: 22, borderRadius: 5, overflow: 'hidden', background: T.rest }}>
            {classes.map((x) => <Seg key={String(x.name)} share={Number(x.share)} color={CLASS_COLOR[String(x.name)] ?? T.rest} label={`${String(x.name)} ${(Number(x.share) * 100).toFixed(1)}%`} light={String(x.name) === '其他等待'} />)}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 8, fontSize: 12.5, color: T.sub, ...tnum }}>
            {classes.map((x) => <span key={String(x.name)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Sw color={CLASS_COLOR[String(x.name)] ?? T.rest} />{String(x.name)} <b style={{ color: T.ink, fontWeight: 500 }}>{fmtS(Number(x.us))}</b>{['CPU', 'IO', '其他等待'].includes(String(x.name)) ? ` · AAS ${(Number(x.us) / 1e6 / secs).toFixed(2)}` : ''}</span>)}
          </div>
          <div style={{ fontSize: 12.5, color: T.dim, marginTop: 10 }}>其他等待 = DB Time − 以上各项：锁 / LWLock / 缓冲区文件 / 网络之外的等待与调度间隙；具体事件见右侧。</div>
        </>
      )}
    </div>
  );
}
function WaitsCard({ c }: { c: any }) {
  const w = c.waits ?? {}; const top: any[] = w.top ?? []; const classes: any[] = w.classes ?? [];
  const max = Math.max(...top.map((x) => Number(x.waitUs)), 1e-9);
  return (
    <div style={card}>
      <H2 tight hint={`窗口增量 · 已剔除 STATUS 空闲类 · 非空闲等待合计 ${fmtS(Number(w.totalUs ?? 0))}`}>等待事件 Top {top.length}</H2>
      {top.length === 0 ? <div style={{ fontSize: 13.5, color: T.dim }}>窗口内没有非空闲等待。</div> : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', margin: '0 0 10px', fontSize: 12.5, color: T.sub }}>
            {classes.map((x) => <span key={String(x.type)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Sw color={WAIT_COLOR[String(x.type)] ?? '#9aa3ad'} />{WAIT_CN[String(x.type)] ?? String(x.type)} 事件 <b style={{ color: T.ink, fontWeight: 500 }}>{(Number(x.share) * 100).toFixed(1)}%</b></span>)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr) 200px', rowGap: 6, columnGap: 10, fontSize: 12.5, alignItems: 'center', ...tnum }}>
            {top.map((x, i) => (
              <div key={i} style={{ display: 'contents' }}>
                <span style={{ fontSize: 11, borderRadius: 4, padding: '0 6px', background: T.fill2, color: T.sub, whiteSpace: 'nowrap' }}>{WAIT_CN[String(x.type)] ?? String(x.type)}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: mono, fontSize: 12, color: T.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={String(x.event)}>{String(x.event)}</div>
                  <div style={{ height: 4, borderRadius: 2, background: T.fill2, marginTop: 2 }}><div style={{ width: `${Math.min(100, (Number(x.waitUs) / max) * 100)}%`, height: '100%', borderRadius: 2, background: WAIT_COLOR[String(x.type)] ?? '#9aa3ad' }} /></div>
                </div>
                <div style={{ textAlign: 'right', color: T.sub, whiteSpace: 'nowrap' }}><b style={{ color: T.ink, fontWeight: 600 }}>{fmtS(Number(x.waitUs))}</b> · {(Number(x.share) * 100).toFixed(1)}%{Number(x.count) > 0 ? ` · ${fmtCount(Number(x.count))} 次 · 均 ${fmtUs(Number(x.avgUs))}` : ''}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ───────────────────────────────────────────── ⑤ Load Profile
const LP_GROUPS: string[][] = [['dbtime'], ['cpu'], ['exec'], ['logical'], ['physical'], ['walBytes', 'walWrites'], ['xacts', 'rollbacks'], ['execs'], ['tupReturned', 'tupFetched'], ['ins', 'upd', 'del'], ['tempFiles', 'tempBytes']];
const LP_GROUP_LABEL: Record<string, string> = { walBytes: 'WAL 写', xacts: '事务（提交 + 回滚）', tupReturned: '元组返回 / 取出', ins: '插入 / 更新 / 删除', tempFiles: '临时文件' };
function ratioText(r: number | null): { t: string; tone: Tone } {
  if (r === null || r === undefined) return { t: '—', tone: 'flat' };
  if (Math.abs(r - 1) < 0.1) return { t: `${r >= 1 ? '+' : '−'}${Math.abs(Math.round((r - 1) * 100))}%`, tone: 'flat' };
  if (r >= 1.5) return { t: `×${r >= 10 ? r.toFixed(0) : r.toFixed(1)}`, tone: 'bad' };
  return { t: `${r >= 1 ? '+' : '−'}${Math.abs(Math.round((r - 1) * 100))}%`, tone: r > 1 ? 'bad' : 'good' };
}
function LoadProfileCard({ c, hitWarn }: { c: any; hitWarn: boolean }) {
  const rows: any[] = c.loadProfile ?? []; const byKey = new Map<string, any>(rows.map((r) => [String(r.key), r]));
  const eff = c.efficiency ?? {}; const host = c.host ?? {};
  const th: any = { color: T.dim, fontWeight: 500, fontSize: 13, textAlign: 'right', padding: '7px 10px', borderBottom: `1px solid ${T.line}`, whiteSpace: 'nowrap' };
  const td: any = { padding: '8px 10px', borderBottom: `1px solid ${T.line}`, verticalAlign: 'top', fontSize: 13.5, textAlign: 'right', whiteSpace: 'nowrap', ...tnum };
  const cell = (keys: string[], f: (r: any) => string) => keys.map((k) => byKey.get(k)).filter(Boolean).map(f).join(' · ');
  const E = ({ l, v, s, bad }: { l: string; v: string; s?: string; bad?: boolean }) => (
    <div style={{ background: T.fill, borderRadius: 8, padding: '8px 14px', fontSize: 13, color: T.sub, minWidth: 150 }}>{l}<b style={{ display: 'block', fontSize: 18, fontWeight: 600, color: bad ? T.sev.warn.c : T.ink, ...tnum }}>{v}</b>{s}</div>
  );
  return (
    <div style={{ ...card, padding: '0 0 14px' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead><tr><th style={{ ...th, textAlign: 'left', paddingLeft: 20 }}>指标</th><th style={th}>每秒</th><th style={th}>每事务</th><th style={th}>窗口合计</th><th style={th}>上一窗口 / 秒</th><th style={th}>变化</th></tr></thead>
          <tbody>
            {LP_GROUPS.filter((g) => g.some((k) => byKey.has(k))).map((g) => {
              const first = byKey.get(g[0]); const rt = ratioText(first.ratio === null || first.ratio === undefined ? null : Number(first.ratio));
              // 事务行：每秒/每事务/上窗只看事务数，回滚只在合计列以「回滚 N」附注（AWR 习惯）
              const rateKeys = g[0] === 'xacts' ? [g[0]] : g;
              const totalOf = (r: any) => (r.key === 'rollbacks' ? `回滚 ${fmtLp(String(r.unit), Number(r.total))}` : fmtLp(String(r.unit), Number(r.total)));
              return (
                <tr key={g[0]}>
                  <td style={{ ...td, textAlign: 'left', paddingLeft: 20 }}>{LP_GROUP_LABEL[g[0]] ?? String(first.label)}</td>
                  <td style={td}>{cell(rateKeys, (r) => fmtLp(String(r.unit), Number(r.perSec)))}</td>
                  <td style={td}>{g[0] === 'xacts' ? '—' : cell(rateKeys, (r) => fmtLp(String(r.unit), Number(r.perTxn)))}</td>
                  <td style={td}>{cell(g, totalOf)}</td>
                  <td style={td}>{cell(rateKeys, (r) => (r.prevPerSec === null || r.prevPerSec === undefined ? '—' : fmtLp(String(r.unit), Number(r.prevPerSec))))}</td>
                  <td style={{ ...td, color: TONE_COLOR[rt.tone] }}>{rt.t}</td>
                </tr>
              );
            })}
            <tr><td style={{ ...td, textAlign: 'left', paddingLeft: 20, borderBottom: 'none' }}>会话（backends）</td><td style={{ ...td, borderBottom: 'none' }}>—</td><td style={{ ...td, borderBottom: 'none' }}>—</td><td style={{ ...td, borderBottom: 'none' }}>{Number(c.summary?.backends ?? 0)}</td><td style={{ ...td, borderBottom: 'none' }}>—</td><td style={{ ...td, borderBottom: 'none' }}>—</td></tr>
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12, padding: '0 20px' }}>
        <E l="缓存命中率" v={`${(Number(eff.hitRatio ?? 1) * 100).toFixed(2)}%`} s={hitWarn ? '低于阈值' : '窗口内 blks 命中'} bad={hitWarn} />
        <E l="CPU / DB Time" v={`${(Number(eff.cpuShare ?? 0) * 100).toFixed(1)}%`} s={Number(eff.cpuShare ?? 0) < 0.5 ? '等待型负载' : 'CPU 型负载'} />
        <E l="执行 / DB Time" v={`${(Number(eff.execShare ?? 0) * 100).toFixed(1)}%`} />
        <E l="回滚率" v={`${(Number(eff.rollbackRatio ?? 0) * 100).toFixed(2)}%`} s={`${Number(byKey.get('rollbacks')?.total ?? 0).toLocaleString()} / ${Number(byKey.get('xacts')?.total ?? 0).toLocaleString()}`} />
        {eff.p80Ms !== null && eff.p80Ms !== undefined ? <E l="响应 p80 / p95" v={`${Number(eff.p80Ms)} / ${Number(eff.p95Ms)} ms`} s="statement 分位" /> : null}
        {Number(host.cores ?? 0) > 0 ? <E l="主机负载" v={`${Number(host.load)} / ${Number(host.cores)} 核`} s={`${(Number(host.load) / Number(host.cores)).toFixed(2)} / 核 · CPU 忙 ${Number(host.busyPct)}%`} /> : null}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────── ⑥ Top SQL
const SORT_DIMS: { key: string; label: string; of: (s: any) => number }[] = [
  { key: 'elapsed', label: '总耗时', of: (s) => Number(s.elapsedUs) },
  { key: 'cpu', label: 'CPU 时间', of: (s) => Number(s.cpuMs) },
  { key: 'io', label: 'IO 时间', of: (s) => Number(s.ioMs) },
  { key: 'calls', label: '执行次数', of: (s) => Number(s.calls) },
  { key: 'rows', label: '返回行数', of: (s) => Number(s.rowsRet) },
  { key: 'blocks', label: '逻辑读', of: (s) => Number(s.blocks) },
  { key: 'spill', label: '下盘', of: (s) => Number(s.spillBytes) },
];
function TopSqlCard({ c, notes, initialHideProbes }: { c: any; notes: Map<string, string>; initialHideProbes: boolean }) {
  const [dim, setDim] = useState('elapsed');
  const [hideProbes, setHideProbes] = useState(initialHideProbes);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const all: any[] = c.topSql ?? [];
  const probes = all.filter((s) => s.probe === true);
  const sorter = SORT_DIMS.find((d) => d.key === dim) ?? SORT_DIMS[0];
  const items = useMemo(() => all.filter((s) => !(hideProbes && s.probe === true)).slice().sort((a, b) => sorter.of(b) - sorter.of(a)), [all, hideProbes, dim]);
  const maxShare = Math.max(...items.map((s) => Number(s.share)), 1e-9);
  const totalUs = Number(c.topSqlTotalUs ?? 0);
  const shown = items.slice(0, 20);
  const th: any = { color: T.dim, fontWeight: 500, fontSize: 13, textAlign: 'left', padding: '7px 8px', borderBottom: `1px solid ${T.line}`, whiteSpace: 'nowrap' };
  const td: any = { padding: '8px 8px', borderBottom: `1px solid ${T.line}`, verticalAlign: 'top', fontSize: 13.5 };
  const tdr: any = { ...td, textAlign: 'right', whiteSpace: 'nowrap', ...tnum };
  return (
    <div style={{ ...card, padding: '14px 0 6px' }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 13, marginBottom: 10, alignItems: 'center', padding: '0 20px' }}>
        排序：{SORT_DIMS.map((d) => (
          <button key={d.key} type="button" onClick={() => setDim(d.key)} style={{ font: 'inherit', fontSize: 13, border: `1px solid ${dim === d.key ? T.blue : T.line}`, borderRadius: 6, padding: '1px 10px', color: dim === d.key ? '#fff' : T.sub, background: dim === d.key ? T.blue : '#fff', cursor: 'pointer', fontWeight: dim === d.key ? 500 : 400 }}>{d.label}</button>
        ))}
        <span style={{ marginLeft: 8, color: T.dim }}>归因：tmp=有下盘 · cpu=cpu 占自身 ≥50% · io=物理读占自身 ≥30% · blk=耗时高而 cpu/io 双 &lt;5%（等待型）· 混合=都没过线</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead><tr><th style={{ ...th, paddingLeft: 20 }}>#</th><th style={th}>SQL</th><th style={th}>归因</th><th style={{ ...th, textAlign: 'right' }}>总耗时 · 占窗口</th><th style={{ ...th, textAlign: 'right' }}>次数</th><th style={{ ...th, textAlign: 'right' }}>单次</th><th style={{ ...th, textAlign: 'right' }}>cpu · io（占自身）</th><th style={{ ...th, textAlign: 'right' }}>逻辑读 · 命中</th><th style={{ ...th, textAlign: 'right' }}>下盘</th><th style={th} /></tr></thead>
          <tbody>
            {shown.map((s, i) => {
              const id = String(s.sqlId); const b = ATTR_BADGE[String(s.attr)] ?? ATTR_BADGE.other; const isOpen = open[id] === true; const note = notes.get(id) ?? '';
              const dimVal = dim !== 'elapsed' ? `${sorter.label} ${dim === 'calls' || dim === 'rows' || dim === 'blocks' ? fmtCount(sorter.of(s)) : dim === 'spill' ? fmtBytes(sorter.of(s)) : fmtS(sorter.of(s) * 1000)}` : '';
              return (
                <FragmentRow key={id}>
                  <tr onClick={() => setOpen({ ...open, [id]: !isOpen })} style={{ cursor: 'pointer', background: isOpen ? T.fill : undefined }}>
                    <td style={{ ...td, paddingLeft: 20, ...tnum }}>{i + 1}</td>
                    <td style={{ ...td, minWidth: 260 }}>
                      <div style={{ font: `12.5px ${mono}`, color: T.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 360 }}>{oneLine(String(s.text))}</div>
                      <div style={{ fontSize: 12, color: T.dim }}>{id}{s.probe === true ? ' · 连接探针' : ''}{dimVal !== '' ? ` · ${dimVal}` : ''}{isOpen ? ' ▾ 已展开' : ''}</div>
                    </td>
                    <td style={td}><span style={{ font: `600 11.5px ${mono}`, borderRadius: 4, padding: '1px 7px', whiteSpace: 'nowrap', color: b.c, background: b.bg }}>{b.t}</span></td>
                    <td style={tdr}><b>{fmtS(Number(s.elapsedUs))}</b> · {(Number(s.share) * 100).toFixed(1)}%<div style={{ height: 6, borderRadius: 3, background: T.fill2, marginTop: 4, width: 120, marginLeft: 'auto' }}><i style={{ display: 'block', height: '100%', borderRadius: 3, background: T.blue, width: `${Math.max(1, (Number(s.share) / maxShare) * 100)}%`, fontStyle: 'normal' }} /></div></td>
                    <td style={tdr}>{fmtCount(Number(s.calls))}</td>
                    <td style={tdr}>{fmtMs(Number(s.avgMs))}</td>
                    <td style={tdr}>{Number(s.cpuPct)}% · {Number(s.ioPct)}%</td>
                    <td style={tdr}>{fmtCount(Number(s.blocks))} · {Number(s.hitPct)}%</td>
                    <td style={tdr}>{Number(s.spillBytes) > 0 ? fmtBytes(Number(s.spillBytes)) : '—'}</td>
                    <td style={td} onClick={(e) => e.stopPropagation()}><DigLink prompt={sqlDigPrompt(c, s, note)} label="深挖" /></td>
                  </tr>
                  {isOpen ? (
                    <tr><td colSpan={10} style={{ padding: '0 20px 8px 44px', borderBottom: `1px solid ${T.line}` }}>
                      <div style={{ background: T.fill, borderRadius: 10, padding: '12px 14px', fontSize: 13.5 }}>
                        <div style={{ fontSize: 12.5, color: T.dim }}>原 SQL（快照记录文本，参数为 ? 占位）</div>
                        <div style={{ font: `12.5px/1.7 ${mono}`, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: T.ink, background: '#fff', borderRadius: 8, padding: '10px 12px', margin: '6px 0 10px' }}>{String(s.text)}</div>
                        <div style={{ fontSize: 12.5, color: T.dim, ...tnum }}>窗口内：{fmtCount(Number(s.calls))} 次 × 均 {fmtMs(Number(s.avgMs))} · CPU {fmtS(Number(s.cpuMs) * 1000)} · IO {fmtS(Number(s.ioMs) * 1000)} · 逻辑读 {fmtCount(Number(s.blocks))}（命中 {Number(s.hitPct)}%）· 返回 {fmtCount(Number(s.rowsRet))} 行{Number(s.spillBytes) > 0 ? ` · 下盘 ${fmtBytes(Number(s.spillBytes))}` : ''} · 归因 {b.t}</div>
                        <div style={{ marginTop: 6 }}><b style={{ fontWeight: 500 }}>解读（模型）</b>：{note !== '' ? note : <span style={{ color: T.dim }}>{s.probe === true ? '连接探针（采集器心跳），无需处理' : '本条未被解读（超出任务 topN 或报告未提交）'}</span>}</div>
                        <div style={{ marginTop: 6, display: 'flex', gap: 14, justifyContent: 'flex-end' }}><CopyLink text={String(s.text)} label="复制 SQL" /><DigLink prompt={sqlDigPrompt(c, s, note)} label="在会话里深挖" /></div>
                      </div>
                    </td></tr>
                  ) : null}
                </FragmentRow>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '8px 20px 0', fontSize: 12.5, color: T.dim, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <span>占窗口 = 该 SQL 耗时增量 / 窗口内全部 SQL 耗时增量（{fmtS(totalUs)}，{fmtCount(Number(c.topSqlCount ?? all.length))} 条）· 显示 {shown.length} 条合计 {(shown.reduce((acc, s) => acc + Number(s.share), 0) * 100).toFixed(1)}%</span>
        {probes.length > 0 ? <span>· 连接探针（version / current_user 等）{probes.length} 条、{fmtCount(probes.reduce((acc, s) => acc + Number(s.calls), 0))} 次，来自采集器心跳 <Link onClick={() => setHideProbes(!hideProbes)}>{hideProbes ? '显示探针' : '隐藏探针'}</Link></span> : null}
      </div>
    </div>
  );
}
function FragmentRow({ children }: { children: any }) { return <>{children}</>; }

// ───────────────────────────────────────────── ⑦ IO / Checkpoint / 主机
function Mini({ rows }: { rows: [string, any][] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: '8px 14px', fontSize: 13, marginTop: 6 }}>
      {rows.map(([l, v]) => <div key={l} style={{ display: 'contents' }}><span style={{ color: T.dim, whiteSpace: 'nowrap' }}>{l}</span><span style={{ fontWeight: 600, textAlign: 'right', ...tnum }}>{v}</span></div>)}
    </div>
  );
}
function IoCard({ c }: { c: any }) {
  const io = c.io ?? {};
  return (
    <div style={card}>
      <H2 tight hint="窗口增量">IO 与 WAL</H2>
      <Mini rows={[
        ['数据文件读', `${fmtCount(Number(io.fileReads))} 次 · 均 ${fmtUs(Number(io.readAvgUs))}`],
        ['数据文件写', `${fmtCount(Number(io.fileWrites))} 次 · 均 ${fmtUs(Number(io.writeAvgUs))}`],
        ['WAL 写', `${fmtCount(Number(io.walWrites))} 次 · ${fmtBytes(Number(io.walBytes))}`],
        ['WAL 写延迟', `均 ${fmtUs(Number(io.walAvgUs))} · 累计最慢 ${fmtUs(Number(io.walMaxUs))}`],
        ['双写文件写', `${fmtCount(Number(io.dwWrites))} 次`],
        ['缓冲区文件（下盘）', <span style={{ color: Number(io.bufFileWrites) > 0 ? T.sev.warn.c : undefined }}>{Number(io.bufFileWrites) > 0 || Number(io.bufFileReads) > 0 ? `写 ${fmtCount(Number(io.bufFileWrites))} · 读 ${fmtCount(Number(io.bufFileReads))}` : '无'}</span>],
      ]} />
    </div>
  );
}
function CkptCard({ c }: { c: any }) {
  const k = c.ckpt ?? {}; const ck = Number(k.timed) + Number(k.req); const share = ck > 0 ? Number(k.req) / ck : 0;
  const level = share >= 0.5 ? 'warn' : share >= 0.3 ? 'notice' : 'ok';
  return (
    <div style={card}>
      <H2 tight hint="bgwriter 增量">Checkpoint 与脏页</H2>
      <Mini rows={[
        ['定时 / 被动 checkpoint', `${Number(k.timed)} / ${Number(k.req)}`],
        ['checkpoint 刷脏', `${fmtCount(Number(k.bufCkpt))} 块 · ${fmtBytes(Number(k.bufBytes))}`],
        ['write / sync 用时', `${Number(k.writeMs).toLocaleString()} / ${Number(k.syncMs).toLocaleString()} ms`],
        ['bgwriter 清理 / backend 自刷', `${fmtCount(Number(k.bufClean))} / ${fmtCount(Number(k.bufBackend))}`],
        ['上一窗口', k.prev !== undefined && k.prev !== null ? `${Number(k.prev.timed)} 定时 · ${Number(k.prev.req)} 被动 · ${fmtCount(Number(k.prev.bufCkpt))} 块` : '—'],
        ['判定', <Chip level={level} small>{ck === 0 ? '窗口内无 checkpoint' : level === 'ok' ? `正常 · 被动 ${Math.round(share * 100)}%` : `被动 checkpoint ${Math.round(share * 100)}% · WAL 压力`}</Chip>],
      ]} />
    </div>
  );
}
function HostCard({ c }: { c: any }) {
  const h = c.host ?? {}; const mem = h.mem ?? {}; const cores = Number(h.cores ?? 0);
  const perCore = cores > 0 ? Number(h.load) / cores : 0;
  const level = perCore >= 1 || Number(h.busyPct) >= 80 ? 'warn' : perCore >= 0.7 || Number(h.busyPct) >= 60 ? 'notice' : 'ok';
  return (
    <div style={card}>
      <H2 tight hint="os_runtime 增量">主机</H2>
      <Mini rows={[
        ['负载 load', cores > 0 ? `${Number(h.load)} · ${perCore.toFixed(2)} / 核` : String(Number(h.load ?? 0))],
        ['CPU 忙', `${Number(h.busyPct)}%（user ${Number(h.userPct)} · sys ${Number(h.sysPct)}）`],
        ['iowait', `${Number(h.iowaitPct)}%`],
        ['CPU / 内存', `${cores} 核 · ${fmtBytes(Number(h.memBytes ?? 0))}`],
        ['数据库内存', Object.keys(mem).length > 0 ? `shared ${fmtBytes(Number(mem.shared_used_memory ?? 0))} · 进程 ${fmtBytes(Number(mem.process_used_memory ?? 0))}` : '—'],
        ['判定', <Chip level={level} small>{level === 'ok' ? '主机未饱和 · 瓶颈在 SQL' : level === 'notice' ? '主机偏忙' : '主机接近饱和'}</Chip>],
      ]} />
    </div>
  );
}

// ───────────────────────────────────────────── ⑧ 发现（含通过项）
function ChecksCard({ c, notes }: { c: any; notes: Map<string, string> }) {
  const rows: any[] = ((c.checks ?? []) as any[]).slice().sort((a, b) => (ORDER[String(b.level)] ?? 0) - (ORDER[String(a.level)] ?? 0));
  return (
    <div style={{ ...card, padding: '4px 20px' }}>
      {rows.map((ck, i) => {
        const lv = String(ck.level); const note = notes.get(String(ck.code)) ?? '';
        return (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '8px 150px minmax(0,1fr) 190px 110px', gap: 12, alignItems: 'start', padding: '10px 0', borderTop: i === 0 ? 'none' : `1px solid ${T.line}`, fontSize: 14 }}>
            <i style={{ width: 8, height: 8, borderRadius: 4, marginTop: 9, background: sev(lv).c, fontStyle: 'normal' }} />
            <span style={keyChip}>{String(ck.code)}</span>
            <div style={{ minWidth: 0 }}>{String(ck.detail)}
              {String(ck.evidence ?? '') !== '' ? <div style={{ fontSize: 12.5, color: T.dim, fontFamily: mono }}>evidence：{String(ck.evidence)}</div> : null}
              {note !== '' ? <div style={{ fontSize: 13.5, color: T.sub, marginTop: 2 }}>解读：{note}</div> : null}
            </div>
            <div style={{ fontSize: 12.5, color: T.dim, ...tnum }}>实测 <b style={{ color: lv === 'ok' ? T.ink : sev(lv).c }}>{fmtCheckNum(String(ck.code), String(ck.value))}</b> · 阈值 {fmtCheckNum(String(ck.code), String(ck.threshold))}</div>
            <span>{lv !== 'ok' ? <DigLink prompt={checkDigPrompt(c, ck, note)} label="在会话里深挖" /> : null}</span>
          </div>
        );
      })}
    </div>
  );
}

// ───────────────────────────────────────────── 其他：历史 / 旧版
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
        <span>{String(cells[0]?.firedAt ?? '').slice(5, 10)}</span><span>最新 ▲ · 点格子查看当次报告 · 每格 = 一个快照窗口</span>
      </div>
    </div>
  );
}
/** 旧版报告（R2 前，无采集存档）：只把模型叙述摆出来，提示重新运行 */
function LegacyView({ data }: { data: any }) {
  const findings: any[] = data?.findings ?? []; const top: any[] = data?.topSql ?? [];
  return (
    <>
      <div style={{ fontSize: 13.5, color: T.sev.notice.c, background: T.sev.notice.soft, borderRadius: 8, padding: '8px 14px', marginBottom: 12 }}>这份报告由旧版生成（没有采集存档），只能显示模型叙述；重新运行任务后即为 WDR 窗口大盘。</div>
      {findings.filter((f) => String(f.level) !== 'ok').map((f, i) => <div key={i} style={{ ...card, borderLeft: `3px solid ${sev(String(f.level)).c}`, marginBottom: 8, fontSize: 14 }}><span style={keyChip}>{String(f.code)}</span> {String(f.detail)}</div>)}
      {top.map((s, i) => <div key={i} style={{ ...card, marginBottom: 8 }}><div style={{ fontFamily: mono, fontSize: 13 }}>sql {String(s.sqlId)} · {String(s.attr)} · {Number(s.elapsedMs ?? 0).toLocaleString()} ms</div>{String(s.note ?? '') !== '' ? <div style={{ fontSize: 14, color: T.sub, marginTop: 4 }}>{String(s.note)}</div> : null}</div>)}
      {String(data?.rootCause ?? '') !== '' ? <div style={{ ...card, background: T.fill, border: 'none', fontSize: 15, color: T.sub }}>{String(data.rootCause)}</div> : null}
    </>
  );
}

// ───────────────────────────────────────────── 面板
export function WdrPanel({ task, runId, call }: { task: any; runId?: string; call: (endpoint: string, payload?: unknown) => Promise<any> }) {
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
  const c = current?.collect;
  const sqlNotes = useMemo(() => new Map<string, string>(((data?.topSql ?? []) as any[]).map((s) => [String(s.sqlId), String(s.note ?? '')])), [data]);
  const checkNotes = useMemo(() => new Map<string, string>(((data?.findings ?? []) as any[]).map((f) => [String(f.code), String(f.note ?? '')])), [data]);

  if (error !== '') return <div style={{ fontSize: 16, color: T.dim, padding: 16 }}>加载失败：{error}</div>;
  if (current === undefined) return <div style={{ fontSize: 16, color: T.dim, padding: 16 }}>还没有 WDR 窗口报告——任务触发后（cron 或在会话里说一声）报告会出现在这里。</div>;

  const worst = String(c?.det?.worst ?? data?.det?.worst ?? 'ok');
  if (c === undefined || String(c.scope) !== 'wdr-window' || Number(c.version ?? 1) < 2) {
    return (
      <div style={{ fontFamily: FONT, color: T.ink, lineHeight: 1.75 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}><span style={{ fontSize: 18, fontWeight: 600, color: sev(worst).c }}>窗口态势：{sev(worst).cn}</span><span style={{ fontSize: 14, color: T.sub }}>{String(current.report?.summary ?? '')}</span></div>
        {data !== undefined ? <LegacyView data={data} /> : null}
        <H2 hint="一格一次运行 · 点格子查看当次报告">检查历史</H2>
        <RunStrip runs={runs} selId={String(current.id)} onSel={setSelId} />
      </div>
    );
  }

  const w = c.window ?? {}; const pw = c.prevWindow;
  const hitWarn = ((c.checks ?? []) as any[]).some((k) => String(k.code) === 'WDR_CACHE_LOW' && String(k.level) !== 'ok');
  const when = String(c.collectedAt ?? current.firedAt ?? '');
  const priorities: any[] = data?.priorities ?? [];

  return (
    <div style={{ fontFamily: FONT, color: T.ink, lineHeight: 1.75 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontSize: 18, fontWeight: 600, color: sev(worst).c }}>窗口态势：{sev(worst).cn}</span>
        <Chip level="ok">✓ 全部数字来自快照增量直读 · 归因由脚本判定 · 模型只做解读</Chip>
        <span style={{ fontSize: 13.5, color: T.dim }}>{String(c.node)} · 采集 {mmddhhmm(when)}{String(c.nativeReport ?? '').startsWith('原生 WDR 可留底') ? ` · 原生 WDR 可留底（DBA 执行 generate_wdr_report(${Number(w.beginSnap)}, ${Number(w.endSnap)})）` : ''}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: T.dim, marginBottom: 14, flexWrap: 'wrap' }}>
        分析窗口 <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${T.line}`, borderRadius: 8, padding: '3px 10px', color: T.ink, background: '#fff' }}><b>snap {Number(w.beginSnap)} → {Number(w.endSnap)}</b> · {mmddhhmm(String(w.beginTs ?? ''))} → {hhmm(String(w.endTs ?? ''))} · {Number(w.minutes)} 分钟</span>
        {pw !== undefined && pw !== null ? <>对比窗口 <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${T.line}`, borderRadius: 8, padding: '3px 10px', color: T.ink, background: '#fff' }}>snap {Number(pw.beginSnap)} → {Number(pw.endSnap)} · {hhmm(String(pw.beginTs ?? ''))} → {hhmm(String(pw.endTs ?? ''))} · {Number(pw.minutes)} 分钟</span></> : <span>无上一窗口（这是最早的快照对）</span>}
        <span>快照每小时自动产生 · 换窗口在会话里说一句（"看 14 点到 15 点"）· 摘要卡里的箭头 = 与对比窗口相比</span>
      </div>
      {String(current.report?.summary ?? data?.situation ?? '') !== '' ? <div style={{ fontSize: 15, color: T.sub, marginBottom: 12 }}>{String(data?.situation ?? '') !== '' ? String(data.situation) : String(current.report?.summary ?? '')}</div> : null}
      <Stats s={c.summary ?? {}} hitWarn={hitWarn} />

      <H2 hint={`最近 ${(c.trend ?? []).length} 个快照窗口的平均活跃会话（AAS = ΔDB Time / 窗口时长）· 按 CPU / IO / 其他等待分解${Number(c.host?.cores ?? 0) > 0 ? ` · 参考：CPU 核数 ${Number(c.host.cores)}（AAS 超过核数 = 饱和）` : ''}`}>负载趋势</H2>
      <TrendCard c={c} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 12, marginTop: 12 }}>
        <BreakdownCard c={c} />
        <WaitsCard c={c} />
      </div>

      <H2 hint="AWR 式 · 每秒 / 每事务 / 窗口合计 · 最后两列 = 上一窗口每秒值与变化">Load Profile</H2>
      <LoadProfileCard c={c} hitWarn={hitWarn} />

      <H2 hint="窗口增量 · 按维度排序（同一批 SQL，换排序不换口径）· 归因徽章由脚本按纪律判定 · 点行展开 SQL 与解读">Top SQL</H2>
      <TopSqlCard c={c} notes={sqlNotes} initialHideProbes={task?.config?.hideProbes === true} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, marginTop: 12 }}>
        <IoCard c={c} /><CkptCard c={c} /><HostCard c={c} />
      </div>

      <H2 hint="阈值判定 · 级别由脚本产出，不可被解读下调 · 每条可直接深挖">发现</H2>
      <ChecksCard c={c} notes={checkNotes} />

      {(String(data?.rootCause ?? '') !== '' || priorities.length > 0) ? (
        <>
          <H2 hint="模型解读 · 引用的数字均有出处">根因串联与处置优先级</H2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 12 }}>
            {String(data?.rootCause ?? '') !== '' ? <div style={{ ...card, background: T.fill, border: 'none' }}><div style={{ fontSize: 13.5, color: T.dim, fontWeight: 500, marginBottom: 4 }}>根因串联</div><div style={{ fontSize: 15, color: T.sub }}>{String(data.rootCause)}</div></div> : null}
            {priorities.length > 0 ? (
              <div style={card}><div style={{ fontSize: 13.5, color: T.dim, fontWeight: 500, marginBottom: 4 }}>处置优先级</div>
                <Priorities items={priorities} />
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      <H2 hint="一格一次运行 · 点格子查看当次报告">检查历史</H2>
      <RunStrip runs={runs} selId={String(current.id)} onSel={setSelId} />

      <div style={{ fontSize: 13.5, color: T.dim, border: `1px dashed ${T.line}`, borderRadius: 8, padding: '8px 14px', marginTop: 16 }}>
        📋 采集说明：快照每小时自动产生（enable_wdr_snapshot）· 等待事件按非空闲类汇总，STATUS 类剔除 · Top SQL 取 end 快照累计耗时前 300 与累计次数前 100 的增量 · {String(c.nativeReport ?? '')}
        {[...(c.collectionNotes ?? []), ...(data?.collectionNotes ?? [])].map((n: any, i: number) => <div key={i}>{String(n)}</div>)}
      </div>
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
  registerPanel('wdr', WdrPanel);
}
