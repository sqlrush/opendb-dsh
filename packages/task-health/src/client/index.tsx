/**
 * task-health client 面板（R4 设计稿对齐版）：状态带+锚定徽章 → 12 维环形图+维度矩阵（含关键值）
 * → 发现卡（阈值水位条 + 💬会话深挖）→ P0/P1/P2 → 检查历史趋势条（点格子切换历史报告）。
 * 集群 scope：实例矩阵 + 集群级发现。视觉 token = dsh 原版基准；只读展示。
 */
import { useEffect, useState } from 'react';

export const inject = ['slots'];

const T = {
  ink: '#0f1115', sub: '#61666b', dim: '#81858c', blue: '#4176e6',
  line: 'rgba(0,0,0,.08)', fill: '#f7f8fa', blueSoft: '#e4edfd',
  sev: {
    ok: { c: '#3fa552', soft: '#e8f5ec', cn: '正常', grad: 'linear-gradient(135deg,#3fa552,#2f8541)' },
    notice: { c: '#c9862d', soft: '#faf3e5', cn: '关注', grad: 'linear-gradient(135deg,#c9862d,#a96e1f)' },
    warn: { c: '#e07a1f', soft: '#fdf0e3', cn: '告警', grad: 'linear-gradient(135deg,#e07a1f,#c9640f)' },
    critical: { c: '#d64545', soft: '#fdecec', cn: '严重', grad: 'linear-gradient(135deg,#d64545,#b53434)' },
  } as Record<string, { c: string; soft: string; cn: string; grad: string }>,
};
const sev = (l: string) => T.sev[l] ?? T.sev.ok;
const ORDER: Record<string, number> = { critical: 3, warn: 2, notice: 1, ok: 0 };
const card: any = { background: '#fff', border: `1px solid ${T.line}`, borderRadius: 8, padding: '16px 20px', boxShadow: '0 4px 12px rgba(0,0,0,.02),0 2px 8px rgba(0,0,0,.04)' };
const mono = '"JetBrains Mono","SF Mono",Menlo,monospace';

function H2({ children }: { children: any }) {
  return <div style={{ fontSize: 18, fontWeight: 600, margin: '30px 0 14px', color: T.ink, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{children}</div>;
}
function Hint({ children }: { children: any }) {
  return <span style={{ fontSize: 13.5, color: T.dim, fontWeight: 400 }}>{children}</span>;
}
function Dot({ level }: { level: string }) {
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: sev(level).c, marginRight: 6, flex: 'none' }} />;
}

/** 12 维清单（与 collectors.ts COLLECTORS 对齐）；环与矩阵从 findings 派生每维状态 */
const DIMS: { dim: string; title: string }[] = [
  { dim: 'overview', title: '总览' }, { dim: 'waits', title: '等待事件' }, { dim: 'slowsql', title: '慢 SQL' },
  { dim: 'xact', title: '长·空闲事务' }, { dim: 'bloat', title: '膨胀' }, { dim: 'lwlock', title: 'LWLock' },
  { dim: 'lockchain', title: '锁与阻塞链' }, { dim: 'connections', title: '连接' }, { dim: 'ckpt', title: 'Checkpoint/WAL' },
  { dim: 'replication', title: '主备复制' }, { dim: 'objects', title: '对象与索引' }, { dim: 'concurrency', title: '事务并发' },
];
/** 旧报告无 dim 字段时按 code 前缀映射维度 */
const CODE_DIM: [RegExp, string][] = [
  [/^XACT_PREPARED/, 'concurrency'], [/^XACT_/, 'xact'], [/^CACHE_/, 'overview'], [/^WAIT_/, 'waits'],
  [/^SLOWSQL/, 'slowsql'], [/^BLOAT_/, 'bloat'], [/^LWLOCK_/, 'lwlock'], [/^LOCK_/, 'lockchain'],
  [/^CONN_/, 'connections'], [/^CKPT_/, 'ckpt'], [/^REPL_/, 'replication'], [/^IDX_/, 'objects'],
  [/^SESS_/, 'concurrency'], [/^NODE_/, 'overview'],
];
function dimOf(f: any): string {
  const d = String(f.dim ?? '');
  if (d !== '') return d;
  const code = String(f.code ?? '');
  for (const [re, dim] of CODE_DIM) if (re.test(code)) return dim;
  return '';
}
/** findings → 每维状态（无 finding = ok） */
function dimStates(findings: any[]): { dim: string; title: string; worst: string; top?: any }[] {
  return DIMS.map((d) => {
    const list = findings.filter((f) => dimOf(f) === d.dim).sort((a, b) => (ORDER[String(b.level)] ?? 0) - (ORDER[String(a.level)] ?? 0));
    return { ...d, worst: list[0] !== undefined ? String(list[0].level) : 'ok', top: list[0] };
  });
}

/** 💬 会话深挖链接：v1 = 点击复制这句话（自动开会话并填话在后续接 dsh 会话 API） */
function DigLink({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span
      style={{ fontSize: 13.5, color: copied ? T.sev.ok.c : T.blue, cursor: 'pointer' }}
      onClick={() => {
        try { void navigator.clipboard.writeText(text); } catch { /* http 环境无 clipboard 权限 */ }
        setCopied(true); setTimeout(() => setCopied(false), 2000);
      }}
    >💬 {copied ? '已复制——到会话里粘贴发送即可' : `在会话里深挖：${text.length > 42 ? `${text.slice(0, 42)}…` : text}`}</span>
  );
}

/** 阈值水位条：仅对 0..1 比例类指标绘制（conn/cache/dead_tup 等） */
function ThresholdBar({ metric, value, level }: { metric: string; value: string; level: string }) {
  const v = Number(value);
  if (!/(ratio|share)$/.test(metric) || Number.isNaN(v) || v < 0 || v > 1) return null;
  return (
    <div style={{ position: 'relative', height: 6, borderRadius: 3, background: '#eceef3', margin: '8px 0 2px', maxWidth: 300 }}>
      <i style={{ position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3, width: `${Math.round(v * 100)}%`, background: sev(level).c, fontStyle: 'normal' }} />
      <u style={{ position: 'absolute', top: -2, bottom: -2, width: 2, left: '80%', background: T.sev.warn.c, textDecoration: 'none' }} />
      <s style={{ position: 'absolute', top: -2, bottom: -2, width: 2, left: '90%', background: T.sev.critical.c, textDecoration: 'none' }} />
    </div>
  );
}

/** 12 维环形图（设计稿裁决点①：环=总览重心，中心=确定性状态字，拒绝健康分） */
function Ring({ states, worst }: { states: { dim: string; title: string; worst: string }[]; worst: string }) {
  const n = Math.max(states.length, 1);
  const R = 62; const C = 2 * Math.PI * R;
  const seg = C / n;
  return (
    <div style={{ position: 'relative', width: 170, height: 170, margin: '4px auto' }}>
      <svg width={170} height={170} viewBox="0 0 170 170" style={{ transform: 'rotate(-90deg)' }}>
        {states.map((d, i) => (
          <circle key={d.dim} cx={85} cy={85} r={R} fill="none"
            stroke={sev(d.worst).c} strokeWidth={15}
            strokeDasharray={`${Math.max(seg - 3, 2)} ${C - Math.max(seg - 3, 2)}`}
            strokeDashoffset={-i * seg}>
            <title>{d.title} · {sev(d.worst).cn}</title>
          </circle>
        ))}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
        <b style={{ fontSize: 20, color: sev(worst).c }}>{sev(worst).cn}</b>
        <span style={{ fontSize: 12, color: T.dim }}>{n} 维 · 只讲证据</span>
      </div>
    </div>
  );
}

function StatusBand({ data, when }: { data: any; when?: string }) {
  const worst = String(data?.det?.worst ?? 'ok');
  const s = sev(worst);
  const counts = data?.det?.counts ?? {};
  const driver = (data?.findings ?? []).slice().sort((a: any, b: any) => (ORDER[b.level] ?? 0) - (ORDER[a.level] ?? 0))[0];
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'stretch' }}>
      <div style={{ borderRadius: 12, padding: '16px 22px', color: '#fff', minWidth: 200, background: s.grad, display: 'flex', flexDirection: 'column', gap: 4, justifyContent: 'center' }}>
        <span style={{ fontSize: 12, opacity: 0.8, letterSpacing: '.1em' }}>{String(data?.scope) === 'cluster' ? '集群总体状态 · 取最差实例' : '总体状态'}</span>
        <span style={{ fontSize: 24, fontWeight: 600, letterSpacing: 1 }}>{s.cn}</span>
        {driver !== undefined && String(driver.level) !== 'ok' ? <span style={{ fontSize: 13.5, opacity: 0.92, maxWidth: 280, lineHeight: 1.5 }}>驱动：{String(driver.detail ?? driver.item ?? '')}</span> : null}
      </div>
      <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 7, justifyContent: 'center' }}>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13.5, background: T.sev.ok.soft, color: T.sev.ok.c, borderRadius: 6, padding: '3px 10px', fontWeight: 500, width: 'fit-content' }}>
          ✓ 已锚定 · 确定性发现全覆盖 · 状态不可被解读下调
        </span>
        <span style={{ fontSize: 13.5, color: T.dim }}>
          严重 <b style={{ color: T.sev.critical.c }}>{Number(counts.critical ?? 0)}</b> · 告警 <b style={{ color: T.sev.warn.c }}>{Number(counts.warn ?? 0)}</b> · 关注 <b style={{ color: T.sev.notice.c }}>{Number(counts.notice ?? 0)}</b>
          {when !== undefined ? <span> · 完成于 {when}</span> : null}
        </span>
        {(data?.collectionNotes ?? []).length > 0
          ? <span style={{ fontSize: 13.5, color: T.sev.warn.c }}>⚠ {data.collectionNotes.length} 个维度采集降级（见底部 Collection Notes）</span>
          : <span style={{ fontSize: 13.5, color: T.dim }}>全部维度采集成功 · 0 降级 · 📄 报告已自动入库归档</span>}
      </div>
    </div>
  );
}

/** 维度矩阵：每格 = 维度名 + 关键值（来自该维最重发现，无发现则「正常」） */
function DimMatrix({ states }: { states: { dim: string; title: string; worst: string; top?: any }[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 8 }}>
      {states.map((d) => {
        const v = d.top !== undefined ? String(d.top.value ?? '') : '';
        const text = d.top === undefined ? '正常' : (v !== '' ? `${v} · ${String(d.top.code)}` : String(d.top.code ?? d.top.item ?? ''));
        return (
          <div key={d.dim} style={{ ...card, padding: '9px 12px' }}>
            <div style={{ fontSize: 13.5, color: T.sub }}><Dot level={d.worst} />{d.title}</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 3, color: sev(d.worst).c, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.top !== undefined ? String(d.top.detail ?? text) : text}>
              {text}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FindingCard({ f }: { f: any }) {
  const s = sev(String(f.level));
  return (
    <div style={{ ...card, borderLeft: `3px solid ${s.c}`, marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Dot level={String(f.level)} />
        <b style={{ fontSize: 16 }}>{String(f.item ?? '')}</b>
        {String(f.code ?? '') !== '' ? <span style={{ font: `600 11.5px ${mono}`, background: T.fill, border: `1px solid ${T.line}`, borderRadius: 5, padding: '1px 6px', color: T.sub }}>{String(f.code)}</span> : null}
        {String(f.node ?? '') !== '' ? <span style={{ fontSize: 12, color: T.dim }}>@{String(f.node)}</span> : null}
        {String(f.value ?? '') !== '' && String(f.threshold ?? '') !== '' ? <span style={{ marginLeft: 'auto', fontSize: 12, color: T.dim }}>实测 <b style={{ color: s.c }}>{String(f.value)}</b> · 阈值 {String(f.threshold)}</span> : null}
      </div>
      <ThresholdBar metric={String(f.metric ?? '')} value={String(f.value ?? '')} level={String(f.level)} />
      {String(f.detail ?? '') !== '' ? <div style={{ fontSize: 16, color: T.sub, marginTop: 6 }}>{String(f.detail)}</div> : null}
      {String(f.evidence ?? '') !== '' ? <div style={{ fontSize: 13, color: T.dim, marginTop: 4, fontFamily: mono }}>证据 {String(f.evidence)}</div> : null}
      {String(f.level) !== 'ok' ? (
        <div style={{ marginTop: 8 }}><DigLink text={`帮我深挖「${String(f.item ?? f.code)}」：${String(f.detail ?? '')}`} /></div>
      ) : null}
    </div>
  );
}

function ClusterGrid({ data }: { data: any }) {
  const byNode = data?.det?.byNode ?? [];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(170px,1fr))', gap: 8 }}>
      {byNode.map((n: any) => {
        const s = sev(String(n.worst));
        return (
          <div key={String(n.node)} style={{ ...card, borderLeft: `4px solid ${s.c}`, padding: '10px 12px' }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <b style={{ fontSize: 16 }}>{String(n.node)}</b>
              <span style={{ marginLeft: 'auto', fontSize: 13.5, fontWeight: 600, color: s.c }}>{s.cn}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 检查历史趋势条：一格一次运行（旧→新），点格子查看该次报告（阿里 DAS 式，裁决点③） */
function RunStrip({ runs, selId, onSel }: { runs: any[]; selId: string; onSel: (id: string) => void }) {
  const cells = runs.slice(0, 30).reverse();
  if (cells.length === 0) return null;
  return (
    <div style={{ ...card }}>
      <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 26 }}>
        {cells.map((r: any) => {
          const lv = String(r.report?.data?.det?.worst ?? (r.status === 'succeeded' ? 'ok' : 'notice'));
          const isSel = r.id === selId;
          return (
            <i key={String(r.id)} title={`${String(r.firedAt).replace('T', ' ').slice(0, 16)} · ${lv}`}
              onClick={() => r.report !== undefined && onSel(String(r.id))}
              style={{ flex: 1, maxWidth: 16, height: '100%', borderRadius: 3, background: sev(lv).c, cursor: r.report !== undefined ? 'pointer' : 'default', fontStyle: 'normal', outline: isSel ? `2px solid ${T.ink}` : 'none', outlineOffset: 1, opacity: r.report !== undefined ? 1 : 0.35 }} />
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: T.dim, marginTop: 6 }}>
        <span>{String(cells[0]?.firedAt ?? '').slice(5, 10)}</span>
        <span>最新 ▲ · 点格子查看当次完整报告</span>
      </div>
    </div>
  );
}

export function HealthPanel({ task, call }: { task: any; call: (endpoint: string, payload?: unknown) => Promise<any> }) {
  const [runs, setRuns] = useState<any[]>([]);
  const [selId, setSelId] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () => {
      call('runs/list', { taskId: task.id })
        .then((v) => { if (alive) { setRuns(v?.runs ?? []); setError(''); } })
        .catch((e) => { if (alive) setError(String(e?.message ?? e)); });
    };
    load();
    const timer = setInterval(load, 30000);
    return () => { alive = false; clearInterval(timer); };
  }, [task.id]);

  const withReport = runs.filter((r) => r.report !== undefined);
  const current = withReport.find((r) => r.id === selId) ?? withReport[0];
  const data = current?.report?.data;
  if (error !== '') return <div style={{ fontSize: 16, color: T.dim, padding: 16 }}>加载失败：{error}</div>;
  if (data === undefined) return <div style={{ fontSize: 16, color: T.dim, padding: 16 }}>还没有健康检查报告——任务触发后（cron 或在会话里说一声）报告会出现在这里。</div>;

  const isCluster = String(data.scope) === 'cluster';
  const findings = (data.findings ?? []).slice().sort((a: any, b: any) => (ORDER[b.level] ?? 0) - (ORDER[a.level] ?? 0));
  const abnormal = findings.filter((f: any) => String(f.level) !== 'ok');
  const when = current?.finishedAt !== undefined && current?.finishedAt !== null ? String(current.finishedAt).replace('T', ' ').slice(0, 19) : undefined;

  return (
    <div style={{ fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif', color: T.ink, lineHeight: 1.75 }}>
      <StatusBand data={data} when={when} />

      {isCluster ? (
        <>
          <H2>实例健康矩阵 <Hint>每格一实例 · 状态 = 该实例确定性最差严重度</Hint></H2>
          <ClusterGrid data={data} />
          {(data.clusterFindings ?? []).length > 0 ? (
            <>
              <H2>集群级发现 <Hint>跨实例共性 / 配置漂移 / 最差上浮——汇总 ≠ N 份单机报告钉一起</Hint></H2>
              {(data.clusterFindings ?? []).map((f: any, i: number) => (
                <FindingCard key={i} f={{ ...f, node: (f.nodes ?? []).join(', ') }} />
              ))}
            </>
          ) : null}
        </>
      ) : (
        <>
          <H2>十二维体检 <Hint>环 = 总览重心（中心是确定性状态，拒绝健康分）· 矩阵 = 每维关键值</Hint></H2>
          <div style={{ display: 'grid', gridTemplateColumns: '210px 1fr', gap: 14, alignItems: 'start' }}>
            <div style={{ ...card, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <Ring states={dimStates(findings)} worst={String(data.det?.worst ?? 'ok')} />
            </div>
            <DimMatrix states={dimStates(findings)} />
          </div>
        </>
      )}

      {String(data.rootCause ?? '') !== '' ? (
        <>
          <H2>根因串联</H2>
          <div style={{ ...card, background: T.fill, border: 'none' }}>
            <div style={{ fontSize: 16, color: T.sub }}>{String(data.rootCause)}</div>
          </div>
        </>
      ) : null}

      <H2>发现 <Hint>按严重度排序 · 每条 = 证据 → 阈值 → 解读</Hint></H2>
      {abnormal.length === 0 ? <div style={{ fontSize: 16, color: T.sev.ok.c }}>✓ 无异常发现，各维在阈值内。</div>
        : abnormal.map((f: any, i: number) => <FindingCard key={i} f={f} />)}

      {(data.priorities ?? []).length > 0 ? (
        <>
          <H2>处置优先级 <Hint>P0/P1/P2 按影响面排 · 与严重度是两个维度</Hint></H2>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {(data.priorities ?? []).map((p: any, i: number) => (
              <div key={i} style={{ ...card, flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: T.sub, letterSpacing: '.05em' }}>{String(p.p)}</div>
                <div style={{ fontSize: 16, marginTop: 4 }}>{String(p.action)}</div>
                {(p.refs ?? []).length > 0 ? <div style={{ fontSize: 12, color: T.dim, marginTop: 4 }}>关联 {(p.refs ?? []).join(', ')}</div> : null}
              </div>
            ))}
          </div>
        </>
      ) : null}

      <H2>检查历史 <Hint>一格一次运行 · 点格子查看当次报告</Hint></H2>
      <RunStrip runs={runs} selId={String(current?.id ?? '')} onSel={setSelId} />

      {(data.collectionNotes ?? []).length > 0 ? (
        <div style={{ fontSize: 13.5, color: T.dim, border: `1px dashed ${T.line}`, borderRadius: 8, padding: '8px 14px', marginTop: 16 }}>
          📋 Collection Notes：{(data.collectionNotes ?? []).map((n: any, i: number) => <div key={i}>{String(n)}</div>)}
        </div>
      ) : null}
    </div>
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

export function apply(_ctx: any): void {
  registerPanel('health', HealthPanel);
}
