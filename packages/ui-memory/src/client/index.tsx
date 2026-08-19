/**
 * 记忆管理设置段（P2 W3）：跨智能体记忆列表 + 过滤 + 语义检索 + 修剪。
 * 记忆修剪是人类监督动作（错误记忆会长期污染上下文注入）——所以放设置页显式控件。
 */
import { useEffect, useState } from 'react';

export const inject = ['connection', 'slots'];

const T = { dim: 'var(--dsw-alias-label-tertiary)', sub: 'var(--dsw-alias-label-secondary)', border: 'var(--dsw-alias-border-l1)' };
const KIND_COLOR: Record<string, string> = { fact: '#4D6BFE', preference: '#3fa552', report: '#c9862d', episodic: '#8a8a93' };
const S: Record<string, React.CSSProperties> = {
  input: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, color: 'var(--dsw-alias-label-primary)', padding: '6px 9px', fontSize: 13 },
  btn: { background: 'var(--dsw-alias-interactive-bg-hover)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, color: 'var(--dsw-alias-label-primary)', padding: '5px 12px', fontSize: 13, cursor: 'pointer' },
};

export function apply(ctx: any): void {
  const call = async (endpoint: string, payload: unknown = {}): Promise<any> => {
    const r = await ctx.connection.rpc.call('/opendb-memory', endpoint, payload);
    if (!r.ok) throw new Error(r.error?.message ?? 'request failed');
    return r.value;
  };

  function MemorySection() {
    const [rows, setRows] = useState<any[]>([]);
    const [agents, setAgents] = useState<any[]>([]);
    const [agentId, setAgentId] = useState('');
    const [kind, setKind] = useState('');
    const [q, setQ] = useState('');
    const refresh = async () => {
      try {
        const r = await call('list', { agentId: agentId !== '' ? agentId : undefined, kind: kind !== '' ? kind : undefined });
        setRows(r.memories); setAgents(r.agents);
      } catch { /* retry */ }
    };
    useEffect(() => { void refresh(); }, [agentId, kind]);
    const doSearch = async () => {
      if (q.trim() === '') { void refresh(); return; }
      const aid = agentId !== '' ? agentId : agents[0]?.id;
      if (aid === undefined) return;
      const r = await call('search', { agentId: aid, query: q });
      setRows(r.memories);
    };
    return (
      <div style={{ maxWidth: 720 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <select style={S.input} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">全部智能体</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select style={S.input} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">全部类型</option>
            <option value="fact">fact 事实</option>
            <option value="preference">preference 偏好</option>
            <option value="report">report 报告</option>
            <option value="episodic">episodic 经历</option>
          </select>
          <input style={{ ...S.input, flex: 1, minWidth: 160 }} placeholder="语义检索（需先选智能体）" value={q}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void doSearch(); }} />
          <button style={S.btn} onClick={() => void doSearch()}>检索</button>
        </div>
        <div style={{ color: T.dim, fontSize: 12, marginBottom: 8 }}>共 {rows.length} 条。错误记忆会长期污染注入上下文——发现失实内容直接删除。</div>
        {rows.map((m) => (
          <div key={m.id} style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 12px', marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 10.5, fontWeight: 600, color: '#fff', background: KIND_COLOR[m.kind] ?? T.dim, borderRadius: 5, padding: '1px 6px' }}>{m.kind}</span>
              <span style={{ color: T.sub, fontSize: 12 }}>{m.agentName ?? ''}</span>
              <span style={{ color: T.dim, fontSize: 12 }}>{String(m.createdAt).replace('T', ' ').slice(0, 16)}</span>
              <span style={{ marginLeft: 'auto', color: 'var(--dsw-alias-state-error-primary)', fontSize: 12.5, cursor: 'pointer' }}
                onClick={() => void call('remove', { id: m.id }).then(refresh)}>删除</span>
            </div>
            <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{String(m.content).slice(0, 500)}</div>
          </div>
        ))}
        {rows.length === 0 && <div style={{ color: T.dim, fontSize: 13, padding: '20px 0', textAlign: 'center' }}>没有记忆条目</div>}
      </div>
    );
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'opendb-memory', order: 61, label: () => '记忆', inject: () => ({}) },
    MemorySection,
  ));
}
