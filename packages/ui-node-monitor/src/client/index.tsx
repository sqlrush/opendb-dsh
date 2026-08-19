/**
 * 节点监控详情面板（client-only 插件，W6 从 ui-harness 拆包还债）：
 * 最新指标 stat 卡 + 24h 趋势 Sparkline（面积渐变+弱网格）+ 数据字典变更流。
 * 数据走 ui-opendb 的 /opendb 通道 nodes/detail；经 window 桥 registerNodePanel 进驻数据库页。
 */
import { useEffect, useState } from 'react';

export const inject = ['connection', 'slots'];

const T = {
  dim: 'var(--dsw-alias-label-tertiary)',
  sub: 'var(--dsw-alias-label-secondary)',
  border: 'var(--dsw-alias-border-l1)',
};

function Sparkline({ points, color, height = 56, fmt }: { points: { t: number; v: number }[]; color: string; height?: number; fmt?: (v: number) => string }) {
  const W = 260;
  if (points.length === 0) return <div style={{ color: T.dim, fontSize: 12, height, display: 'flex', alignItems: 'center' }}>暂无数据</div>;
  const vs = points.map((p) => p.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const span = max - min || 1;
  const px = (i: number) => (i / Math.max(points.length - 1, 1)) * (W - 8) + 4;
  const py = (v: number) => height - 8 - ((v - min) / span) * (height - 20) + 4;
  const xy = points.map((p, i) => `${px(i)},${py(p.v)}`);
  const last = points[points.length - 1];
  const gid = `nsg-${color.replace(/[^a-zA-Z0-9]/g, '')}-${height}`;
  return (
    <div>
      <svg width={W} height={height} style={{ display: 'block' }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.18" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1="4" y1={py(min + span * 0.5)} x2={W - 4} y2={py(min + span * 0.5)} stroke={T.border} strokeWidth="1" strokeDasharray="3 4" />
        <line x1="4" y1={height - 4} x2={W - 4} y2={height - 4} stroke={T.border} strokeWidth="1" />
        <polygon points={`4,${height - 4} ${xy.join(' ')} ${W - 4},${height - 4}`} fill={`url(#${gid})`} />
        <polyline points={xy.join(' ')} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={px(points.length - 1)} cy={py(last.v)} r="2.8" fill={color} />
      </svg>
      <div style={{ color: T.dim, fontSize: 12, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
        当前 <span style={{ color: 'var(--dsw-alias-label-primary)', fontWeight: 600 }}>{fmt ? fmt(last.v) : Math.round(last.v * 100) / 100}</span>
        <span style={{ margin: '0 4px' }}>·</span>区间 {fmt ? `${fmt(min)}~${fmt(max)}` : `${Math.round(min * 100) / 100}~${Math.round(max * 100) / 100}`}
      </div>
    </div>
  );
}

function makePanel(call: (endpoint: string, payload?: unknown) => Promise<any>) {
  return function NodeDetail({ nodeId }: { nodeId: string }) {
    const [d, setD] = useState<any>(null);
    const [err, setErr] = useState('');
    const refresh = async (id: string) => {
      try { setD(await call('nodes/detail', { nodeId: id })); setErr(''); } catch (e) { setErr(String((e as Error).message ?? e)); }
    };
    useEffect(() => { setD(null); void refresh(nodeId); const t = setInterval(() => void refresh(nodeId), 60_000); return () => clearInterval(t); }, [nodeId]);
    if (err !== '') return <div style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 }}>{err}</div>;
    if (d === null) return <div style={{ color: T.dim }}>加载中…</div>;
    const { node, latest, series, dictChanges } = d;
    const lv = (m: string) => latest.find((x: any) => x.metric === m)?.value;
    const sizeEntries = latest.filter((x: any) => x.metric.startsWith('db.size_bytes.'));
    const totalSize = sizeEntries.reduce((s: number, x: any) => s + x.value, 0);
    const fmtBytes = (b: number) => b > 1 << 30 ? `${(b / (1 << 30)).toFixed(1)}GB` : b > 1 << 20 ? `${(b / (1 << 20)).toFixed(1)}MB` : `${Math.round(b / 1024)}KB`;
    const card: React.CSSProperties = { border: `1px solid var(--dsw-alias-border-l2)`, borderRadius: 10, padding: '10px 14px', minWidth: 130 };
    const h2: React.CSSProperties = { fontSize: 14, fontWeight: 600, margin: '18px 0 8px' };
    const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', color: T.dim, borderBottom: `1px solid var(--dsw-alias-border-l2)`, fontWeight: 500 };
    const td: React.CSSProperties = { padding: '6px 8px', borderBottom: `1px solid ${T.border}`, verticalAlign: 'top' };
    const statCard = (label: string, value: React.ReactNode) => (
      <div style={card}>
        <div style={{ color: T.dim, fontSize: 12 }}>{label}</div>
        <div style={{ fontSize: 20, fontWeight: 600, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      </div>
    );
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span style={{ color: node.status === 'online' ? '#3fa552' : 'var(--dsw-alias-state-error-primary)', fontSize: 12 }}>●</span>
          <b style={{ fontSize: 16 }}>{node.name}</b>
          <span style={{ color: T.dim }}>{node.engine} · {node.host}:{node.port}/{node.dbname} · {node.status}</span>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
          {statCard('活跃会话', lv('db.sessions.active') ?? '-')}
          {statCard('空闲会话', lv('db.sessions.idle') ?? '-')}
          {statCard('等待锁', lv('db.waiting_locks') ?? '-')}
          {statCard('连接使用率', lv('db.connections_used_ratio') !== undefined ? `${(lv('db.connections_used_ratio') * 100).toFixed(1)}%` : '-')}
          {statCard('库总大小', totalSize > 0 ? fmtBytes(totalSize) : '-')}
        </div>
        <div style={h2}>24 小时趋势（15 分钟均值）</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={card}><div style={{ color: T.dim, fontSize: 12, marginBottom: 6 }}>活跃会话</div><Sparkline points={series['db.sessions.active'] ?? []} color="#4D6BFE" /></div>
          <div style={card}><div style={{ color: T.dim, fontSize: 12, marginBottom: 6 }}>等待锁</div><Sparkline points={series['db.waiting_locks'] ?? []} color="#c9862d" /></div>
          <div style={card}><div style={{ color: T.dim, fontSize: 12, marginBottom: 6 }}>连接使用率</div><Sparkline points={series['db.connections_used_ratio'] ?? []} color="#3fa552" fmt={(v) => `${(v * 100).toFixed(1)}%`} /></div>
        </div>
        <div style={h2}>数据字典变更（近 7 天）</div>
        <table className="odbTable" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr><th style={th}>时间</th><th style={th}>变更</th><th style={th}>类型</th><th style={th}>对象</th></tr></thead>
          <tbody>
            {dictChanges.map((c: any, i: number) => (
              <tr key={i}>
                <td style={td}>{String(c.time).replace('T', ' ').slice(0, 16)}</td>
                <td style={td}><span style={{ color: c.change === 'removed' ? 'var(--dsw-alias-state-error-primary)' : c.change === 'added' ? '#3fa552' : '#c9862d' }}>{c.change}</span></td>
                <td style={td}><span style={{ color: T.dim }}>{c.kind}</span></td>
                <td style={td}>{c.object}</td>
              </tr>
            ))}
            {dictChanges.length === 0 && <tr><td style={td} colSpan={4}><span style={{ color: T.dim }}>近 7 天没有结构变更</span></td></tr>}
          </tbody>
        </table>
      </div>
    );
  };
}

export function apply(ctx: any): void {
  const call = async (endpoint: string, payload: unknown = {}): Promise<any> => {
    const r = await ctx.connection.rpc.call('/opendb', endpoint, payload);
    if (!r.ok) throw new Error(r.error?.message ?? 'request failed');
    return r.value;
  };
  const Panel = makePanel(call);
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    const bridge = (window as any).__opendbHarness__;
    if (bridge?.registerNodePanel) {
      bridge.registerNodePanel(Panel);
      clearInterval(timer);
    } else if (tries > 40) clearInterval(timer);
  }, 250);
}
