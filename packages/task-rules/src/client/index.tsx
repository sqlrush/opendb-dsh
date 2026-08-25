/**
 * task-rules client 面板：平台规则目录全 UI——分插件分组卡、级别徽章、阈值阶梯、实现位置。
 * 纯静态渲染（目录=代码内置事实，无 RPC 无报告依赖）；内容区字号体系（16px/1.75）。
 */
import { rulesCatalog } from '../catalog.ts';

export const inject = ['slots'];

const T = {
  ink: '#0f1115', sub: '#61666b', dim: '#81858c', blue: '#4176e6',
  line: 'rgba(0,0,0,.08)', fill: '#f7f8fa',
  sev: {
    ok: { c: '#3fa552', soft: '#e8f5ec' }, notice: { c: '#c9862d', soft: '#faf3e5' },
    warn: { c: '#e07a1f', soft: '#fdf0e3' }, critical: { c: '#d64545', soft: '#fdecec' },
  } as Record<string, { c: string; soft: string }>,
};
const card: any = { background: '#fff', border: `1px solid ${T.line}`, borderRadius: 8, padding: '16px 20px', boxShadow: '0 4px 12px rgba(0,0,0,.02),0 2px 8px rgba(0,0,0,.04)' };
const mono = '"JetBrains Mono","SF Mono",Menlo,monospace';

/** 级别阶梯文本上色（notice/warn/critical 关键字） */
function Levels({ text }: { text: string }) {
  const parts = text.split(/( · )/);
  return (
    <span>
      {parts.map((p, i) => {
        const lv = p.includes('critical') ? 'critical' : p.includes('warn') ? 'warn' : p.includes('notice') ? 'notice' : '';
        return lv !== '' ? <span key={i} style={{ color: T.sev[lv].c, fontWeight: 600 }}>{p}</span> : <span key={i}>{p}</span>;
      })}
    </span>
  );
}

const PLUGIN_ICON: Record<string, string> = { health: '🩺', sqlreview: '📝', wdr: '📊', ddl: '🕘' };

export function RulesPanel(_props: { task: any; call: (endpoint: string, payload?: unknown) => Promise<any> }) {
  const groups = rulesCatalog();
  const total = groups.reduce((s, g) => s + g.rows.length, 0);
  const th: any = { color: T.dim, fontWeight: 500, fontSize: 13.5, textAlign: 'left', padding: '8px 12px', borderBottom: `1px solid ${T.line}`, whiteSpace: 'nowrap' };
  const td: any = { padding: '9px 12px', borderBottom: `1px solid ${T.line}`, verticalAlign: 'top', fontSize: 13.5 };
  return (
    <div style={{ fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif', color: T.ink, lineHeight: 1.75 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <span style={{ fontSize: 18, fontWeight: 600 }}>平台确定性判定层 · {groups.length} 个插件 · {total} 条规则</span>
        <span style={{ display: 'inline-flex', gap: 6, fontSize: 13.5, background: T.sev.ok.soft, color: T.sev.ok.c, borderRadius: 6, padding: '3px 10px', fontWeight: 500 }}>✓ 规则判定由脚本产出 · 级别不可被模型下调</span>
      </div>
      <div style={{ fontSize: 16, color: T.sub, marginBottom: 8 }}>
        这些规则是四个任务插件"确定性归脚本"的判定全集——阈值命中即立发现，模型只做解读与串联。
        在会话里问「平台现在有哪些规则」可得简易版（rules_catalog 工具）。
      </div>
      {groups.map((g) => (
        <div key={g.plugin} style={{ ...card, marginTop: 18, padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px 10px' }}>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{PLUGIN_ICON[g.plugin] ?? '·'} {g.title}</div>
            <div style={{ fontSize: 13.5, color: T.sub, marginTop: 4 }}>{g.intro}</div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr><th style={th}>规则</th><th style={th}>名称</th><th style={th}>级别阶梯</th><th style={th}>说明</th></tr></thead>
              <tbody>
                {g.rows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}><span style={{ font: `600 11.5px ${mono}`, background: T.fill, border: `1px solid ${T.line}`, borderRadius: 5, padding: '1px 6px', color: T.sub }}>{r.id}</span></td>
                    <td style={{ ...td, fontWeight: 500, whiteSpace: 'nowrap' }}>{r.name}</td>
                    <td style={td}><Levels text={r.levels} /></td>
                    <td style={{ ...td, color: T.sub }}>{r.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '8px 20px 12px', display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline' }}>
            {(g.notes ?? []).map((n, i) => <span key={i} style={{ fontSize: 13.5, color: T.dim }}>· {n}</span>)}
            <span style={{ fontSize: 13, color: T.dim, fontFamily: mono, marginLeft: 'auto' }}>实现 {g.source}</span>
          </div>
        </div>
      ))}
      <div style={{ fontSize: 13.5, color: T.dim, border: `1px dashed ${T.line}`, borderRadius: 8, padding: '10px 16px', marginTop: 18 }}>
        📋 本目录里的阈值数字是代码默认值（单测守护目录与实现同步）；当前生效值、改动记录与会话内修改见任务页「阈值配置」——
        在会话里说一句「把 X 的 warn 改成 Y」，智能体复述确认后落库，下一次采集起生效。客户规范经知识库对照——参考不改判（KB 契约）。
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
  registerPanel('rules', RulesPanel);
}
