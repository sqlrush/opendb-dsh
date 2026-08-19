/**
 * 常驻监控大盘 client 半边：实时状态大牌 + 指标水位（对照阈值）+ 24h 状态色带 + 异常榜。
 * 数据走自己的 /opendb-monitor 通道（server 半边的快照表）；10s 轮询。
 * 纲领 §15：纯展示；改阈值/停监控在会话里说。
 */
import { useEffect, useState } from 'react';

export const inject = ['connection', 'slots'];

const T = {
  dim: 'var(--dsw-alias-label-tertiary)',
  sub: 'var(--dsw-alias-label-secondary)',
  border: 'var(--dsw-alias-border-l1)',
};
const STATUS_COLOR: Record<string, string> = { ok: '#3fa552', warn: '#c9862d', critical: '#d64545' };
const STATUS_LABEL: Record<string, string> = { ok: '正常', warn: '告警', critical: '严重' };

function fmtPct(v: number): string { return `${(v * 100).toFixed(1)}%`; }

function makePanel(call: (endpoint: string, payload?: unknown) => Promise<any>) {
  return function MonitorPanel({ task }: { task: any }) {
    const [d, setD] = useState<any>(null);
    const [err, setErr] = useState('');
    useEffect(() => {
      let live = true;
      const load = () => call('snapshot', { taskId: task.id }).then((v) => { if (live) { setD(v); setErr(''); } }).catch((e) => setErr(String(e)));
      load();
      const t = setInterval(load, 10_000);
      return () => { live = false; clearInterval(t); };
    }, [task.id]);
    if (err !== '') return <div style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 }}>{err}</div>;
    if (d === null) return <div style={{ color: T.dim }}>加载中…</div>;
    if (d.latest === null) {
      return (
        <div>
          <b style={{ fontSize: 15 }}>{task.name}</b>
          <div style={{ color: T.dim, marginTop: 14, fontSize: 13 }}>
            {task.enabled ? '常驻监控启动中，首个快照最迟一个引擎周期内出现…' : '任务已停用——在会话里说「启用监控大盘」即可恢复'}
          </div>
        </div>
      );
    }
    const snap = d.latest.data;
    const status: string = d.latest.status;
    const bar = (label: string, value: number, warn: number, critical: number, fmt: (v: number) => string) => {
      const ratio = Math.min(1, critical > 0 ? value / (critical * 1.25) : 0);
      const color = value >= critical ? STATUS_COLOR.critical : value >= warn ? STATUS_COLOR.warn : STATUS_COLOR.ok;
      return (
        <div style={{ minWidth: 240, flex: 1, maxWidth: 340 }}>
          <div style={{ display: 'flex', fontSize: 12.5, marginBottom: 4 }}>
            <span style={{ color: T.sub }}>{label}</span>
            <span style={{ marginLeft: 'auto', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmt(value)}</span>
          </div>
          <div style={{ position: 'relative', height: 8, borderRadius: 4, background: 'var(--dsw-alias-bg-layer-1)', border: `1px solid ${T.border}` }}>
            <div style={{ position: 'absolute', inset: 0, width: `${ratio * 100}%`, borderRadius: 4, background: color, opacity: 0.75 }} />
            <div title={`warn ${fmt(warn)}`} style={{ position: 'absolute', top: -2, bottom: -2, left: `${Math.min(100, warn / (critical * 1.25) * 100)}%`, width: 1.5, background: STATUS_COLOR.warn }} />
            <div title={`critical ${fmt(critical)}`} style={{ position: 'absolute', top: -2, bottom: -2, left: `${Math.min(100, 100 / 1.25)}%`, width: 1.5, background: STATUS_COLOR.critical }} />
          </div>
        </div>
      );
    };
    const th = snap.thresholds ?? {};
    const maxOf = (m: string) => snap.agg?.find((a: any) => a.metric === m)?.max ?? 0;
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <b style={{ fontSize: 15 }}>{task.name}</b>
          <span style={{ color: T.dim, fontSize: 12 }}>常驻监控 · 不经会话 · 改阈值请在会话里说</span>
          <span style={{ color: T.dim, fontSize: 12, marginLeft: 'auto' }}>快照 {String(d.latest.time).replace('T', ' ').slice(0, 19)}</span>
        </div>

        <div style={{ display: 'flex', gap: 14, alignItems: 'stretch', margin: '14px 0 18px', flexWrap: 'wrap' }}>
          <div style={{
            minWidth: 150, borderRadius: 12, padding: '14px 20px', color: '#fff',
            background: STATUS_COLOR[status] ?? T.dim, display: 'flex', flexDirection: 'column', justifyContent: 'center',
          }}>
            <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: 1 }}>{STATUS_LABEL[status] ?? status}</div>
            <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>{snap.covered}/{snap.nodes} 节点在采 · 覆盖率 {fmtPct(snap.coverage)}</div>
          </div>
          <div style={{ flex: 1, minWidth: 280, display: 'flex', flexDirection: 'column', gap: 12, justifyContent: 'center' }}>
            {bar('连接使用率（舰队峰值）', maxOf('db.connections_used_ratio'), th.connWarn ?? 0.7, th.connCritical ?? 0.9, fmtPct)}
            {bar('等待锁（舰队峰值）', maxOf('db.waiting_locks'), th.locksWarn ?? 1, th.locksCritical ?? 10, (v) => String(Math.round(v)))}
          </div>
        </div>

        {Array.isArray(snap.problems) && snap.problems.length > 0 && (
          <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: '10px 14px', marginBottom: 14 }}>
            <span style={{ color: T.sub, fontSize: 12, fontWeight: 600 }}>当前问题</span>
            {snap.problems.map((p: any, i: number) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0', fontSize: 13 }}>
                <span style={{ width: 7, height: 7, borderRadius: 4, background: STATUS_COLOR[p.level], flexShrink: 0, position: 'relative', top: -1 }} />
                <span style={{ color: T.sub }}>{p.item}</span><span>{p.detail}</span>
              </div>
            ))}
          </div>
        )}

        <div style={{ fontSize: 13, fontWeight: 600, margin: '0 0 6px' }}>近 24 小时状态</div>
        <div style={{ display: 'flex', gap: 1, height: 18, borderRadius: 4, overflow: 'hidden', maxWidth: 720 }}>
          {(d.history ?? []).map((h: any, i: number) => (
            <div key={i} title={`${String(h.time).replace('T', ' ').slice(0, 16)} · ${h.status}`}
              style={{ flex: 1, background: STATUS_COLOR[h.status] ?? T.dim, opacity: 0.85, minWidth: 2 }} />
          ))}
          {(d.history ?? []).length === 0 && <span style={{ color: T.dim, fontSize: 12 }}>暂无历史</span>}
        </div>

        {Array.isArray(snap.top) && snap.top.length > 0 && (
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, margin: '16px 0 6px' }}>异常值 Top（非零）</div>
            <table className="odbTable" style={{ width: '100%', maxWidth: 560, borderCollapse: 'collapse', fontSize: 13 }}>
              <tbody>
                {snap.top.map((t: any, i: number) => (
                  <tr key={i}>
                    <td style={{ padding: '4px 8px', borderBottom: `1px solid ${T.border}` }}>{t.node}</td>
                    <td style={{ padding: '4px 8px', borderBottom: `1px solid ${T.border}`, color: T.sub }}>{t.metric}</td>
                    <td style={{ padding: '4px 8px', borderBottom: `1px solid ${T.border}`, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{Math.round(t.value * 1000) / 1000}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };
}

export function apply(ctx: any): void {
  const call = async (endpoint: string, payload: unknown = {}): Promise<any> => {
    const r = await ctx.connection.rpc.call('/opendb-monitor', endpoint, payload);
    if (!r.ok) throw new Error(r.error?.message ?? 'request failed');
    return r.value;
  };
  const Panel = makePanel(call);
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    const bridge = (window as any).__opendbHarness__;
    if (bridge?.registerTaskPanel) {
      bridge.registerTaskPanel('monitor-dashboard', Panel);
      clearInterval(timer);
    } else if (tries > 40) clearInterval(timer);
  }, 250);
}
