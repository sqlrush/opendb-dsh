/**
 * 首次引导向导（client-only 插件）：无任何智能体时全屏欢迎页——
 * 给默认智能体取名（user 定案：默认智能体首次使用时由用户命名）+ 可选纳管数据库节点。
 * 数据全走 ui-opendb 的 /opendb 通道；创建流程与「新建智能体」页同一 RPC 序列。
 * 调试入口：URL hash = #onboarding 强制显示（不影响真实空态判定）。
 */
import { useEffect, useState } from 'react';

export const inject = ['connection', 'slots', 'workspaces'];

const T = {
  dim: 'var(--dsw-alias-label-tertiary)',
  sub: 'var(--dsw-alias-label-secondary)',
  border: 'var(--dsw-alias-border-l1)',
  border2: 'var(--dsw-alias-border-l2)',
};

function makeWizard(ctx: any, call: (endpoint: string, payload?: unknown) => Promise<any>) {
  return function OnboardingWizard() {
    const [agents, setAgents] = useState<any[] | null>(null);
    const [nodes, setNodes] = useState<any[]>([]);
    const [name, setName] = useState('');
    const [picked, setPicked] = useState<Record<string, boolean>>({});
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    const [done, setDone] = useState(false);
    const forced = typeof window !== 'undefined' && window.location.hash === '#onboarding';

    useEffect(() => {
      call('agents/list', {}).then((r) => setAgents(r.agents)).catch(() => setAgents([{ probeFailed: true }]));
      call('nodes/list', {}).then((r) => setNodes(r.nodes)).catch(() => {});
    }, []);

    // 空态判定失败时宁可不挡人（fail-safe：不阻塞正常使用）
    const show = !done && (forced || (agents !== null && agents.length === 0));
    if (!show) return null;

    const submit = async () => {
      const n = name.trim();
      if (!/^[\w-]{1,40}$/.test(n)) { setErr('名称只能包含字母/数字/下划线/连字符'); return; }
      setBusy(true); setErr('');
      try {
        const created = await call('agents/create', { name: n });
        for (const node of nodes) if (picked[node.id]) await call('nodes/assign', { nodeId: node.id, agentId: created.agent.id });
        await call('agents/update', { id: created.agent.id, patch: { modelProvider: 'deepseek-official', modelName: 'deepseek-v4-flash' } });
        await ctx.workspaces.create({ path: `/var/lib/dsh/agents/${n}` }).catch(() => {});
        if (forced) window.location.hash = '';
        setDone(true);
      } catch (e) { setErr(String((e as Error).message ?? e)); } finally { setBusy(false); }
    };

    const label: React.CSSProperties = { fontSize: 13, color: T.sub, margin: '20px 0 8px', fontWeight: 600 };
    const input: React.CSSProperties = {
      background: 'var(--dsw-alias-bg-layer-1)', border: `1px solid ${T.border2}`, borderRadius: 8,
      color: 'var(--dsw-alias-label-primary)', padding: '9px 12px', fontSize: 14, width: '100%', boxSizing: 'border-box',
    };
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 600, background: 'var(--dsw-alias-bg-base, #fff)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto',
      }}>
        <div style={{ width: 520, maxWidth: '92vw', padding: '32px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#4D6BFE" strokeWidth="1.8">
              <ellipse cx="12" cy="5.5" rx="8" ry="3" />
              <path d="M4 5.5v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
              <path d="M4 11.5v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
            </svg>
            <span style={{ fontSize: 20, fontWeight: 700 }}>opendb</span>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, color: '#fff', background: '#1a1a1a', borderRadius: 5, padding: '2px 7px' }}>HARNESS</span>
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 26 }}>欢迎使用 opendb-harness</div>
          <div style={{ color: T.sub, fontSize: 14, lineHeight: 1.8, marginTop: 8 }}>
            这是一个数据库集群自动化运维平台：巡检、SQL 审核、监控问答都由智能体完成。
            先给你的默认智能体取个名字——之后建任务、连数据库、调整策略，直接在会话里告诉它就行。
          </div>

          <div style={label}>智能体名称</div>
          <input style={input} autoFocus placeholder="例如 og-prod" value={name} onChange={(e) => setName(e.target.value)} />

          {nodes.length > 0 && (
            <div>
              <div style={label}>纳管数据库（可选，之后也能在会话里增减）</div>
              <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 12 }}>
                {nodes.map((node) => (
                  <label key={node.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 2px', cursor: 'pointer', fontSize: 14 }}>
                    <input type="checkbox" checked={picked[node.id] === true} onChange={(e) => setPicked({ ...picked, [node.id]: e.target.checked })} />
                    <span>{node.name}</span>
                    <span style={{ color: T.dim, fontSize: 12 }}>{node.engine} · {node.host}:{node.port}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {err !== '' && <div style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 13, marginTop: 14 }}>{err}</div>}
          <button
            style={{
              marginTop: 26, background: '#4D6BFE', border: 'none', borderRadius: 8, color: '#fff',
              padding: '10px 28px', fontSize: 14, fontWeight: 600, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
            }}
            disabled={busy}
            onClick={() => void submit()}
          >开始使用</button>
          <div style={{ color: T.dim, fontSize: 12, marginTop: 14 }}>插件与技能默认全量挂载，模型默认 DeepSeek-V4-Flash，都可在会话里随时调整。</div>
        </div>
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
  const Wizard = makeWizard(ctx, call);
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'opendb-onboarding', order: 60, inject: () => ({}) },
    Wizard,
  ));
}
