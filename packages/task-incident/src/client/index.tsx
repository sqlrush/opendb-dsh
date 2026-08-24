/**
 * DDL 事故响应的 client 半边（双半边插件）：最新事故报告大盘——
 * severity 徽标 + 受影响节点 findings + 根因推测 + 建议动作（只读清单）+ 近 10 次触发时间线。
 * 纲领 §15：纯展示，无操作按钮；调整策略在会话里说。
 */
import { useEffect, useState } from 'react';

export const inject = ['slots'];

const T = {
  dim: 'var(--dsw-alias-label-tertiary)',
  sub: 'var(--dsw-alias-label-secondary)',
  border: 'var(--dsw-alias-border-l1)',
};
const LEVEL_COLOR: Record<string, string> = { ok: '#3fa552', warn: '#c9862d', critical: '#d64545' };

function IncidentPanel({ task, call }: { task: any; call: (e: string, p?: unknown) => Promise<any> }) {
  const [runs, setRuns] = useState<any[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => call('runs/list', { taskId: task.id }).then((r) => { if (live) setRuns(r.runs); }).catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => { live = false; clearInterval(t); };
  }, [task.id]);

  const latest = runs.find((r) => r.report !== undefined);
  const findings: any[] = latest?.report?.data?.findings ?? [];
  const rootCause: string = latest?.report?.data?.rootCause ?? '';
  const actions: string[] = latest?.report?.data?.actions ?? [];
  const byNode = new Map<string, any[]>();
  for (const f of findings) (byNode.get(f.node) ?? byNode.set(f.node, []).get(f.node))!.push(f);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <b style={{ fontSize: 15 }}>{task.name}</b>
        <span style={{ color: T.dim, fontSize: 12 }}>DDL 事故响应 · 告警触发 · 调整策略请在会话里告诉智能体</span>
      </div>

      {latest === undefined
        ? <div style={{ color: T.dim, marginTop: 16, fontSize: 13 }}>暂无事故——检测到预期外 DDL 变更时会自动触发诊断并在这里出报告</div>
        : (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0' }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#fff', background: LEVEL_COLOR[latest.report.severity] ?? T.dim, borderRadius: 6, padding: '1px 7px' }}>{latest.report.severity}</span>
              <span style={{ fontSize: 14 }}>{latest.report.summary}</span>
              <span style={{ color: T.dim, fontSize: 12, marginLeft: 'auto' }}>{String(latest.firedAt).replace('T', ' ').slice(0, 16)}</span>
            </div>

            {rootCause !== '' && (
              <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: '10px 14px', marginBottom: 12 }}>
                <span style={{ color: T.sub, fontSize: 12, fontWeight: 600 }}>根因推测</span>
                <div style={{ fontSize: 13, marginTop: 4 }}>{rootCause}</div>
              </div>
            )}

            {[...byNode.entries()].map(([node, list]) => (
              <div key={node} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, marginBottom: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 6 }}>{node}</div>
                {list.map((f, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 13, alignItems: 'baseline' }}>
                    <span style={{ width: 7, height: 7, borderRadius: 4, background: LEVEL_COLOR[f.level] ?? T.dim, flexShrink: 0, position: 'relative', top: -1 }} />
                    <span style={{ color: T.sub, flexShrink: 0 }}>{f.item}</span>
                    <span>{f.detail}</span>
                  </div>
                ))}
              </div>
            ))}

            {actions.length > 0 && (
              <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: '10px 14px', marginBottom: 12 }}>
                <span style={{ color: T.sub, fontSize: 12, fontWeight: 600 }}>建议动作（自动处置未开放，需人工执行）</span>
                <ol style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }}>
                  {actions.map((a, i) => <li key={i}>{a}</li>)}
                </ol>
              </div>
            )}
          </div>
        )}

      <div style={{ fontSize: 13, fontWeight: 600, margin: '16px 0 6px' }}>近 10 次触发</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {runs.slice(0, 10).map((r) => (
          <span key={r.id} title={`${String(r.firedAt).replace('T', ' ').slice(0, 16)} · ${r.triggerKind} · ${r.status}${r.report ? ` · ${r.report.severity}` : ''}`}
            style={{
              width: 12, height: 12, borderRadius: 3,
              background: r.report !== undefined ? (LEVEL_COLOR[r.report.severity] ?? T.dim) : r.status === 'failed' ? '#d64545' : 'var(--dsw-alias-border-l2)',
              opacity: r.status === 'running' || r.status === 'queued' ? 0.45 : 1,
            }} />
        ))}
        {runs.length === 0 && <span style={{ color: T.dim, fontSize: 12 }}>还没有触发记录</span>}
      </div>
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
  registerPanel('incident', IncidentPanel);
}
