/**
 * 定期巡检任务的 client 半边（双半边插件契约首践）：经 window 桥注册专属大盘面板。
 * 纲领 §15：纯展示、无操作按钮——调整任务在会话里说。
 */
import { useEffect, useState } from 'react';

export const inject = ['slots'];

const T = {
  dim: 'var(--dsw-alias-label-tertiary)',
  border: 'var(--dsw-alias-border-l1)',
};
const LEVEL_COLOR: Record<string, string> = { ok: '#3fa552', warn: '#c9862d', critical: '#d64545' };

function Badge({ level }: { level: string }) {
  const c = LEVEL_COLOR[level] ?? T.dim;
  return <span style={{ display: 'inline-block', fontSize: 11, fontWeight: 600, color: '#fff', background: c, borderRadius: 6, padding: '1px 7px' }}>{level}</span>;
}

function InspectionPanel({ task, call }: { task: any; call: (e: string, p?: unknown) => Promise<any> }) {
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
  const byNode = new Map<string, any[]>();
  for (const f of findings) (byNode.get(f.node ?? '-') ?? byNode.set(f.node ?? '-', []).get(f.node ?? '-'))!.push(f);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <b style={{ fontSize: 15 }}>{task.name}</b>
        <span style={{ color: T.dim, fontSize: 12 }}>定期巡检 · {task.cron ?? '手动'} · 调整请在会话里告诉智能体</span>
      </div>

      {latest === undefined
        ? <div style={{ color: T.dim, marginTop: 14 }}>还没有巡检报告</div>
        : (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0' }}>
              <Badge level={latest.report.severity} />
              <span style={{ fontSize: 14 }}>{latest.report.summary}</span>
              <span style={{ color: T.dim, fontSize: 12, marginLeft: 'auto' }}>{String(latest.firedAt).replace('T', ' ').slice(0, 16)}</span>
            </div>
            {[...byNode.entries()].map(([node, list]) => (
              <div key={node} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, marginBottom: 10 }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>{node}</div>
                {list.map((f, i) => (
                  <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '4px 0', fontSize: 13 }}>
                    <Badge level={f.level} />
                    <span style={{ fontWeight: 500, flexShrink: 0 }}>{f.item}</span>
                    <span style={{ color: T.dim }}>{f.detail}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

      <div style={{ color: T.dim, fontSize: 12, margin: '16px 0 6px' }}>近 10 次运行</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {runs.slice(0, 10).map((r) => (
          <span key={r.id}
            title={`${String(r.firedAt).slice(0, 16)} · ${r.status}${r.report ? ' · ' + r.report.severity : ''}`}
            style={{ width: 12, height: 12, borderRadius: 6, background: r.report !== undefined ? (LEVEL_COLOR[r.report.severity] ?? T.dim) : r.status === 'running' ? '#4D6BFE' : 'var(--dsw-alias-border-l2)' }} />
        ))}
        {runs.length === 0 && <span style={{ color: T.dim, fontSize: 12 }}>-</span>}
      </div>
    </div>
  );
}

export function apply(_ctx: any): void {
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    const bridge = (window as any).__opendbHarness__;
    if (bridge?.registerTaskPanel) {
      bridge.registerTaskPanel('inspection', InspectionPanel);
      clearInterval(timer);
    } else if (tries > 40) clearInterval(timer);
  }, 250);
}
