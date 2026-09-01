/**
 * task-rules client 面板 R1（2026-08-31，user 通过 docs/prototypes/rules-r1.html）：
 * 平台确定性判定层的手册——概览四卡 → 搜索/筛选 → 按插件分组的规则表（级别阶梯彩色档位 ·
 * 可调阈值 · 近 30 天命中 N/M 次）→ 点开看判据来源、阈值当前值与改动理由、最近一次命中原文。
 *
 * 规则本体来自代码内目录快照（catalog.ts，纯静态，无网络也能看）；
 * 命中统计与阈值当前值来自 /opendb-rules 的 stats 端点（只读采集存档 + 阈值服务），取不到就整页降级成静态目录。
 */
import { Component, useEffect, useMemo, useState } from 'react';
import { rulesCatalog, codesOf, tuneRulesOf, type RuleGroup, type RuleRow } from '../catalog.ts';
import { T, FONT, mono, tnum, card, PLUGIN_COLOR, PLUGIN_CN, fmtThreshold, mmdd } from './format.ts';

export const inject = ['slots', 'connection'];

let clientCtx: any;

interface RuleStat { code: string; hit: number; worst: string; lastAt: string | null; lastText: string }
interface PluginStat { plugin: string; runs: number; rules: RuleStat[] }
interface Threshold {
  plugin: string; key: string; rule: string; label: string; unit: string; cmp: string;
  default: number; current: number; overridden: boolean; updatedAt: string | null; updatedBy: string; reason: string;
  updatedIn: string;   // 改动发生在哪个会话（标题；服务里存的是 session id）
}

const CMP: Record<string, string> = { '>=': '≥', '<=': '≤', '>': '>', '<': '<' };
interface Stats { days: number; plugins: PluginStat[]; unregistered: { plugin: string; code: string; hit: number }[]; thresholds: Threshold[] }

class Boundary extends Component<{ children: any }, { err?: string }> {
  state: { err?: string } = {};
  static getDerivedStateFromError(e: unknown) { return { err: String((e as Error)?.message ?? e) }; }
  render() { return this.state.err !== undefined ? <div style={{ fontSize: 14, color: T.sev.critical.c, padding: 12 }}>规则目录渲染失败：{this.state.err}</div> : this.props.children; }
}

// ───────────────────────────────────────────── 小件
function H1({ total }: { total: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 2 }}>
      <span style={{ fontSize: 20, fontWeight: 600 }}>平台规则目录</span>
      <span style={{ display: 'inline-flex', gap: 5, fontSize: 13, background: T.sev.ok.soft, color: T.sev.ok.c, borderRadius: 6, padding: '1px 9px', fontWeight: 500 }}>✓ 判定归脚本 · 级别不可被模型下调</span>
      <span style={{ fontSize: 13.5, color: T.dim }}>{total} 条 · 代码即真相 · 目录与实现由单测守护同步</span>
    </div>
  );
}
function Stat({ l, children, d }: { l: string; children: any; d?: any }) {
  return (
    <div style={{ background: T.fill, borderRadius: 8, padding: '11px 13px', minWidth: 0 }}>
      <div style={{ fontSize: 12.5, color: T.dim }}>{l}</div>
      {children}
      {d !== undefined ? <div style={{ fontSize: 12, color: T.dim, lineHeight: 1.55, marginTop: 2 }}>{d}</div> : null}
    </div>
  );
}
function Pill({ on, onClick, color, children }: { on: boolean; onClick: () => void; color?: string; children: any }) {
  return (
    <span onClick={onClick} style={{
      border: `1px solid ${on ? (color ?? T.blue) : T.line}`, borderRadius: 6, padding: '1px 10px', fontSize: 13,
      color: on ? '#fff' : T.sub, background: on ? (color ?? T.blue) : '#fff', cursor: 'pointer', whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}
function Step({ lv, t }: { lv: string; t: string }) {
  const s = T.sev[lv] ?? T.sev.plain;
  return <span style={{ font: `500 12px ${mono}`, borderRadius: 5, padding: '0 7px', whiteSpace: 'nowrap', background: s.soft, color: s.c }}>{t}</span>;
}
/** 命中列：固定轨道 + 命中/运行；命中率 ≥95% 转琥珀色 = 这条规则常亮 */
function Hit({ hit, runs }: { hit: number | null; runs: number }) {
  if (hit === null || runs === 0) return <span style={{ fontSize: 12.5, color: T.dim }}>—</span>;
  const r = hit / runs;
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', whiteSpace: 'nowrap' }}>
      <span style={{ width: 44, height: 6, borderRadius: 3, background: T.rest, overflow: 'hidden', flex: 'none' }}>
        <i style={{ display: 'block', height: '100%', width: `${Math.round(r * 100)}%`, background: r >= 0.95 ? T.sev.notice.c : T.blue, opacity: r >= 0.95 ? 0.85 : 0.55 }} />
      </span>
      <span style={{ fontSize: 12.5, color: hit === 0 ? T.dim : T.sub, ...tnum }}>
        {hit === 0 ? `0 / ${runs}` : <><b style={{ color: T.ink }}>{hit}</b> / {runs}</>}
      </span>
    </span>
  );
}

// ───────────────────────────────────────────── 行与详情
interface Row { row: RuleRow; group: RuleGroup; codes: string[]; hit: number | null; runs: number; last: RuleStat | undefined; tune: Threshold[]; gap: boolean }

function Detail({ r }: { r: Row }) {
  const edited = r.tune.filter((t) => t.overridden);
  const always = r.hit !== null && r.runs > 0 && r.hit / r.runs >= 0.95;
  const box: any = { fontSize: 12.5, borderRadius: 6, padding: '5px 9px', marginTop: 8, lineHeight: 1.6, background: T.sev.notice.soft, color: T.sev.notice.c };
  return (
    <tr>
      <td colSpan={7} style={{ background: '#fbfcfd', borderBottom: `1px solid ${T.line}`, padding: '10px 12px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(250px,1fr))', gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, color: T.dim }}>判据来源</div>
            <div style={{ fontSize: 13.5, lineHeight: 1.65 }}>{r.row.from}</div>
            <div style={{ fontSize: 12, color: T.dim, marginTop: 10 }}>出现在</div>
            <div style={{ fontSize: 13.5, lineHeight: 1.65 }}>
              {PLUGIN_CN[r.group.plugin] ?? r.group.plugin}报告 · {r.group.plugin === 'sqlreview' ? '违规清单与逐条分析卡' : r.group.plugin === 'ddl' ? '「规范扫描」区块（含通过项）' : '「发现」区块'}
            </div>
            {always ? <div style={box}>⚠ 近 {r.hit}/{r.runs} 次运行都命中——常亮的发现会淹没真问题，建议复议阈值或确认这是长期现状。</div> : null}
            {r.gap ? <div style={box}>⚠ 采集存档里出现过这个规则码，但目录（catalog.ts）没登记——补进目录后这行会自动归位。</div> : null}
          </div>
          <div>
            <div style={{ fontSize: 12, color: T.dim }}>阈值（可在「平台阈值配置」改数字）</div>
            {r.tune.length === 0
              ? <div style={{ fontSize: 13.5, color: T.dim, lineHeight: 1.65 }}>本规则没有可调数字（判定为布尔或结构性条件）</div>
              : r.tune.map((t) => (
                <div key={t.key} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 13, padding: '2px 0' }}>
                  <b style={{ font: `600 12px ${mono}`, color: T.sub }}>{t.key}</b>
                  {t.overridden
                    ? <><span style={{ color: T.dim }}>默认 {fmtThreshold(t.default, t.unit)} →</span><span style={{ color: '#b26a00', fontWeight: 600 }}>当前 {fmtThreshold(t.current, t.unit)}</span></>
                    : <span style={{ color: T.dim }}>{fmtThreshold(t.current, t.unit)}（代码默认值）</span>}
                </div>
              ))}
            {edited.map((t) => (
              <div key={`${t.key}-why`} style={{ fontSize: 12.5, color: T.sub, marginTop: 6, lineHeight: 1.6 }}>
                改动：{t.updatedAt === null ? '' : `${mmdd(t.updatedAt)} · `}
                {t.updatedIn !== '' ? `会话「${t.updatedIn}」` : t.updatedBy}
                <br />理由：{t.reason === '' ? '（未填）' : t.reason}
              </div>
            ))}
          </div>
          <div>
            <div style={{ fontSize: 12, color: T.dim }}>最近一次命中长这样</div>
            <div style={{ font: `12.5px/1.7 ${mono}`, background: '#fff', border: `1px solid ${T.line}`, borderRadius: 7, padding: '8px 11px', color: T.sub, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {r.last === undefined || r.last.lastText === ''
                ? (r.hit === null ? '标注 / 纪律类条目，不单独计命中' : '近期未触发——存档里没有这条规则的命中记录')
                : `${r.last.lastAt === null ? '' : `${mmdd(r.last.lastAt)} · `}${r.last.lastText}`}
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}

// ───────────────────────────────────────────── 主面板
export function RulesPanel(_props: { task: any; call: (endpoint: string, payload?: unknown) => Promise<any> }) {
  const groups = useMemo(() => rulesCatalog(), []);
  const [stats, setStats] = useState<Stats | null>(null);
  const [statErr, setStatErr] = useState('');
  const [q, setQ] = useState('');
  const [plugin, setPlugin] = useState('');
  const [lv, setLv] = useState<Set<string>>(new Set());
  const [onlyTune, setOnlyTune] = useState(false);
  const [onlyHit, setOnlyHit] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    if (clientCtx?.connection?.rpc?.call === undefined) { setStatErr('无连接'); return; }
    clientCtx.connection.rpc.call('/opendb-rules', 'stats', { days: 30 })
      .then((r: any) => { if (!alive) return; if (r?.ok === true) setStats(r.value as Stats); else setStatErr(String(r?.error?.message ?? '取命中统计失败')); })
      .catch((e: unknown) => { if (alive) setStatErr(String((e as Error)?.message ?? e)); });
    return () => { alive = false; };
  }, []);

  // 目录行 + 活数据（命中 / 阈值），再把存档里出现过但目录没登记的码补成额外行
  const rows: Row[] = useMemo(() => {
    const statOf = new Map<string, PluginStat>((stats?.plugins ?? []).map((p) => [p.plugin, p]));
    const out: Row[] = [];
    for (const g of groups) {
      const ps = statOf.get(g.plugin);
      const runs = ps?.runs ?? 0;
      const byCode = new Map<string, RuleStat>((ps?.rules ?? []).map((r) => [r.code, r]));
      for (const row of g.rows) {
        const codes = codesOf(row);
        const hits = codes.map((c) => byCode.get(c)).filter((x): x is RuleStat => x !== undefined);
        const tuneKeys = tuneRulesOf(row);
        const tune = (stats?.thresholds ?? []).filter((t) => t.plugin === g.plugin && tuneKeys.includes(t.rule));
        out.push({
          row, group: g, codes, runs, tune, gap: false,
          hit: codes.length === 0 || stats === null ? null : hits.reduce((a, x) => a + x.hit, 0),
          last: hits.sort((a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')))[0],
        });
      }
      for (const u of (stats?.unregistered ?? []).filter((x) => x.plugin === g.plugin)) {
        const s = byCode.get(u.code);
        out.push({
          group: g, codes: [u.code], runs, hit: u.hit, last: s, tune: [], gap: true,
          row: { id: u.code, name: '（目录未登记）', from: '采集存档', desc: '存档里出现过这个规则码，但目录没有登记它——开码时补进 catalog.ts', steps: [{ lv: 'plain', t: '未登记' }] },
        });
      }
    }
    return out;
  }, [groups, stats]);

  const shown = rows.filter((r) => {
    if (plugin !== '' && r.group.plugin !== plugin) return false;
    if (lv.size > 0 && !r.row.steps.some((s) => lv.has(s.lv))) return false;
    if (onlyTune && r.tune.length === 0) return false;
    if (onlyHit && !((r.hit ?? 0) > 0)) return false;
    const s = q.trim().toLowerCase();
    if (s !== '' && !`${r.row.id} ${r.row.name} ${r.row.desc} ${r.row.from}`.toLowerCase().includes(s)) return false;
    return true;
  });

  // 概览：级别分布按每行"最高可判级别"计；常亮 = 命中率 ≥95%
  const worst = (r: Row) => r.row.steps.reduce((a, s) => (({ critical: 3, warn: 2, notice: 1, plain: 0 } as any)[s.lv] > (({ critical: 3, warn: 2, notice: 1, plain: 0 } as any)[a] ?? 0) ? s.lv : a), 'plain');
  const counts = { critical: 0, warn: 0, notice: 0 } as Record<string, number>;
  for (const r of rows) { const w = worst(r); if (counts[w] !== undefined) counts[w] += 1; }
  const tunable = new Set((stats?.thresholds ?? []).map((t) => `${t.plugin}.${t.key}`)).size;
  const edited = (stats?.thresholds ?? []).filter((t) => t.overridden);
  const always = rows.filter((r) => r.hit !== null && r.runs > 0 && r.hit / r.runs >= 0.95);
  const lvTotal = Math.max(1, counts.critical + counts.warn + counts.notice);

  const th: any = { fontSize: 12.5, color: T.dim, fontWeight: 500, textAlign: 'left', padding: '7px 12px', borderTop: `1px solid ${T.line}`, borderBottom: `1px solid ${T.line}`, background: T.fill, whiteSpace: 'nowrap' };
  const td: any = { padding: '9px 12px', borderBottom: `1px solid ${T.line}`, verticalAlign: 'top', fontSize: 13.5 };

  return (
    <Boundary>
      <div style={{ fontFamily: FONT, color: T.ink, lineHeight: 1.75 }}>
        <H1 total={rows.filter((r) => !r.gap).length} />
        <div style={{ fontSize: 14.5, color: T.sub, maxWidth: '76em', margin: '5px 0 0' }}>
          报告里每一条「发现」都出自下面这些确定性规则：命中即立发现、级别由脚本定，模型只做解读与串联。
          阈值数字是代码默认值，被改过的会标出当前生效值；右侧「近 {stats?.days ?? 30} 天命中」是这条规则在被管节点上真的响过几次——
          常年不响可能是阈值太松，每次都响多半是阈值该复议。
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(226px,1fr))', gap: 10, margin: '14px 0 6px' }}>
          <Stat l="确定性规则" d={groups.map((g) => `${PLUGIN_CN[g.plugin] ?? g.plugin} ${g.rows.length}`).join(' · ')}>
            <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.35, marginTop: 1, ...tnum }}>
              {rows.filter((r) => !r.gap).length}<small style={{ fontSize: 12.5, fontWeight: 500, color: T.dim, marginLeft: 5 }}>条 · {groups.length} 个插件</small>
            </div>
          </Stat>
          <Stat l="最高可判级别分布">
            <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', margin: '7px 0 5px' }}>
              {(['critical', 'warn', 'notice'] as const).map((k) => <i key={k} style={{ display: 'block', height: '100%', width: `${(counts[k] / lvTotal) * 100}%`, background: T.sev[k].c }} />)}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12, color: T.sub }}>
              {(['critical', 'warn', 'notice'] as const).map((k) => (
                <span key={k}><i style={{ width: 8, height: 8, borderRadius: 2, display: 'inline-block', marginRight: 4, verticalAlign: 'middle', background: T.sev[k].c }} />{k} {counts[k]}</span>
              ))}
            </div>
          </Stat>
          <Stat l="可调阈值" d={<>改在「平台阈值配置」，下次采集生效；<b>能改的只有数字</b></>}>
            <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.35, marginTop: 1, ...tnum }}>
              {tunable}<small style={{ fontSize: 12.5, fontWeight: 500, color: T.dim, marginLeft: 5 }}>项 · 已改 {edited.length}</small>
            </div>
          </Stat>
          <Stat l={`近 ${stats?.days ?? 30} 天几乎每次都命中`}
            d={<span style={{ fontFamily: mono, fontSize: 11.5 }}>{always.length === 0 ? '没有常亮的规则' : always.slice(0, 6).map((r) => r.row.id).join(' · ')}</span>}>
            <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.35, marginTop: 1, ...tnum }}>
              {always.length}<small style={{ fontSize: 12.5, fontWeight: 500, color: T.dim, marginLeft: 5 }}>条 · 建议复议阈值</small>
            </div>
          </Stat>
        </div>

        <div style={{ position: 'sticky', top: 0, background: '#fff', zIndex: 5, padding: '12px 0 10px', borderBottom: `1px solid ${T.line}`, marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <label style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${T.line}`, borderRadius: 8, padding: '5px 11px' }}>
              <span style={{ color: T.dim, fontSize: 13 }}>🔍</span>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜规则码 / 名称 / 判据，例如 DDLR、缓存、死元组、statement_history"
                style={{ border: 'none', outline: 'none', font: `14px/1.6 ${FONT}`, width: '100%', background: 'transparent', color: T.ink }} />
            </label>
            <span style={{ fontSize: 13, color: T.dim, whiteSpace: 'nowrap', ...tnum }}>{shown.length} / {rows.length} 条</span>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 9 }}>
            <span style={{ color: T.dim, fontSize: 13 }}>插件</span>
            <Pill on={plugin === ''} onClick={() => setPlugin('')}>全部</Pill>
            {groups.map((g) => <Pill key={g.plugin} on={plugin === g.plugin} color={PLUGIN_COLOR[g.plugin]} onClick={() => setPlugin(plugin === g.plugin ? '' : g.plugin)}>{PLUGIN_CN[g.plugin] ?? g.plugin}</Pill>)}
            <span style={{ color: T.dim, fontSize: 13, marginLeft: 4 }}>级别</span>
            {(['critical', 'warn', 'notice'] as const).map((k) => (
              <Pill key={k} on={lv.has(k)} color={T.sev[k].c} onClick={() => setLv(lv.has(k) ? new Set([...lv].filter((x) => x !== k)) : new Set([...lv, k]))}>{k}</Pill>
            ))}
            <span style={{ color: T.dim, fontSize: 13, marginLeft: 4 }}>只看</span>
            <Pill on={onlyTune} onClick={() => setOnlyTune(!onlyTune)}>⚙ 可调阈值</Pill>
            <Pill on={onlyHit} onClick={() => setOnlyHit(!onlyHit)}>近 {stats?.days ?? 30} 天命中过</Pill>
            {statErr !== '' ? <span style={{ fontSize: 12.5, color: T.sev.notice.c, marginLeft: 'auto' }}>命中统计与阈值当前值取不到（{statErr}）——目录本身仍是完整的</span> : null}
          </div>
        </div>

        {shown.length === 0 ? <div style={{ ...card, padding: '26px 18px', color: T.dim, fontSize: 14, textAlign: 'center' }}>没有匹配的规则——换个词，或清掉筛选</div> : null}

        {groups.map((g) => {
          const list = shown.filter((r) => r.group.plugin === g.plugin);
          if (list.length === 0) return null;
          const all = rows.filter((r) => r.group.plugin === g.plugin).length;
          const runs = list[0].runs;
          return (
            <section key={g.plugin} style={{ ...card, marginBottom: 16, overflow: 'hidden', padding: 0 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '14px 18px 12px', borderLeft: `4px solid ${PLUGIN_COLOR[g.plugin] ?? T.blue}` }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 17, fontWeight: 600 }}>{g.title}
                    <span style={{ fontSize: 12.5, color: T.dim, fontWeight: 400, marginLeft: 8 }}>
                      {list.length}{list.length !== all ? ` / ${all}` : ''} 条{runs > 0 ? ` · 近 ${stats?.days ?? 30} 天 ${runs} 次运行` : ''}
                    </span>
                  </div>
                  <div style={{ fontSize: 13.5, color: T.sub, marginTop: 2 }}>{g.intro}</div>
                </div>
                <div style={{ marginLeft: 'auto', fontSize: 12, color: T.dim, whiteSpace: 'nowrap', paddingTop: 5, fontFamily: mono }}>{g.source}</div>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <thead><tr>
                    <th style={{ ...th, width: 152 }}>规则码</th><th style={{ ...th, width: 150 }}>名称</th><th style={{ ...th, width: 270 }}>级别阶梯</th>
                    <th style={th}>判据</th><th style={{ ...th, width: 84 }}>阈值</th><th style={{ ...th, width: 126, textAlign: 'right' }}>近 {stats?.days ?? 30} 天命中</th><th style={{ ...th, width: 22 }} />
                  </tr></thead>
                  <tbody>
                    {list.map((r) => {
                      const key = `${g.plugin}:${r.row.id}`;
                      const isOpen = open.has(key);
                      return [
                        <tr key={key} onClick={() => setOpen(isOpen ? new Set([...open].filter((x) => x !== key)) : new Set([...open, key]))}
                          style={{ cursor: 'pointer', background: isOpen ? T.fill : undefined }}>
                          <td style={td}>
                            <span style={{ font: `600 11.5px ${mono}`, background: isOpen ? '#fff' : T.fill, border: `1px solid ${T.line}`, borderRadius: 5, padding: '1px 6px', color: T.sub, whiteSpace: 'nowrap' }}>{r.row.id}</span>
                            {r.gap ? <div style={{ marginTop: 4 }}><span style={{ fontSize: 11.5, borderRadius: 6, padding: '0 7px', background: T.sev.notice.soft, color: T.sev.notice.c }}>目录缺登记</span></div> : null}
                          </td>
                          <td style={{ ...td, fontWeight: 500 }}>{r.row.name}</td>
                          <td style={td}>
                            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                              {r.row.steps.map((s, i) => <Step key={i} lv={s.lv} t={s.t} />)}
                              {/* 阶梯文本是代码默认值；这条规则的阈值被改过时，把生效值并排标出来，
                                  否则页面会理直气壮地显示一个早已不生效的数字（08-25 activeSessions 50→5 实证）*/}
                              {r.tune.filter((t) => t.overridden).map((t) => (
                                <span key={t.key} style={{ font: `500 12px ${mono}`, borderRadius: 5, padding: '0 7px', whiteSpace: 'nowrap', background: '#fff3e0', color: '#b26a00' }}
                                  title={`${t.key}：代码默认 ${fmtThreshold(t.default, t.unit)}`}>
                                  当前 {CMP[t.cmp] ?? t.cmp} {fmtThreshold(t.current, t.unit)}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td style={{ ...td, color: T.sub }}>{r.row.desc}</td>
                          <td style={td}>
                            {r.tune.length === 0 ? <span style={{ color: T.dim, fontSize: 12 }}>—</span> : (
                              <span style={{ fontSize: 12, borderRadius: 5, padding: '0 7px', whiteSpace: 'nowrap', ...(r.tune.some((t) => t.overridden) ? { background: '#fff3e0', color: '#b26a00' } : { background: '#eef3ff', color: T.blue }) }}>
                                ⚙ {r.tune.length} 项{r.tune.some((t) => t.overridden) ? ' · 已改' : ''}
                              </span>
                            )}
                          </td>
                          <td style={{ ...td, textAlign: 'right' }}><Hit hit={r.hit} runs={r.runs} /></td>
                          <td style={{ ...td, textAlign: 'right', color: T.dim, fontSize: 11 }}>{isOpen ? '▾' : '▸'}</td>
                        </tr>,
                        isOpen ? <Detail key={`${key}-d`} r={r} /> : null,
                      ];
                    })}
                  </tbody>
                </table>
              </div>
              {(g.notes ?? []).length > 0 ? (
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline', padding: '9px 18px 12px', fontSize: 13, color: T.dim }}>
                  {(g.notes ?? []).map((n, i) => <span key={i}>· {n}</span>)}
                </div>
              ) : null}
            </section>
          );
        })}

        <div style={{ fontSize: 13, color: T.dim, border: `1px dashed ${T.line}`, borderRadius: 8, padding: '10px 16px', marginTop: 8, lineHeight: 1.85 }}>
          📋 <b>阈值怎么改</b>：会话里说一句「把 CONN_HIGH 的 warn 改成 0.85」，智能体复述确认后落库，下次采集起生效；改动记录与当前生效值见任务页「平台阈值配置」。
          比较方向、级别阶梯、规则语义都在代码里，<b>不随会话改</b>。<br />
          📚 <b>与客户规范的关系</b>：客户自带的规范文档进知识库，报告里作为对照引用，<b>参考不改判</b>（KB 契约）——级别永远由这张表决定。<br />
          🔒 <b>只读定位</b>：规则只产出发现与建议，平台不执行任何变更；能在库上做什么由数据库自己的授权决定。<br />
          🧮 <b>「近 {stats?.days ?? 30} 天命中」口径</b>：命中运行数 / 该插件同期产出过判定的运行数，取自采集存档（脚本结果，不是模型叙述），只计非 ok 的发现。
        </div>
      </div>
    </Boundary>
  );
}

/**
 * 注册面板：与 ui-harness 的加载顺序无关。桥已在就直接注册，否则把自己排进 __pending，
 * 由后到的 ui-harness 兑现。原先是 250ms×40 轮询，超 10 秒永久放弃——两者并发加载，
 * 慢机器上必然掉回 DefaultTaskPanel（2026-08-24 user 报障：任务页只剩一张 4 列表，进不去大盘）。
 */
function registerPanel(key: string, Comp: any): void {
  if (typeof window === 'undefined') return;
  const w = window as any;
  if (w.__opendbHarness__?.registerTaskPanel !== undefined) { w.__opendbHarness__.registerTaskPanel(key, Comp); return; }
  w.__opendbHarness__ = w.__opendbHarness__ ?? {};
  w.__opendbHarness__.__pending = [...(w.__opendbHarness__.__pending ?? []), { kind: 'task', key, comp: Comp }];
}

export function apply(ctx: any): void {
  clientCtx = ctx;   // 命中统计走 /opendb-rules，需要 connection（已列进 inject）
  registerPanel('rules', RulesPanel);
}
