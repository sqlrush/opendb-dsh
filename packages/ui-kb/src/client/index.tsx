/**
 * ui-kb client：知识库 › 知识库大盘（P1，2026-09-01 user 通过 docs/prototypes/knowledge-r1.html）。
 * 一眼看全三类知识——记忆（平台经历）/ 向量（非结构化资料）/ 图（客户专属关系）——各有多少、健不健康。
 * 数据来自 ui-knowledge 的 /opendb-knowledge dashboard 端点（只读聚合三库）；纯展示，无写操作。
 * 导入工具（P2）与强类型图（P3）后续；本面板只读。
 */
import { Component, useEffect, useState } from 'react';

export const inject = ['connection', 'slots', 'sessions', 'workspaces'];

let clientCtx: any;

const T = {
  ink: '#0f1115', sub: '#61666b', dim: '#81858c', blue: '#4176e6',
  line: 'rgba(0,0,0,.08)', fill: '#f7f8fa', fill2: '#f2f3f5', rest: '#dde0e5',
  ok: '#3fa552', okSoft: '#e8f5ec', notice: '#c9862d', noticeSoft: '#faf3e5',
  warn: '#e07a1f', warnSoft: '#fdf0e3', crit: '#d64545', critSoft: '#fdecec',
  mem: '#2fa79a', vec: '#4176e6', graph: '#8b6be0',
};
const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
const mono = '"JetBrains Mono","SF Mono",Menlo,Consolas,monospace';
const tnum: any = { fontVariantNumeric: 'tabular-nums' };
const card: any = { background: '#fff', border: `1px solid ${T.line}`, borderRadius: 12, boxShadow: '0 4px 12px rgba(0,0,0,.02),0 2px 8px rgba(0,0,0,.04)', minWidth: 0 };

const KIND_CN: Record<string, string> = { report: '报告', fact: '事实', episodic: '情景', preference: '偏好', node: '节点', agent: '智能体' };
const SRC_CN = (s: string): string => (s === 'sop-backup-v2' ? '备份规程' : s === 'task' ? '任务产出' : s === '未标注' ? '未标注' : s);

interface Dash {
  memory: { total: number; withVec: number; agents: number; oldest: string | null; newest: string | null; last24: number; byKind: { kind: string; n: number }[] };
  vector: { docs: number; chunks: number; withVec: number; bySource: { source: string; n: number }[] };
  graph: { edges: number; entities: number; linkedMemories: number; byKind: { kind: string; n: number }[]; typed: boolean; kgEdges: number; kgNodes: number; pendingReview: number };
  updatedAt: string | null;
}

class Boundary extends Component<{ children: any }, { err?: string }> {
  state: { err?: string } = {};
  static getDerivedStateFromError(e: unknown) { return { err: String((e as Error)?.message ?? e) }; }
  render() { return this.state.err !== undefined ? <div style={{ fontSize: 14, color: T.crit, padding: 12 }}>知识库大盘渲染失败：{this.state.err}</div> : this.props.children; }
}

const fmtInt = (n: number): string => n.toLocaleString('en-US');
const pct = (a: number, b: number): number => (b > 0 ? Math.round((a / b) * 100) : 0);
const mmdd = (iso: string | null): string => {
  if (iso === null) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function Stat({ l, children, d, color }: { l: string; children: any; d?: any; color?: string }) {
  return (
    <div style={{ background: T.fill, borderRadius: 10, padding: '12px 14px', minWidth: 0 }}>
      <div style={{ fontSize: 12.5, color: T.dim }}>{l}</div>
      <div style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.3, marginTop: 2, color: color ?? T.ink, ...tnum }}>{children}</div>
      {d !== undefined ? <div style={{ fontSize: 12, color: T.dim, lineHeight: 1.5, marginTop: 2 }}>{d}</div> : null}
    </div>
  );
}
function Small({ children }: { children: any }) { return <span style={{ fontSize: 12.5, fontWeight: 500, color: T.dim, marginLeft: 5 }}>{children}</span>; }
function Cov({ a, b }: { a: number; b: number }) {
  const p = pct(a, b); const c = p >= 90 ? T.ok : p >= 50 ? T.notice : T.warn;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0' }}>
      <span style={{ color: T.sub, whiteSpace: 'nowrap', fontSize: 13 }}>向量覆盖</span>
      <span style={{ flex: 1, height: 10, borderRadius: 5, background: T.fill2, overflow: 'hidden' }}><i style={{ display: 'block', height: '100%', width: `${b > 0 ? p : 0}%`, background: c }} /></span>
      <span style={{ fontWeight: 600, whiteSpace: 'nowrap', color: c }}>{b > 0 ? `${p}%` : '—'}</span>
    </div>
  );
}
function KV({ k, v, color }: { k: string; v: any; color?: string }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '5px 0', borderTop: `1px solid ${T.line}`, fontSize: 13 }}><span style={{ color: T.sub }}>{k}</span><span style={{ fontWeight: 500, color }}>{v}</span></div>;
}
function StoreCard({ color, title, sub, big, bigUnit, children, foot }: { color: string; title: string; sub: string; big: any; bigUnit: string; children: any; foot?: any }) {
  return (
    <div style={{ ...card, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '14px 16px 12px', borderTop: `4px solid ${color}` }}>
        <div style={{ fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: color }} />{title}</div>
        <div style={{ fontSize: 12.5, color: T.sub, marginTop: 2 }}>{sub}</div>
        <div style={{ fontSize: 30, fontWeight: 700, lineHeight: 1.1, marginTop: 8, ...tnum }}>{big}<Small>{bigUnit}</Small></div>
      </div>
      <div style={{ padding: '4px 16px 14px', fontSize: 13, flex: 1 }}>{children}</div>
      {foot !== undefined ? <div style={{ padding: '10px 16px', borderTop: `1px solid ${T.line}`, fontSize: 13, color: T.dim }}>{foot}</div> : null}
    </div>
  );
}
function Bars({ items }: { items: { label: string; n: number; c: string }[] }) {
  const tot = Math.max(1, items.reduce((a, x) => a + x.n, 0));
  return (
    <>
      <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', margin: '8px 0 4px', background: T.fill2 }}>
        {items.filter((x) => x.n > 0).map((x) => <i key={x.label} style={{ display: 'block', height: '100%', width: `${(x.n / tot) * 100}%`, background: x.c }} />)}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: 12, color: T.sub }}>
        {items.map((x) => <span key={x.label}><i style={{ width: 8, height: 8, borderRadius: 2, display: 'inline-block', marginRight: 4, verticalAlign: 'middle', background: x.c }} />{x.label} {x.n}</span>)}
      </div>
    </>
  );
}

function Dashboard({ call }: { call: (endpoint: string, payload?: unknown) => Promise<any> }) {
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    const load = () => call('dashboard').then((v) => { if (live) { setD(v as Dash); setErr(''); } }).catch((e) => { if (live) setErr(String(e?.message ?? e)); });
    load();
    const t = setInterval(load, 30_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (err !== '') return <div style={{ fontSize: 13.5, color: T.crit }}>知识库大盘取数失败：{err}</div>;
  if (d === null) return <div style={{ color: T.dim, fontSize: 13.5 }}>加载中……</div>;

  const total = d.memory.total + d.vector.chunks + d.graph.edges;
  const vecMiss = Math.max(0, d.vector.chunks - d.vector.withVec);
  const vecCov = pct(d.vector.withVec, d.vector.chunks);
  // 健康自检项（数据驱动，降级即发现）
  const issues: { lv: string; t: string; d: string; act?: string }[] = [];
  if (vecMiss > 0) issues.push({ lv: 'warn', t: `向量缺失 ${vecMiss} 块`, d: '这些切块未 embed，检索退化为关键词（ILIKE）——嵌入慢/失败所致，需补齐', act: '补齐向量（P3）' });
  if ((d.graph.pendingReview ?? 0) > 0) issues.push({ lv: 'notice', t: `图候选待人审 ${fmtInt(d.graph.pendingReview)} 条`, d: '导入抽取的关系候选在人审队列中，确认后才进确定性图', act: '去导入知识审核' });
  if (d.graph.typed === false && d.graph.edges > 0 && (d.graph.kgEdges ?? 0) === 0) issues.push({ lv: 'notice', t: `图边尚未定型 ${fmtInt(d.graph.edges)} 条`, d: '现为记忆实体共现边（无类型/来源/版本）；导入客户资料人审入图后成为强类型边', act: '导入知识' });
  if (d.vector.docs <= 2 && (d.graph.kgEdges ?? 0) === 0) issues.push({ lv: 'crit', t: '客户专属知识为空', d: '尚未导入客户规范 / 工单 / 故障总结——用「导入知识」把材料分流进三库', act: '导入知识' });
  const hIcon: Record<string, [string, string, string]> = { warn: [T.warnSoft, T.warn, '!'], notice: [T.noticeSoft, T.notice, '◔'], crit: [T.critSoft, T.crit, '○'] };

  const h2: any = { fontSize: 15, fontWeight: 600, margin: '24px 0 10px' };

  return (
    <div style={{ fontFamily: FONT, color: T.ink, lineHeight: 1.6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 2 }}>
        <span style={{ fontSize: 20, fontWeight: 600 }}>知识库大盘</span>
        <span style={{ display: 'inline-flex', gap: 5, fontSize: 12.5, background: T.okSoft, color: T.ok, borderRadius: 6, padding: '1px 9px', fontWeight: 500 }}>✓ 写入归确定性层 · 引用必有出处</span>
        <span style={{ fontSize: 13.5, color: T.dim }}>记忆 · 向量 · 图 三类知识全貌</span>
      </div>
      <p style={{ fontSize: 14, color: T.sub, margin: '5px 0 0' }}>
        平台"懂多少"：平台自己的经历（记忆）、导入的非结构化资料（向量）、客户专属的关系网（图）——有多少、健不健康,一眼看清。
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 10, margin: '14px 0 8px' }}>
        <Stat l="知识总量" d={`记忆 ${fmtInt(d.memory.total)} · 向量 ${fmtInt(d.vector.chunks)} · 图边 ${fmtInt(d.graph.edges)}`}>{fmtInt(total)}<Small>条 · 三库合计</Small></Stat>
        <Stat l="向量覆盖率" color={vecCov >= 90 ? T.ok : vecCov >= 50 ? T.notice : T.warn} d={`${fmtInt(d.vector.withVec)}/${fmtInt(d.vector.chunks)} 切块已向量化`}>{d.vector.chunks > 0 ? `${vecCov}%` : '—'}</Stat>
        <Stat l="健康度" color={issues.length > 0 ? T.warn : T.ok} d={issues.length > 0 ? issues.map((i) => i.t).join(' · ') : '三库均健康'}>{issues.length > 0 ? `${issues.length} 项待处理` : '正常'}</Stat>
        <Stat l="最近更新" d={`24h 新增记忆 ${fmtInt(d.memory.last24)} 条`}><span style={{ fontSize: 19 }}>{mmdd(d.updatedAt)}</span></Stat>
      </div>

      <div style={h2}>三类知识</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 14 }}>
        <StoreCard color={T.mem} title="记忆知识" sub="平台在这套环境里做过什么、上次结论是什么"
          big={fmtInt(d.memory.total)} bigUnit={`条 · ${mmdd(d.memory.oldest)} → ${mmdd(d.memory.newest)}`}
          foot="平台任务报告自动沉淀为主">
          <Bars items={d.memory.byKind.map((k, i) => ({ label: KIND_CN[k.kind] ?? k.kind, n: k.n, c: ['#2fa79a', '#7fc9be', '#b8e0d9', '#ddf0ec'][i % 4] }))} />
          <Cov a={d.memory.withVec} b={d.memory.total} />
          <KV k="关联智能体" v={`${d.memory.agents} 个`} />
          <KV k="24h 新增" v={`${fmtInt(d.memory.last24)} 条`} />
        </StoreCard>

        <StoreCard color={T.vec} title="向量知识" sub="导入的非结构化资料：规范 / 工单 / 故障 / 手册"
          big={fmtInt(d.vector.docs)} bigUnit={`文档 · ${fmtInt(d.vector.chunks)} 切块`}
          foot="P2 导入工具上线后由用户材料充实">
          <Cov a={d.vector.withVec} b={d.vector.chunks} />
          {vecMiss > 0 ? <div style={{ fontSize: 12, color: T.warn, margin: '2px 0 8px' }}>⚠ {vecMiss} 块缺向量 → 退化为关键词检索，需补齐</div> : null}
          <KV k="按来源" v={d.vector.bySource.map((s) => `${SRC_CN(s.source)} ${s.n}`).join(' · ') || '—'} />
          <KV k="接入报告" v="未接（P3 参考不改判）" color={T.crit} />
        </StoreCard>

        <StoreCard color={T.graph} title="图知识" sub="客户专属关系：现象 / 根因 / 处置 / 条款 / 对象"
          big={fmtInt(d.graph.edges)} bigUnit={`条边 · ${fmtInt(d.graph.entities)} 实体`}
          foot="强类型关系 + 人审入图为 P3">
          {d.graph.typed === false ? <div style={{ fontSize: 12, color: T.notice, margin: '2px 0 8px' }}>当前均为「记忆实体共现」边，尚未定型为强类型关系</div> : null}
          <Bars items={[
            { label: '约束', n: 0, c: T.graph }, { label: '导致', n: 0, c: '#a98be6' }, { label: '处置', n: 0, c: '#c0abef' },
            { label: '共现(旧)', n: d.graph.edges, c: T.rest },
          ]} />
          <KV k="强类型边（已入图）" v={`${fmtInt(d.graph.kgEdges ?? 0)} 条 · ${fmtInt(d.graph.kgNodes ?? 0)} 节点`} color={(d.graph.kgEdges ?? 0) > 0 ? T.graph : undefined} />
          <KV k="待人审候选" v={`${fmtInt(d.graph.pendingReview ?? 0)} 条`} color={(d.graph.pendingReview ?? 0) > 0 ? T.notice : undefined} />
          <KV k="关联记忆" v={`${fmtInt(d.graph.linkedMemories)} 条`} />
        </StoreCard>
      </div>

      <div style={h2}>健康自检 · 降级即发现</div>
      {issues.length === 0 ? (
        <div style={{ ...card, padding: '16px', fontSize: 13.5, color: T.ok }}>✓ 三库均健康，无待处理项。</div>
      ) : (
        <div style={{ ...card, padding: '4px 16px' }}>
          {issues.map((it, i) => {
            const [bg, fg, ic] = hIcon[it.lv] ?? hIcon.notice;
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 0', borderTop: i === 0 ? 'none' : `1px solid ${T.line}`, fontSize: 13.5 }}>
                <span style={{ width: 22, height: 22, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, flex: 'none', background: bg, color: fg }}>{ic}</span>
                <div style={{ flex: 1 }}>{it.t}<small style={{ color: T.dim, display: 'block', fontSize: 12 }}>{it.d}</small></div>
                {it.act !== undefined ? <span style={{ color: T.dim, fontSize: 13, whiteSpace: 'nowrap' }}>{it.act}</span> : null}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ fontSize: 13, color: T.dim, border: `1px dashed ${T.line}`, borderRadius: 8, padding: '10px 16px', marginTop: 18, lineHeight: 1.8 }}>
        📥 <b>知识从哪来</b>：记忆由平台任务报告自动沉淀；向量与图将由「导入知识」（P2）把用户提供的文本材料分析后分流写入（拓扑/依赖/变更史另由采集器直写图，不经导入）。<br />
        🔒 <b>写入纪律</b>：向量线自动入库；图线由模型抽候选、经人审确认（confidence=1.0）才进确定性推理——模型只提议，写库归确定性管线。<br />
        🧮 <b>口径</b>：三库共用同一 PostgreSQL；向量在 pgvector，图为 PG 边表，记忆全在 PG。数字每 30 秒刷新。
      </div>
    </div>
  );
}

// ── 导入向导（P2）───────────────────────────────────────────────────────────
const REL_CN: Record<string, string> = { constrains: '约束', causes: '导致', handled_by: '处置为', depends_on: '依赖', references: '引用', triggers: '触发' };
const KIND_OPTS = ['规范', '工单', '故障总结', '手册', '预案'];

// 图线：触发一次会话让模型把关系候选写进已建好的批次（向量线已由服务端确定性完成，不在此）。
async function extractEdgesInSession(text: string, importId: string): Promise<string> {
  if (clientCtx === undefined) throw new Error('客户端上下文未就绪');
  const ws = clientCtx.workspaces?.list?.getSnapshot?.()?.items?.[0];
  const sessionId: string = await clientCtx.sessions.create(ws?.workspaceId !== undefined ? { workspaceId: ws.workspaceId } : {});
  // 不 openSession——那会把主区切到会话、离开向导，人审界面就消失了。
  // 抽取轮次经 mode:'queue' 入队，Runtime 后台自会处理，向导留在原地轮询 staging。
  const prompt = [
    `导入批次 ${importId} 的向量已入库。现在请你调用一次 kb_extract 工具，从下面 <材料> 里抽取关系候选边写进该批次的人审队列。`,
    `调用参数：import_id="${importId}"，edges=从材料抽取的三元组（rel 用 causes/constrains/handled_by/depends_on/references/triggers；只抽材料明确写到的关系，不要凭常识编造；抽不出就传空数组）。`,
    `必须真正调用 kb_extract 工具，不要只回复文字。调用后一句话报告条数。`,
    ``,
    `<材料>`,
    text.slice(0, 12000),
    `</材料>`,
  ].join('\n');
  const r = await clientCtx.connection.rpc.call('/api', 'session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  if (r?.ok === false) throw new Error(String(r.error?.message ?? 'prompt rejected'));
  return sessionId;
}

function ImportWizard({ call }: { call: (endpoint: string, payload?: unknown) => Promise<any> }) {
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('');
  const [engine, setEngine] = useState('');
  const [env, setEnv] = useState('');
  const [phase, setPhase] = useState<'input' | 'analyzing' | 'review'>('input');
  const [msg, setMsg] = useState('');
  const [importId, setImportId] = useState('');
  const [staging, setStaging] = useState<any[]>([]);
  const [imp, setImp] = useState<any>(null);

  const loadStaging = async (id: string) => {
    const s = await call('staging/list', { importId: id }).then((v) => v.staging).catch(() => []);
    setStaging(s);
    const list = await call('imports/list').then((v) => v.imports).catch(() => []);
    setImp((list as any[]).find((x) => x.id === id) ?? null);
  };

  const analyze = async () => {
    if (text.trim() === '') { setMsg('请先粘贴材料正文'); return; }
    setPhase('analyzing'); setMsg('向量线入库中（切块 + 嵌入，服务端确定性完成）…');
    // 1) 向量线：服务端直接入库，确定性、不依赖模型
    let r: any;
    try { r = await call('imports/create', { title: title || '未命名材料', text, source: title || undefined, materialKind: kind || undefined, engine: engine || undefined, env: env || undefined }); }
    catch (e) { setPhase('input'); setMsg(`向量入库失败：${String((e as any)?.message ?? e)}`); return; }
    const id = r.importId; setImportId(id); await loadStaging(id);
    setPhase('review'); setMsg(`向量线已入库 ${r.vectorChunks} 段。图线：正在让智能体从材料抽取关系候选…`);
    // 2) 图线：best-effort 让模型抽候选边（模型不配合也不影响向量入库与人审）
    void (async () => {
      try { await extractEdgesInSession(text, id); } catch { setMsg('向量线已入库。图线抽取触发失败——可稍后在会话里让智能体用 kb_extract 补充。'); return; }
      for (let i = 0; i < 70; i += 1) {
        await new Promise((rr) => setTimeout(rr, 3000));
        const s = await call('staging/list', { importId: id }).then((v) => v.staging).catch(() => []);
        if ((s as any[]).length > 0) { setStaging(s); setMsg(`向量线已入库 ${r.vectorChunks} 段；图线抽出 ${(s as any[]).length} 条候选关系,请人审。`); return; }
      }
      setMsg(`向量线已入库 ${r.vectorChunks} 段；图线未抽到候选关系（材料里可能没有明确关系,或模型未配合）。`);
    })();
  };

  const decide = async (id: string, decision: 'accept' | 'reject') => {
    await call('staging/decide', { id, decision }).catch(() => {});
    await loadStaging(importId);
  };
  const commit = async () => {
    const r = await call('imports/commit', { importId }).catch((e) => ({ error: String(e?.message ?? e) }));
    setMsg(`已入库：${r.edges ?? 0} 条关系进入确定性图（confidence=1.0）。向量线已在分析阶段入库。`);
    await loadStaging(importId);
  };

  const box: any = { border: `1px solid ${T.line}`, borderRadius: 8, padding: '8px 11px', font: `13.5px ${FONT}`, width: '100%', background: '#fff', color: T.ink, outline: 'none' };
  const btn = (primary: boolean): any => ({ border: `1px solid ${T.blue}`, background: primary ? T.blue : '#fff', color: primary ? '#fff' : T.blue, borderRadius: 8, padding: '7px 16px', fontSize: 13.5, fontWeight: 500, cursor: 'pointer' });
  const mini = (c: string): any => ({ border: `1px solid ${c}`, color: c, background: '#fff', borderRadius: 6, padding: '1px 9px', fontSize: 12.5, cursor: 'pointer' });
  const willImport = staging.filter((s) => s.decision !== 'reject').length;   // 默认纳入，否决除外

  return (
    <div style={{ fontFamily: FONT, color: T.ink, lineHeight: 1.6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 2 }}>
        <span style={{ fontSize: 20, fontWeight: 600 }}>导入知识</span>
        <span style={{ fontSize: 13.5, color: T.dim }}>把文本材料分析后分流进三库 · 模型提议 / 人审确认 / 确定性入库</span>
      </div>

      {phase !== 'review' ? (
        <div style={{ ...card, padding: 16, marginTop: 14, maxWidth: 860 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10, marginBottom: 10 }}>
            <input style={box} placeholder="材料标题（如 工行 openGauss 变更管理规范 v3）" value={title} onChange={(e) => setTitle(e.target.value)} />
            <select style={box} value={kind} onChange={(e) => setKind(e.target.value)}><option value="">类型（自动判定）</option>{KIND_OPTS.map((k) => <option key={k} value={k}>{k}</option>)}</select>
            <input style={box} placeholder="适用引擎（openGauss）" value={engine} onChange={(e) => setEngine(e.target.value)} />
            <input style={box} placeholder="适用环境（生产）" value={env} onChange={(e) => setEnv(e.target.value)} />
          </div>
          <textarea style={{ ...box, minHeight: 200, resize: 'vertical', lineHeight: 1.6 }} placeholder="粘贴材料正文（规范 / 工单 / 故障总结 / 预案，纯文本或 markdown）……" value={text} onChange={(e) => setText(e.target.value)} />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
            <button type="button" style={btn(true)} disabled={phase === 'analyzing'} onClick={() => void analyze()}>{phase === 'analyzing' ? '分析中…' : '分析并导入'}</button>
            <span style={{ fontSize: 13, color: phase === 'analyzing' ? T.blue : T.dim }}>{msg || '向量线（切块+embed）自动入库；图线由模型抽候选关系，进人审队列'}</span>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 14 }}>
          <div style={{ ...card, padding: '12px 16px', marginBottom: 14, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontWeight: 600 }}>《{imp?.filename ?? '材料'}》</span>
            <span style={{ fontSize: 13, color: T.sub }}>向量 <b style={{ color: T.vec }}>{imp?.vector_chunks ?? 0}</b> 段已入库 · 图候选 <b style={{ color: T.graph }}>{staging.length}</b> 条待人审</span>
            <span style={{ marginLeft: 'auto', fontSize: 13, color: T.dim }}>{msg}</span>
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, margin: '4px 0 8px' }}>人审：图候选关系<span style={{ fontSize: 13, color: T.dim, fontWeight: 400, marginLeft: 8 }}>向量线已自动入库，此处只审图。<b>默认纳入</b>，点「否决」剔除错的；确认入库后未否决的边 confidence=1.0 进确定性推理</span></div>
          <div style={{ ...card, padding: '4px 16px 8px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
              <thead><tr>{['候选关系', '置信', '出处', '处置'].map((h, i) => <th key={h} style={{ textAlign: i === 1 ? 'right' : 'left', fontSize: 12.5, color: T.dim, fontWeight: 500, padding: '9px 10px', borderBottom: `1px solid ${T.line}`, whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
              <tbody>
                {staging.map((s) => (
                  <tr key={s.id} style={{ opacity: s.decision === 'reject' ? 0.45 : 1 }}>
                    <td style={{ padding: '9px 10px', borderTop: `1px solid ${T.line}` }}><b>{s.src_name}</b> <span style={{ font: `600 12px ${mono}`, borderRadius: 5, padding: '1px 7px', background: T.graph + '18', color: T.graph }}>{REL_CN[s.rel_type] ?? s.rel_type}</span> <b>{s.dst_name}</b></td>
                    <td style={{ padding: '9px 10px', borderTop: `1px solid ${T.line}`, textAlign: 'right', ...tnum }}>{Number(s.confidence).toFixed(2)}</td>
                    <td style={{ padding: '9px 10px', borderTop: `1px solid ${T.line}`, fontFamily: mono, fontSize: 12, color: T.sub }}>{s.source_locator ?? '—'}</td>
                    <td style={{ padding: '9px 10px', borderTop: `1px solid ${T.line}`, whiteSpace: 'nowrap' }}>
                      <span style={{ ...mini(s.decision !== 'reject' ? T.ok : T.line), color: s.decision !== 'reject' ? T.ok : T.sub }} onClick={() => void decide(s.id, 'accept')}>{s.decision === 'reject' ? '纳入' : '✓ 纳入'}</span>{' '}
                      <span style={{ ...mini(s.decision === 'reject' ? T.crit : T.line), color: s.decision === 'reject' ? T.crit : T.sub }} onClick={() => void decide(s.id, 'reject')}>否决</span>
                    </td>
                  </tr>
                ))}
                {staging.length === 0 ? <tr><td colSpan={4} style={{ padding: '12px 10px', color: T.dim }}>本材料未抽出关系候选（仅向量线入库）。</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14 }}>
            <button type="button" style={btn(true)} onClick={() => void commit()}>确认入库（图 {willImport} 条将入图）</button>
            <button type="button" style={btn(false)} onClick={() => { setPhase('input'); setText(''); setTitle(''); setStaging([]); setMsg(''); }}>再导一份</button>
            <span style={{ marginLeft: 'auto', fontSize: 13, color: T.dim }}>入库写引用台账：每条边可追到材料与出处</span>
          </div>
        </div>
      )}

      <div style={{ fontSize: 13, color: T.dim, border: `1px dashed ${T.line}`, borderRadius: 8, padding: '10px 16px', marginTop: 18, lineHeight: 1.8 }}>
        <b>两条线不对称</b>：向量线是纯管线（切块 → 嵌入 → 入库），不需人审、错了可重灌；图线是模型抽候选 → 你确认 → confidence=1.0 才进确定性推理。
        <b>拓扑/依赖/变更史不在此</b>——那些由采集器直写图，不经导入。
      </div>
    </div>
  );
}

/** 注册知识库面板：桥已在就直接注册，否则排进 __pending 由后到的 ui-harness 兑现（同 ui-cluster）。 */
function registerKnowledgePanelSafe(key: string, Comp: any): void {
  if (typeof window === 'undefined') return;
  const w = window as any;
  if (w.__opendbHarness__?.registerKnowledgePanel !== undefined) { w.__opendbHarness__.registerKnowledgePanel(Comp, key); return; }
  w.__opendbHarness__ = w.__opendbHarness__ ?? {};
  w.__opendbHarness__.__pending = [...(w.__opendbHarness__.__pending ?? []), { kind: 'knowledge', key, comp: Comp }];
}

export function apply(ctx: any): void {
  clientCtx = ctx;
  const call = async (endpoint: string, payload: unknown = {}): Promise<any> => {
    const r = await ctx.connection.rpc.call('/opendb-knowledge', endpoint, payload);
    if (!r.ok) throw new Error(r.error?.message ?? 'request failed');
    return r.value;
  };
  registerKnowledgePanelSafe('dashboard', () => <Boundary><Dashboard call={call} /></Boundary>);
  registerKnowledgePanelSafe('import', () => <Boundary><ImportWizard call={call} /></Boundary>);
}
