/**
 * 知识库管理设置段（P2 W3）：文档列表 + 灌入表单 + 检索试验。
 * 设置页是管理例外区（纲领 §15：审批签收类之外的低频管理控件集中在这里）；
 * 日常灌入知识的主路径仍是会话（knowledge_ingest 工具）。
 */
import { useEffect, useState } from 'react';

export const inject = ['connection', 'slots'];

const T = { dim: 'var(--dsw-alias-label-tertiary)', sub: 'var(--dsw-alias-label-secondary)', border: 'var(--dsw-alias-border-l1)' };
const S: Record<string, React.CSSProperties> = {
  input: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, color: 'var(--dsw-alias-label-primary)', padding: '6px 9px', fontSize: 13 },
  btn: { background: 'var(--dsw-alias-interactive-bg-hover)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, color: 'var(--dsw-alias-label-primary)', padding: '5px 12px', fontSize: 13, cursor: 'pointer' },
  th: { textAlign: 'left' as const, padding: '6px 8px', color: T.dim, borderBottom: '1px solid var(--dsw-alias-border-l2)', fontWeight: 500, fontSize: 12.5 },
  td: { padding: '6px 8px', borderBottom: `1px solid ${T.border}`, verticalAlign: 'top' as const, fontSize: 13 },
  h3: { fontSize: 13.5, fontWeight: 600, margin: '18px 0 8px' },
};

export function apply(ctx: any): void {
  const call = async (endpoint: string, payload: unknown = {}): Promise<any> => {
    const r = await ctx.connection.rpc.call('/opendb-knowledge', endpoint, payload);
    if (!r.ok) throw new Error(r.error?.message ?? 'request failed');
    return r.value;
  };

  function KnowledgeSection() {
    const [docs, setDocs] = useState<any[]>([]);
    const [title, setTitle] = useState('');
    const [source, setSource] = useState('');
    const [text, setText] = useState('');
    const [isGlobal, setIsGlobal] = useState(true);
    const [q, setQ] = useState('');
    const [hits, setHits] = useState<any[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState('');
    const refresh = async () => { try { setDocs((await call('docs/list')).docs); } catch { /* retry */ } };
    useEffect(() => { void refresh(); }, []);
    const ingest = async () => {
      if (title.trim() === '' || text.trim() === '') { setMsg('标题和正文不能为空'); return; }
      setBusy(true); setMsg('');
      try {
        const r = await call('docs/ingest', { title, source, text, global: isGlobal });
        setMsg(`已入库：《${r.doc.title}》${r.doc.chunks} 段`);
        setTitle(''); setSource(''); setText('');
        await refresh();
      } catch (e) { setMsg(String((e as Error).message ?? e)); } finally { setBusy(false); }
    };
    return (
      <div style={{ maxWidth: 720 }}>
        <div style={{ ...S.h3, marginTop: 4 }}>已入库文档（{docs.length}）</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }} className="odbTable">
          <thead><tr><th style={S.th}>标题</th><th style={S.th}>归属</th><th style={S.th}>段数</th><th style={S.th}>时间</th><th style={S.th} /></tr></thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <td style={S.td}>{d.title}{d.source !== undefined && <span style={{ color: T.dim, fontSize: 12 }}> · {d.source}</span>}</td>
                <td style={S.td}><span style={{ color: T.sub }}>{d.agentName ?? '全局'}</span></td>
                <td style={{ ...S.td, fontVariantNumeric: 'tabular-nums' }}>{d.chunks}</td>
                <td style={S.td}><span style={{ color: T.dim, fontSize: 12 }}>{String(d.createdAt).slice(0, 10)}</span></td>
                <td style={S.td}><span style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12.5, cursor: 'pointer' }} onClick={() => void call('docs/remove', { id: d.id }).then(refresh)}>删除</span></td>
              </tr>
            ))}
            {docs.length === 0 && <tr><td style={S.td} colSpan={5}><span style={{ color: T.dim }}>还没有知识文档——在会话里粘贴资料让智能体 knowledge_ingest，或在下方表单灌入</span></td></tr>}
          </tbody>
        </table>

        <div style={S.h3}>灌入文档</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <input style={{ ...S.input, flex: 1, minWidth: 180 }} placeholder="标题" value={title} onChange={(e) => setTitle(e.target.value)} />
          <input style={{ ...S.input, width: 200 }} placeholder="来源（可选，同源重灌替换）" value={source} onChange={(e) => setSource(e.target.value)} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13 }}>
            <input type="checkbox" checked={isGlobal} onChange={(e) => setIsGlobal(e.target.checked)} />全局知识
          </label>
        </div>
        <textarea style={{ ...S.input, width: '100%', minHeight: 120, boxSizing: 'border-box', fontFamily: 'inherit' }} placeholder="正文（纯文本 / markdown，自动切块向量化）" value={text} onChange={(e) => setText(e.target.value)} />
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
          <button style={S.btn} disabled={busy} onClick={() => void ingest()}>入库</button>
          {msg !== '' && <span style={{ color: T.sub, fontSize: 12.5 }}>{msg}</span>}
        </div>

        <div style={S.h3}>检索试验</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={{ ...S.input, flex: 1 }} placeholder="输入问题试试语义检索" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void call('search', { query: q }).then((r) => setHits(r.hits)); }} />
          <button style={S.btn} onClick={() => void call('search', { query: q }).then((r) => setHits(r.hits))}>检索</button>
        </div>
        {hits !== null && (
          <div style={{ marginTop: 10 }}>
            {hits.map((h, i) => (
              <div key={i} style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: 10, marginBottom: 8, fontSize: 13 }}>
                <div style={{ color: T.sub, fontSize: 12, marginBottom: 4 }}>《{h.title}》第 {h.seq + 1} 段{h.distance !== undefined ? ` · 距离 ${h.distance.toFixed(3)}` : ''}</div>
                <div style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'hidden' }}>{h.content.slice(0, 400)}</div>
              </div>
            ))}
            {hits.length === 0 && <span style={{ color: T.dim, fontSize: 13 }}>没有命中</span>}
          </div>
        )}
      </div>
    );
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'opendb-knowledge', order: 62, label: () => '知识库', inject: () => ({}) },
    KnowledgeSection,
  ));
}
