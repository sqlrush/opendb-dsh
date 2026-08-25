/**
 * task-thresholds client 面板：平台阈值大盘——按插件分组，每行默认值 / 当前值 / 覆盖标记 / 判定方向；
 * 底部变更历史。只读展示（交互纲领：主区大盘无按钮，改阈值在会话里说一句）。
 * 数据经 ui-opendb 的 thresholds/list、thresholds/history 端点；内容区字号体系（16px/1.75）。
 */
import { useEffect, useState } from 'react';

export const inject = ['slots'];

const T = {
  ink: '#0f1115', sub: '#61666b', dim: '#81858c', blue: '#4176e6',
  line: 'rgba(0,0,0,.08)', fill: '#f7f8fa', blueSoft: '#e4edfd',
  sev: { notice: '#c9862d', warn: '#e07a1f', critical: '#d64545' } as Record<string, string>,
};
const card: any = { background: '#fff', border: `1px solid ${T.line}`, borderRadius: 8, padding: 0, overflow: 'hidden', boxShadow: '0 4px 12px rgba(0,0,0,.02),0 2px 8px rgba(0,0,0,.04)' };
const mono = '"JetBrains Mono","SF Mono",Menlo,monospace';
const PLUGIN_TITLE: Record<string, string> = { health: '健康检查', sqlreview: 'SQL 审核', wdr: 'WDR 窗口', ddl: 'DDL 追溯' };
const PLUGIN_ICON: Record<string, string> = { health: '🩺', sqlreview: '📝', wdr: '📊', ddl: '🕘' };

/** 与 tool-thresholds 的 fmtValue 同口径（client bundle 不能背 server 包，此处复刻） */
function fmt(v: number, unit: string): string {
  switch (unit) {
    case 'ratio': return `${Math.round(v * 10000) / 100}%`;
    case 'bytes': return v >= 1024 * 1024 ? `${Math.round(v / 1024 / 1024)}MB` : `${v}B`;
    case 'ms': return `${v}ms`;
    case 's': return `${v}s`;
    case 'hour': return `${v} 点`;
    default: return `${v}`;
  }
}
const when = (iso?: string) => (iso ? String(iso).replace('T', ' ').slice(0, 16) : '');

function Tier({ tier }: { tier?: string }) {
  if (tier === undefined) return null;
  return <span style={{ color: T.sev[tier] ?? T.sub, fontWeight: 600, fontSize: 12.5, marginLeft: 6 }}>{tier}</span>;
}

export function ThresholdsPanel({ call }: { task: any; call: (endpoint: string, payload?: unknown) => Promise<any> }) {
  const [items, setItems] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () => {
      Promise.all([call('thresholds/list', {}), call('thresholds/history', { limit: 30 })])
        .then(([l, h]) => { if (alive) { setItems(l?.items ?? []); setHistory(h?.changes ?? []); setError(''); } })
        .catch((e) => { if (alive) setError(String(e?.message ?? e)); });
    };
    load();
    const timer = setInterval(load, 20000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  if (error !== '') return <div style={{ fontSize: 16, color: T.dim, padding: 16 }}>加载失败：{error}</div>;

  const groups = new Map<string, any[]>();
  for (const it of items) groups.set(it.plugin, [...(groups.get(it.plugin) ?? []), it]);
  const overridden = items.filter((i) => i.overridden).length;
  const th: any = { color: T.dim, fontWeight: 500, fontSize: 13.5, textAlign: 'left', padding: '8px 12px', borderBottom: `1px solid ${T.line}`, whiteSpace: 'nowrap' };
  const td: any = { padding: '9px 12px', borderBottom: `1px solid ${T.line}`, verticalAlign: 'top', fontSize: 13.5 };
  const keyChip: any = { font: `600 11.5px ${mono}`, background: T.fill, border: `1px solid ${T.line}`, borderRadius: 5, padding: '1px 6px', color: T.sub };

  return (
    <div style={{ fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif', color: T.ink, lineHeight: 1.75 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontSize: 18, fontWeight: 600 }}>平台阈值 · {groups.size} 个插件 · {items.length} 个判据</span>
        <span style={{ display: 'inline-flex', gap: 6, fontSize: 13.5, background: overridden > 0 ? '#faf3e5' : '#e8f5ec', color: overridden > 0 ? T.sev.notice : '#3fa552', borderRadius: 6, padding: '3px 10px', fontWeight: 500 }}>
          {overridden > 0 ? `${overridden} 个已改动（其余为代码默认值）` : '全部为代码默认值'}
        </span>
      </div>
      <div style={{ fontSize: 16, color: T.sub, marginBottom: 8 }}>
        数值判据可在会话里改：例如「把健康检查的连接占用 warn 改成 85%」——智能体复述并确认后落库，下一次采集起生效。
        判定方向、级别阶梯与规则语义由各插件代码固定，这里只管数值。
      </div>

      {[...groups.entries()].map(([plugin, rows]) => (
        <div key={plugin} style={{ ...card, marginTop: 18 }}>
          <div style={{ padding: '14px 20px 10px', display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontSize: 18, fontWeight: 600 }}>{PLUGIN_ICON[plugin] ?? '·'} {PLUGIN_TITLE[plugin] ?? plugin}</span>
            <span style={{ fontSize: 13.5, color: T.dim }}>{rows.length} 个判据 · {rows.filter((r) => r.overridden).length} 个已改</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr><th style={th}>阈值</th><th style={th}>规则</th><th style={th}>判定</th><th style={th}>默认值</th><th style={th}>当前值</th><th style={th}>改动</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} style={r.overridden ? { background: '#fffbf2' } : undefined}>
                    <td style={td}><div style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{String(r.label).replace(/ · (notice|warn|critical)$/, '')}<Tier tier={r.tier} /></div><div style={{ marginTop: 2 }}><span style={keyChip}>{r.key}</span></div></td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}><span style={keyChip}>{r.rule}</span></td>
                    <td style={{ ...td, color: T.sub, minWidth: 180 }}><span style={{ fontFamily: mono, fontSize: 12.5 }}>{r.cmp}</span> {r.desc}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap', color: r.overridden ? T.dim : T.ink, textDecoration: r.overridden ? 'line-through' : 'none' }}>{fmt(Number(r.default), r.unit)}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap', fontWeight: r.overridden ? 700 : 400, color: r.overridden ? T.sev.warn : T.ink }}>{fmt(Number(r.current), r.unit)}</td>
                    <td style={{ ...td, color: T.dim, fontSize: 12.5 }}>{r.overridden ? <span>{when(r.updatedAt)}{r.reason ? ` · ${r.reason}` : ''}</span> : <span>—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <div style={{ ...card, marginTop: 18 }}>
        <div style={{ padding: '14px 20px 10px', fontSize: 18, fontWeight: 600 }}>变更历史 <span style={{ fontSize: 13.5, color: T.dim, fontWeight: 400 }}>最近 {history.length} 条</span></div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr><th style={th}>时间</th><th style={th}>插件</th><th style={th}>阈值</th><th style={th}>变更</th><th style={th}>原因</th><th style={th}>来源会话</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{when(h.changedAt)}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{PLUGIN_TITLE[h.plugin] ?? h.plugin}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}><span style={keyChip}>{h.key}</span></td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {h.newValue === null
                      ? <span>{h.oldValue} → <span style={{ color: '#3fa552', fontWeight: 600 }}>重置默认</span></span>
                      : <span>{h.oldValue} → <b style={{ color: T.sev.warn }}>{h.newValue}</b></span>}
                  </td>
                  <td style={{ ...td, color: T.sub }}>{h.reason || '—'}</td>
                  <td style={{ ...td, color: T.dim, fontFamily: mono, fontSize: 12 }}>{String(h.changedBy).slice(0, 16)}</td>
                </tr>
              ))}
              {history.length === 0 && <tr><td style={td} colSpan={6}><span style={{ color: T.dim }}>还没有改过任何阈值</span></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <div style={{ fontSize: 13.5, color: T.dim, border: `1px dashed ${T.line}`, borderRadius: 8, padding: '10px 16px', marginTop: 18 }}>
        📋 在会话里问「现在的阈值是多少」可得简易版（threshold_list 工具）；修改走「复述 → 确认 → 落库」，每次修改都记入上表历史。
      </div>
    </div>
  );
}

/**
 * 注册面板：与 ui-harness 的加载顺序无关。桥已在就直接注册，否则把自己排进 __pending，
 * 由后到的 ui-harness 兑现（2026-08-24 面板注册竞争根治后的统一写法）。
 */
function registerPanel(key: string, Comp: any): void {
  if (typeof window === 'undefined') return;
  const w = window as any;
  if (w.__opendbHarness__?.registerTaskPanel !== undefined) { w.__opendbHarness__.registerTaskPanel(key, Comp); return; }
  w.__opendbHarness__ = w.__opendbHarness__ ?? {};
  w.__opendbHarness__.__pending = [...(w.__opendbHarness__.__pending ?? []), { kind: 'task', key, comp: Comp }];
}

export function apply(_ctx: any): void {
  registerPanel('thresholds', ThresholdsPanel);
}
