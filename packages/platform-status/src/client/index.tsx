/**
 * 全局资源大盘 client 半边：Pod 拓扑（按组件分组着色）+ 模型 token 用量。
 * 纲领 §15：纯展示。经 window 桥 registerResourcePanel 进驻 ui-harness 资源页。
 */
import { useEffect, useState } from 'react';

export const inject = ['connection', 'slots'];

const T = { dim: 'var(--dsw-alias-label-tertiary)', sub: 'var(--dsw-alias-label-secondary)', border: 'var(--dsw-alias-border-l1)' };
const GROUP_LABEL: Record<string, string> = {
  'opendb-dsh-host': '控制台 Host', 'opendb-dsh-runtime': '智能体 Runtime', collector: '采集 Collector',
  'opendb-dsh-postgres': 'PostgreSQL(Timescale)', 'opendb-dsh-minio': 'MinIO', 'opendb-dsh-ollama': 'Ollama(bge-m3)',
};

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function age(started: string | null): string {
  if (started === null) return '-';
  const m = Math.floor((Date.now() - new Date(started).getTime()) / 60000);
  return m < 60 ? `${m}分钟` : m < 1440 ? `${Math.floor(m / 60)}小时` : `${Math.floor(m / 1440)}天`;
}

function makePanel(call: (endpoint: string, payload?: unknown) => Promise<any>) {
  return function ResourceDashboard() {
    const [d, setD] = useState<any>(null);
    const [err, setErr] = useState('');
    useEffect(() => {
      let live = true;
      const load = () => call('overview').then((v) => { if (live) { setD(v); setErr(''); } }).catch((e) => setErr(String(e)));
      load();
      const t = setInterval(load, 30_000);
      return () => { live = false; clearInterval(t); };
    }, []);
    if (err !== '') return <div style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 }}>{err}</div>;
    if (d === null) return <div style={{ color: T.dim }}>加载中…</div>;

    const groups = new Map<string, any[]>();
    for (const p of d.pods ?? []) {
      const key = Object.keys(GROUP_LABEL).find((k) => String(p.app).startsWith(k) || String(p.name).startsWith(k)) ?? p.app;
      (groups.get(key) ?? groups.set(key, []).get(key))!.push(p);
    }
    const card: React.CSSProperties = { border: `1px solid ${T.border}`, borderRadius: 10, padding: 14, minWidth: 200 };
    const h2: React.CSSProperties = { fontSize: 14, fontWeight: 600, margin: '18px 0 8px' };
    const maxDay = Math.max(1, ...(d.tokens.daily.map((x: any) => x.input + x.output)));

    return (
      <div>
        <div style={h2}>k8s 组件拓扑（{d.pods === null ? 'RBAC 未授权，降级' : `${d.pods.length} 个 Pod`}）</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {[...groups.entries()].map(([g, pods]) => (
            <div key={g} style={card}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>{GROUP_LABEL[g] ?? g}</div>
              {pods.map((p) => (
                <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 12.5 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, background: p.ready ? '#3fa552' : p.phase === 'Succeeded' ? 'var(--dsw-alias-label-tertiary)' : p.phase === 'Pending' ? '#c9862d' : '#d64545', flexShrink: 0 }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={p.name}>{p.name.replace(/^opendb-dsh-/, '')}</span>
                  <span style={{ color: T.dim, flexShrink: 0 }}>{p.phase === 'Succeeded' ? '已完成 · ' : ''}{p.node} · {age(p.startedAt)}{p.restarts > 0 ? ` · 重启${p.restarts}` : ''}</span>
                </div>
              ))}
            </div>
          ))}
          {d.pods === null && <span style={{ color: T.dim }}>Host 未配置 k8s 只读权限（chart rbac 未启用）</span>}
        </div>

        <div style={h2}>模型资源（DeepSeek API tokens）</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={card}>
            <div style={{ color: T.dim, fontSize: 12 }}>今日消耗</div>
            <div style={{ fontSize: 22, fontWeight: 600, marginTop: 2 }}>{fmtTokens(d.tokens.today.input + d.tokens.today.output)}</div>
            <div style={{ color: T.dim, fontSize: 12, marginTop: 2 }}>输入 {fmtTokens(d.tokens.today.input)} · 输出 {fmtTokens(d.tokens.today.output)} · {d.tokens.today.calls} 次调用</div>
          </div>
          <div style={{ ...card, minWidth: 280 }}>
            <div style={{ color: T.dim, fontSize: 12, marginBottom: 6 }}>近 7 日（日消耗）</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 64 }}>
              {d.tokens.daily.map((x: any) => (
                <div key={x.day} style={{ textAlign: 'center' }} title={`${x.day}: ${fmtTokens(x.input + x.output)}`}>
                  <div style={{ width: 22, height: Math.max(3, ((x.input + x.output) / maxDay) * 48), background: '#4D6BFE', borderRadius: 3, margin: '0 auto' }} />
                  <div style={{ color: T.dim, fontSize: 10, marginTop: 3 }}>{x.day.slice(3)}</div>
                </div>
              ))}
              {d.tokens.daily.length === 0 && <span style={{ color: T.dim, fontSize: 12 }}>暂无数据</span>}
            </div>
          </div>
        </div>

        <div style={h2}>近 7 日 Top 会话（按 tokens）</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, maxWidth: 640 }}>
          <tbody>
            {d.tokens.topSessions.map((s: any) => (
              <tr key={s.sessionId}>
                <td style={{ padding: '5px 8px', borderBottom: `1px solid ${T.border}`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 380 }}>{s.title}</td>
                <td style={{ padding: '5px 8px', borderBottom: `1px solid ${T.border}`, textAlign: 'right', color: T.sub }}>{fmtTokens(s.tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };
}

export function apply(ctx: any): void {
  const call = async (endpoint: string, payload: unknown = {}): Promise<any> => {
    const r = await ctx.connection.rpc.call('/opendb-status', endpoint, payload);
    if (!r.ok) throw new Error(r.error?.message ?? 'request failed');
    return r.value;
  };
  const Panel = makePanel(call);
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    const bridge = (window as any).__opendbHarness__;
    if (bridge?.registerResourcePanel) {
      bridge.registerResourcePanel(Panel);
      clearInterval(timer);
    } else if (tries > 40) clearInterval(timer);
  }, 250);
}
