/**
 * task-health client 面板（R4 原型①单实例 / ④集群汇总，按 report.data.scope 自适应）。
 * 视觉 token = dsh 原版实拍基准（docs/2026-08-21-task-redo-design.md §6）。
 * 纯展示无操作按钮（交互纲领 §15）；数据走注入的 /opendb 通道 runs/list。
 */
import { useEffect, useState } from 'react';

export const inject = ['slots'];

const T = {
  ink: '#0f1115', sub: '#61666b', dim: '#81858c', blue: '#4176e6',
  line: 'rgba(0,0,0,.08)', fill: '#f7f8fa',
  sev: {
    ok: { c: '#3fa552', soft: '#e8f5ec', cn: '正常', grad: 'linear-gradient(135deg,#3fa552,#2f8541)' },
    notice: { c: '#c9862d', soft: '#faf3e5', cn: '关注', grad: 'linear-gradient(135deg,#c9862d,#a96e1f)' },
    warn: { c: '#e07a1f', soft: '#fdf0e3', cn: '告警', grad: 'linear-gradient(135deg,#e07a1f,#c9640f)' },
    critical: { c: '#d64545', soft: '#fdecec', cn: '严重', grad: 'linear-gradient(135deg,#d64545,#b53434)' },
  } as Record<string, { c: string; soft: string; cn: string; grad: string }>,
};
const sev = (level: string) => T.sev[level] ?? T.sev.ok;
const ORDER: Record<string, number> = { critical: 3, warn: 2, notice: 1, ok: 0 };

const card: any = { background: '#fff', border: `1px solid ${T.line}`, borderRadius: 8, padding: '13px 16px', boxShadow: '0 4px 12px rgba(0,0,0,.02),0 2px 8px rgba(0,0,0,.04)' };

function Dot({ level }: { level: string }) {
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: sev(level).c, marginRight: 6, verticalAlign: 'baseline' }} />;
}

function StatusBand({ data, when }: { data: any; when?: string }) {
  const worst = String(data?.det?.worst ?? 'ok');
  const s = sev(worst);
  const counts = data?.det?.counts ?? {};
  const driver = (data?.findings ?? []).slice().sort((a: any, b: any) => (ORDER[b.level] ?? 0) - (ORDER[a.level] ?? 0))[0];
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'stretch' }}>
      <div style={{ borderRadius: 12, padding: '16px 22px', color: '#fff', minWidth: 200, background: s.grad, display: 'flex', flexDirection: 'column', gap: 4, justifyContent: 'center' }}>
        <span style={{ fontSize: 11, opacity: 0.8, letterSpacing: '.1em' }}>{String(data?.scope) === 'cluster' ? '集群总体状态 · 取最差实例' : '总体状态'}</span>
        <span style={{ fontSize: 24, fontWeight: 600, letterSpacing: 1 }}>{s.cn}</span>
        {driver !== undefined ? <span style={{ fontSize: 12, opacity: 0.92, maxWidth: 260, lineHeight: 1.5 }}>驱动：{String(driver.detail ?? driver.item ?? '')}</span> : null}
      </div>
      <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 7, justifyContent: 'center' }}>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12, background: T.sev.ok.soft, color: T.sev.ok.c, borderRadius: 6, padding: '3px 10px', fontWeight: 500, width: 'fit-content' }}>
          ✓ 已锚定 · 确定性发现全覆盖 · 状态不可被解读下调
        </span>
        <span style={{ fontSize: 12, color: T.dim }}>
          严重 <b style={{ color: T.sev.critical.c }}>{Number(counts.critical ?? 0)}</b> · 告警 <b style={{ color: T.sev.warn.c }}>{Number(counts.warn ?? 0)}</b> · 关注 <b style={{ color: T.sev.notice.c }}>{Number(counts.notice ?? 0)}</b>
          {when !== undefined ? <span> · 完成于 {when}</span> : null}
        </span>
        {(data?.collectionNotes ?? []).length > 0
          ? <span style={{ fontSize: 12, color: T.sev.warn.c }}>⚠ {data.collectionNotes.length} 个维度采集降级（见底部 Collection Notes）</span>
          : <span style={{ fontSize: 12, color: T.dim }}>全部维度采集成功 · 0 降级</span>}
      </div>
    </div>
  );
}

function DimMatrix({ node }: { node: any }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 8 }}>
      {(node?.dims ?? []).map((d: any) => (
        <div key={String(d.dim)} style={{ ...card, padding: '8px 12px' }}>
          <div style={{ fontSize: 12, color: T.sub }}><Dot level={d.ok ? String(d.worst) : 'notice'} />{String(d.title)}</div>
          <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2, color: d.ok ? sev(String(d.worst)).c : T.dim }}>
            {d.ok ? sev(String(d.worst)).cn : '降级'}
          </div>
        </div>
      ))}
    </div>
  );
}

function FindingCard({ f }: { f: any }) {
  const s = sev(String(f.level));
  return (
    <div style={{ ...card, borderLeft: `3px solid ${s.c}`, marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Dot level={String(f.level)} />
        <b style={{ fontSize: 13 }}>{String(f.item ?? '')}</b>
        {String(f.code ?? '') !== '' ? <span style={{ font: '600 10.5px "JetBrains Mono",Menlo,monospace', background: T.fill, border: `1px solid ${T.line}`, borderRadius: 5, padding: '1px 6px', color: T.sub }}>{String(f.code)}</span> : null}
        {String(f.node ?? '') !== '' ? <span style={{ fontSize: 11, color: T.dim }}>@{String(f.node)}</span> : null}
        {String(f.value ?? '') !== '' && String(f.threshold ?? '') !== '' ? <span style={{ marginLeft: 'auto', fontSize: 11, color: T.dim }}>实测 <b style={{ color: s.c }}>{String(f.value)}</b> · 阈值 {String(f.threshold)}</span> : null}
      </div>
      {String(f.detail ?? '') !== '' ? <div style={{ fontSize: 12.5, color: T.sub, marginTop: 6 }}>{String(f.detail)}</div> : null}
      {String(f.evidence ?? '') !== '' ? <div style={{ fontSize: 11.5, color: T.dim, marginTop: 4, fontFamily: '"JetBrains Mono",Menlo,monospace' }}>证据 {String(f.evidence)}</div> : null}
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
              <b style={{ fontSize: 13 }}>{String(n.node)}</b>
              <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: s.c }}>{s.cn}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function H2({ children }: { children: any }) {
  return <div style={{ fontSize: 14, fontWeight: 500, margin: '22px 0 10px', color: T.ink }}>{children}</div>;
}

export function HealthPanel({ task, call }: { task: any; call: (endpoint: string, payload?: unknown) => Promise<any> }) {
  const [runs, setRuns] = useState<any[]>([]);
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

  const latest = runs.find((r) => r.report !== undefined);
  const data = latest?.report?.data;
  if (error !== '') return <div style={{ fontSize: 13, color: T.dim, padding: 16 }}>加载失败：{error}</div>;
  if (data === undefined) return <div style={{ fontSize: 13, color: T.dim, padding: 16 }}>还没有健康检查报告——任务触发后（cron 或在会话里说一声）报告会出现在这里。</div>;

  const isCluster = String(data.scope) === 'cluster';
  const findings = (data.findings ?? []).slice().sort((a: any, b: any) => (ORDER[b.level] ?? 0) - (ORDER[a.level] ?? 0));
  const abnormal = findings.filter((f: any) => String(f.level) !== 'ok');
  const when = latest?.finishedAt !== undefined && latest?.finishedAt !== null ? String(latest.finishedAt).replace('T', ' ').slice(0, 19) : undefined;
  const singleNode = !isCluster ? (data.det?.byNode?.[0]?.node ?? '') : '';

  return (
    <div style={{ fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif', color: T.ink, lineHeight: 1.6 }}>
      <StatusBand data={data} when={when} />

      {isCluster ? (
        <>
          <H2>实例健康矩阵 <span style={{ fontSize: 12, color: T.dim, fontWeight: 400 }}>每格一实例 · 状态 = 该实例确定性最差严重度</span></H2>
          <ClusterGrid data={data} />
          {(data.clusterFindings ?? []).length > 0 ? (
            <>
              <H2>集群级发现 <span style={{ fontSize: 12, color: T.dim, fontWeight: 400 }}>跨实例共性 / 配置漂移 / 最差上浮</span></H2>
              {(data.clusterFindings ?? []).map((f: any, i: number) => (
                <FindingCard key={i} f={{ ...f, node: (f.nodes ?? []).join(', ') }} />
              ))}
            </>
          ) : null}
        </>
      ) : null}

      {String(data.rootCause ?? '') !== '' ? (
        <>
          <H2>根因串联</H2>
          <div style={{ ...card, background: T.fill, border: 'none' }}>
            <div style={{ fontSize: 13, color: T.sub }}>{String(data.rootCause)}</div>
          </div>
        </>
      ) : null}

      <H2>发现 <span style={{ fontSize: 12, color: T.dim, fontWeight: 400 }}>按严重度排序 · 每条 = 证据 → 阈值 → 解读</span></H2>
      {abnormal.length === 0 ? <div style={{ fontSize: 13, color: T.sev.ok.c }}>✓ 无异常发现，{isCluster ? '全部实例' : singleNode} 各维在阈值内。</div>
        : abnormal.map((f: any, i: number) => <FindingCard key={i} f={f} />)}

      {(data.priorities ?? []).length > 0 ? (
        <>
          <H2>处置优先级 <span style={{ fontSize: 12, color: T.dim, fontWeight: 400 }}>P0/P1/P2 按影响面排 · 与严重度是两个维度</span></H2>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {(data.priorities ?? []).map((p: any, i: number) => (
              <div key={i} style={{ ...card, flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: T.sub, letterSpacing: '.05em' }}>{String(p.p)}</div>
                <div style={{ fontSize: 13, marginTop: 4 }}>{String(p.action)}</div>
                {(p.refs ?? []).length > 0 ? <div style={{ fontSize: 11, color: T.dim, marginTop: 4 }}>关联 {(p.refs ?? []).join(', ')}</div> : null}
              </div>
            ))}
          </div>
        </>
      ) : null}

      {(data.collectionNotes ?? []).length > 0 ? (
        <div style={{ fontSize: 12, color: T.dim, border: `1px dashed ${T.line}`, borderRadius: 8, padding: '8px 14px', marginTop: 16 }}>
          📋 Collection Notes：{(data.collectionNotes ?? []).map((n: any, i: number) => <div key={i}>{String(n)}</div>)}
        </div>
      ) : null}

      <div style={{ fontSize: 12, color: T.dim, marginTop: 16 }}>
        近 {runs.length} 次运行：{runs.slice(0, 10).map((r: any, i: number) => (
          <span key={i} style={{ marginRight: 8 }}>
            <Dot level={r.report?.data?.det?.worst ?? (r.status === 'succeeded' ? 'ok' : 'notice')} />
            {String(r.firedAt ?? '').slice(5, 16).replace('T', ' ')}
          </span>
        ))}
      </div>
    </div>
  );
}

export function apply(_ctx: any): void {
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    const bridge = (window as any).__opendbHarness__;
    if (bridge?.registerTaskPanel !== undefined) { bridge.registerTaskPanel('health', HealthPanel); clearInterval(timer); }
    else if (tries > 40) clearInterval(timer);
  }, 250);
}
