/**
 * SQL 审核任务的 client 半边（双半边插件）：findings 以「SQL + 问题 + 建议 + 依据」卡片展示。
 * 纲领 §15：纯展示大盘，无操作按钮。
 */
import { useEffect, useState } from 'react';

export const inject = ['slots'];

const T = {
  dim: 'var(--dsw-alias-label-tertiary)',
  sub: 'var(--dsw-alias-label-secondary)',
  border: 'var(--dsw-alias-border-l1)',
};
const LEVEL_COLOR: Record<string, string> = { ok: '#3fa552', warn: '#c9862d', critical: '#d64545' };

function SqlAuditPanel({ task, call }: { task: any; call: (e: string, p?: unknown) => Promise<any> }) {
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

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <b style={{ fontSize: 15 }}>{task.name}</b>
        <span style={{ color: T.dim, fontSize: 12 }}>SQL 审核 · {task.cron ?? '手动'} · 调整请在会话里告诉智能体</span>
      </div>

      {latest === undefined
        ? <div style={{ color: T.dim, marginTop: 14 }}>还没有审核报告</div>
        : (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0' }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#fff', background: LEVEL_COLOR[latest.report.severity] ?? T.dim, borderRadius: 6, padding: '1px 7px' }}>{latest.report.severity}</span>
              <span style={{ fontSize: 14 }}>{latest.report.summary}</span>
              <span style={{ color: T.dim, fontSize: 12, marginLeft: 'auto' }}>{String(latest.firedAt).replace('T', ' ').slice(0, 16)}</span>
            </div>
            {findings.map((f, i) => (
              <div key={i} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, marginBottom: 10 }}>
                <pre style={{
                  margin: 0, padding: '8px 10px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.55,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  background: 'var(--dsw-alias-bg-layer-1)', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                }}>{f.sql}</pre>
                <div style={{ marginTop: 8, fontSize: 13 }}>
                  <span style={{ color: '#d64545', fontWeight: 600 }}>问题</span>
                  <span style={{ marginLeft: 8 }}>{f.issue}</span>
                </div>
                <div style={{ marginTop: 4, fontSize: 13 }}>
                  <span style={{ color: '#3fa552', fontWeight: 600 }}>建议</span>
                  <span style={{ marginLeft: 8 }}>{f.suggestion}</span>
                </div>
                {f.evidence !== undefined && f.evidence !== '' && (
                  <div style={{ marginTop: 4, fontSize: 12, color: T.dim }}>依据：{f.evidence}</div>
                )}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

export function apply(_ctx: any): void {
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    const bridge = (window as any).__opendbHarness__;
    if (bridge?.registerTaskPanel) {
      bridge.registerTaskPanel('sql-audit', SqlAuditPanel);
      clearInterval(timer);
    } else if (tries > 40) clearInterval(timer);
  }, 250);
}
