/**
 * Browser half: an "OpenDB" settings section (agents / db nodes / standing instructions)
 * driving the Host's /opendb RPC channel. Registered via ctx.slots.inject so it waits for
 * the settings slot declaration; the component closes over ctx (no reliance on slot props).
 */
import { useEffect, useState } from 'react';

interface Agent {
  id: string; name: string; kind: string; runtimeClass: string; preset: string;
  instructionDoc: string; instructionVersion: number; status: string; nodeCount: number;
}
interface DbNode {
  id: string; name: string; engine: string; host: string; port: number; dbname: string;
  agentId?: string; status: string;
}

export const inject = ['connection', 'slots'];

export function apply(ctx: any): void {
  const call = async (endpoint: string, payload: unknown): Promise<any> => {
    const r = await ctx.connection.rpc.call('/opendb', endpoint, payload);
    if (!r.ok) throw new Error(r.error?.message ?? 'request failed');
    return r.value;
  };

  const S: Record<string, React.CSSProperties> = {
    wrap: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 0', color: 'var(--dsw-alias-label-primary)' },
    h: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', margin: '8px 0 4px' },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
    th: { textAlign: 'left', padding: '6px 8px', color: 'var(--dsw-alias-label-tertiary)', borderBottom: '1px solid var(--dsw-alias-border-l2)', fontWeight: 500 },
    td: { padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)', verticalAlign: 'top' },
    input: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, color: 'var(--dsw-alias-label-primary)', padding: '4px 8px', fontSize: 13 },
    btn: { background: 'var(--dsw-alias-interactive-bg-hover)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, color: 'var(--dsw-alias-label-primary)', padding: '4px 10px', fontSize: 13, cursor: 'pointer' },
    ta: { width: '100%', minHeight: 120, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, color: 'var(--dsw-alias-label-primary)', padding: 8, fontSize: 13, fontFamily: 'monospace', boxSizing: 'border-box' },
    err: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 },
    dim: { color: 'var(--dsw-alias-label-tertiary)' },
  };

  function OpendbSection() {
    const [agents, setAgents] = useState<Agent[]>([]);
    const [nodes, setNodes] = useState<DbNode[]>([]);
    const [error, setError] = useState('');
    const [editing, setEditing] = useState<Agent | null>(null);
    const [doc, setDoc] = useState('');
    const [nn, setNn] = useState({ name: '', host: '', port: '5432', agentId: '' });
    const [busy, setBusy] = useState(false);

    const refresh = async () => {
      try {
        const a = await call('agents/list', {});
        const n = await call('nodes/list', {});
        setAgents(a.agents); setNodes(n.nodes); setError('');
      } catch (e) { setError(String(e)); }
    };
    useEffect(() => { void refresh(); }, []);

    const saveDoc = async () => {
      if (!editing) return;
      setBusy(true);
      try { await call('agents/setInstructions', { id: editing.id, doc }); setEditing(null); await refresh(); }
      catch (e) { setError(String(e)); } finally { setBusy(false); }
    };
    const addNode = async () => {
      if (!nn.name || !nn.host) { setError('节点名称与主机必填'); return; }
      setBusy(true);
      try {
        await call('nodes/create', { name: nn.name, host: nn.host, port: Number(nn.port) || 5432, agentId: nn.agentId || undefined });
        setNn({ name: '', host: '', port: '5432', agentId: '' });
        await refresh();
      } catch (e) { setError(String(e)); } finally { setBusy(false); }
    };
    const assign = async (nodeId: string, agentId: string) => {
      try { await call('nodes/assign', { nodeId, agentId: agentId || undefined }); await refresh(); }
      catch (e) { setError(String(e)); }
    };

    return (
      <div style={S.wrap}>
        {error !== '' && <div style={S.err}>{error}</div>}

        <div style={S.h}>Agent（工作区 = agent；在侧栏"添加工作区"即可新建）</div>
        <table style={S.table}>
          <thead><tr><th style={S.th}>名称</th><th style={S.th}>类型</th><th style={S.th}>运行池</th><th style={S.th}>preset</th><th style={S.th}>节点数</th><th style={S.th}>指令版本</th><th style={S.th}></th></tr></thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td style={S.td}>{a.name}</td>
                <td style={S.td}><span style={S.dim}>{a.kind}</span></td>
                <td style={S.td}>{a.runtimeClass}</td>
                <td style={S.td}>{a.preset}</td>
                <td style={S.td}>{a.nodeCount}</td>
                <td style={S.td}>v{a.instructionVersion}</td>
                <td style={S.td}><button style={S.btn} onClick={() => { setEditing(a); setDoc(a.instructionDoc); }}>编辑指令</button></td>
              </tr>
            ))}
            {agents.length === 0 && <tr><td style={S.td} colSpan={7}><span style={S.dim}>还没有 agent —— 在侧栏点"添加工作区"创建一个</span></td></tr>}
          </tbody>
        </table>

        {editing !== null && (
          <div>
            <div style={S.h}>常驻指令 · {editing.name}（每个会话第 1 步注入；保存即生效于新一轮）</div>
            <textarea style={S.ta} value={doc} onChange={(e) => setDoc(e.target.value)} placeholder="# 运维要求&#10;- 例如：回答前先自报所属集群" />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button style={S.btn} disabled={busy} onClick={() => void saveDoc()}>保存</button>
              <button style={S.btn} onClick={() => setEditing(null)}>取消</button>
            </div>
          </div>
        )}

        <div style={S.h}>数据库节点</div>
        <table style={S.table}>
          <thead><tr><th style={S.th}>名称</th><th style={S.th}>引擎</th><th style={S.th}>地址</th><th style={S.th}>归属 agent</th></tr></thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.id}>
                <td style={S.td}>{n.name}</td>
                <td style={S.td}><span style={S.dim}>{n.engine}</span></td>
                <td style={S.td}>{n.host}:{n.port}/{n.dbname}</td>
                <td style={S.td}>
                  <select style={S.input} value={n.agentId ?? ''} onChange={(e) => void assign(n.id, e.target.value)}>
                    <option value="">（未绑定）</option>
                    {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </td>
              </tr>
            ))}
            {nodes.length === 0 && <tr><td style={S.td} colSpan={4}><span style={S.dim}>还没有节点</span></td></tr>}
          </tbody>
        </table>

        <div style={S.h}>添加节点（openGauss）</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input style={S.input} placeholder="名称（如 og5）" value={nn.name} onChange={(e) => setNn({ ...nn, name: e.target.value })} />
          <input style={S.input} placeholder="主机" value={nn.host} onChange={(e) => setNn({ ...nn, host: e.target.value })} />
          <input style={{ ...S.input, width: 80 }} placeholder="端口" value={nn.port} onChange={(e) => setNn({ ...nn, port: e.target.value })} />
          <select style={S.input} value={nn.agentId} onChange={(e) => setNn({ ...nn, agentId: e.target.value })}>
            <option value="">绑定 agent（可选）</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button style={S.btn} disabled={busy} onClick={() => void addNode()}>添加</button>
        </div>
      </div>
    );
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'opendb', order: 60, label: () => 'OpenDB', inject: () => ({}) },
    OpendbSection,
  ));
}
