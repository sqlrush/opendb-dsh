/**
 * ui-task-inline — 会话内嵌缩减卡（设计稿⑤ 裁决点⑨ 的 DOM 形态，2026-08-22 user 提前排期）。
 * 机制：dsh 的 `tool.call.toolview` 键控槽位——key = 工具名，为我们自己的采集工具接管
 * 会话流里的渲染（未接管的工具仍走通用工具行）。运行中出骨架，出结果出富卡。
 * 只读展示；卡片内容全部来自工具返回的确定性 JSON（与任务大盘同源，不二次加工）。
 */
import { useState } from 'react';

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
const mono = '"JetBrains Mono","SF Mono",Menlo,monospace';

const shell: any = {
  border: `1px solid ${T.line}`, borderRadius: 10, overflow: 'hidden', margin: '6px 0 2px',
  background: '#fff', boxShadow: '0 4px 12px rgba(0,0,0,.02),0 2px 8px rgba(0,0,0,.04)', maxWidth: 760,
  fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif',
};

/** 工具结果文本（我们的工具输出 = 若干 `--` 注释行 + JSON） */
function resultText(block: any): string {
  const blocks = (block?.content ?? []) as any[];
  return blocks.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
}
function parsePayload(block: any): any | undefined {
  const text = resultText(block);
  const i = text.indexOf('{');
  if (i < 0) return undefined;
  try { return JSON.parse(text.slice(i)); } catch { return undefined; }
}

function Band({ level, title, right, sub }: { level: string; title: string; right?: string; sub?: string }) {
  const s = sev(level);
  return (
    <div style={{ background: s.grad, color: '#fff', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <b style={{ fontSize: 15 }}>{title}</b>
      <span style={{ fontSize: 12, background: 'rgba(255,255,255,.18)', borderRadius: 6, padding: '1px 9px' }}>✓ 已锚定</span>
      {right !== undefined ? <span style={{ marginLeft: 'auto', fontSize: 13.5, fontWeight: 600 }}>{right}</span> : null}
      {sub !== undefined ? <div style={{ width: '100%', fontSize: 12.5, opacity: 0.92 }}>{sub}</div> : null}
    </div>
  );
}

function Row({ level, code, text, right }: { level?: string; code?: string; text: string; right?: string }) {
  return (
    <div style={{ display: 'flex', gap: 9, alignItems: 'baseline', padding: '7px 0', borderBottom: `1px solid ${T.line}` }}>
      {level !== undefined ? <span style={{ color: sev(level).c, fontWeight: 700, fontSize: 13, flex: 'none' }}>●</span> : null}
      {code !== undefined && code !== '' ? <span style={{ fontFamily: mono, fontSize: 12, color: T.dim, flex: 'none' }}>{code}</span> : null}
      <span style={{ fontSize: 13.5, color: T.ink, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
      {right !== undefined ? <b style={{ marginLeft: 'auto', fontSize: 12.5, color: T.sub, flex: 'none' }}>{right}</b> : null}
    </div>
  );
}

function Foot({ note, extra }: { note: string; extra?: string }) {
  return (
    <div style={{ display: 'flex', gap: 14, padding: '8px 16px', borderTop: `1px solid ${T.line}`, background: T.fill, fontSize: 12.5, color: T.dim, flexWrap: 'wrap' }}>
      <span>{note}</span>
      {extra !== undefined ? <span style={{ marginLeft: 'auto' }}>{extra}</span> : null}
    </div>
  );
}

function Body({ children }: { children: any }) {
  return <div style={{ padding: '4px 16px 8px' }}>{children}</div>;
}

/** 运行中骨架（tool/call 已到、tool/result 未到） */
function Running({ label }: { label: string }) {
  return (
    <div style={{ ...shell, display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px' }}>
      <span style={{ width: 9, height: 9, borderRadius: 5, background: T.blue, display: 'inline-block' }} />
      <span style={{ fontSize: 13.5, color: T.sub }}>{label}…（确定性采集进行中，结果直出结构化卡片）</span>
    </div>
  );
}

function Failed({ label, block }: { label: string; block: any }) {
  return (
    <div style={{ ...shell }}>
      <Band level="warn" title={`${label} · 未完成`} />
      <Body><div style={{ fontSize: 13.5, color: T.sub, padding: '6px 0' }}>{resultText(block).slice(0, 400) || '工具未返回内容'}</div></Body>
    </div>
  );
}

/** 通用外壳：拿到 payload 就渲染 render(payload)，否则骨架/失败 */
function makeCard(label: string, render: (p: any, block: any) => any) {
  return function ToolCard({ block, toolName }: { block: any; toolName: string }) {
    if (block?.kind !== 'tool-result') return <Running label={label} />;
    if (block?.isError === true) return <Failed label={label} block={block} />;
    const payload = parsePayload(block);
    if (payload === undefined) return <Failed label={label} block={block} />;
    try { return render(payload, block); } catch { return <Failed label={label} block={block} />; }
  };
}

// ── 健康检查 ────────────────────────────────────────────────────────────────
const HealthCard = makeCard('健康检查采集', (p) => {
  const worst = String(p?.det?.worst ?? 'ok');
  const c = p?.det?.counts ?? {};
  const nodes = (p?.nodes ?? []) as any[];
  const findings = nodes.flatMap((n: any) => (n.findings ?? []).map((f: any) => ({ ...f, node: n.node })))
    .sort((a: any, b: any) => (ORDER[String(b.level)] ?? 0) - (ORDER[String(a.level)] ?? 0));
  const top = findings.filter((f: any) => String(f.level) !== 'ok').slice(0, 3);
  const isCluster = String(p?.scope) === 'cluster';
  return (
    <div style={shell}>
      <Band level={worst} title={`${sev(worst).cn} · 健康检查${isCluster ? `（集群 ${nodes.length} 实例）` : ` · ${String(nodes[0]?.node ?? '')}`}`}
        right={`严重 ${Number(c.critical ?? 0)} · 告警 ${Number(c.warn ?? 0)} · 关注 ${Number(c.notice ?? 0)}`} />
      <Body>
        {top.length === 0 ? <Row text="✓ 12 维全部在阈值内，无异常发现" level="ok" />
          : top.map((f: any, i: number) => (
            <Row key={i} level={String(f.level)} code={String(f.code ?? '')}
              text={String(f.detail ?? f.item ?? '')} right={isCluster ? String(f.node ?? '') : String(f.value ?? '')} />
          ))}
        {findings.filter((f: any) => String(f.level) !== 'ok').length > 3
          ? <div style={{ fontSize: 12.5, color: T.dim, paddingTop: 6 }}>另 {findings.filter((f: any) => String(f.level) !== 'ok').length - 3} 条发现（收起）</div> : null}
      </Body>
      <Foot note="完整 12 维大盘见侧栏任务页 · 卡片内容为确定性采集原文"
        extra={(p?.collectionNotes ?? []).length > 0 ? `⚠ ${p.collectionNotes.length} 维降级` : '0 维降级'} />
    </div>
  );
});

// ── SQL 审核 ────────────────────────────────────────────────────────────────
const SqlReviewCard = makeCard('SQL 审核采集', (p) => {
  const worst = String(p?.det?.worst ?? 'ok');
  const c = p?.det?.counts ?? {};
  const rules = (p?.ruleFindings ?? []) as any[];
  const sqls = (p?.sqlItems ?? []) as any[];
  const top = rules.slice(0, 3);
  return (
    <div style={shell}>
      <Band level={worst} title={`${sev(worst).cn} · SQL 审核 · ${String(p?.node ?? '')}`}
        right={`违规 ${rules.length} 条 · 慢 SQL ${sqls.length} 条`}
        sub={`严重 ${Number(c.critical ?? 0)} · 告警 ${Number(c.warn ?? 0)} · 关注 ${Number(c.notice ?? 0)} · hypopg ${p?.hypopg?.available === true ? '可用' : '不可用（索引建议只能预估）'}`} />
      <Body>
        {top.map((f: any, i: number) => (
          <Row key={i} level={String(f.level)} code={String(f.rule ?? '')} text={`${String(f.object ?? '')} — ${String(f.problem ?? '')}`} />
        ))}
        {rules.length > 3 ? <div style={{ fontSize: 12.5, color: T.dim, paddingTop: 6 }}>另 {rules.length - 3} 条违规（收起）</div> : null}
        {sqls.length > 0 ? (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingTop: 8 }}>
            {sqls.slice(0, 6).map((s: any) => (
              <span key={String(s.key)} style={{ fontFamily: mono, fontSize: 12, background: s.explainOk === true ? T.sev.ok.soft : T.fill, color: s.explainOk === true ? T.sev.ok.c : T.dim, borderRadius: 6, padding: '2px 8px' }}>
                {String(s.key)}{Number(s.avgMs ?? 0) > 0 ? ` · ${Number(s.avgMs).toLocaleString()}ms` : ''}{s.explainOk === true ? ' ✓计划' : ' 无计划'}
              </span>
            ))}
          </div>
        ) : null}
      </Body>
      <Foot note="优化改写与 cost 对比在完整报告 · 索引 DDL 仅建议不代执行（只读定位）" />
    </div>
  );
});

// ── WDR ─────────────────────────────────────────────────────────────────────
const ATTR: Record<string, string> = { cpu: 'CPU 型', io: 'IO 型', tmp: 'temp 溢出', blk: '等待/锁型', other: '混合' };
const WdrCard = makeCard('WDR 窗口采集', (p) => {
  const worst = String(p?.det?.worst ?? 'ok');
  const w = p?.window ?? {};
  const classes = (p?.dbTime?.classes ?? []) as any[];
  const top = ((p?.topSql ?? []) as any[]).slice(0, 3);
  const findings = ((p?.findings ?? []) as any[]).filter((f) => String(f.level) !== 'ok');
  return (
    <div style={shell}>
      <Band level={worst} title={`${sev(worst).cn} · WDR 窗口 · ${String(p?.node ?? '')}`}
        right={`DB Time ${Math.round(Number(p?.dbTime?.totalUs ?? 0) / 1_000_000)}s · 活跃 ${Number(p?.dbTime?.avgActive ?? 0)}`}
        sub={`snap ${Number(w.beginSnap)}→${Number(w.endSnap)} · ${String(w.beginTs ?? '').slice(11, 16)}–${String(w.endTs ?? '').slice(11, 16)}（${Number(w.minutes)} 分钟）· ${classes.map((c: any) => `${String(c.name)} ${(Number(c.share) * 100).toFixed(0)}%`).join(' / ')}`} />
      <Body>
        {findings.slice(0, 2).map((f: any, i: number) => (
          <Row key={i} level={String(f.level)} code={String(f.code ?? '')} text={String(f.detail ?? '')} />
        ))}
        {top.map((s: any, i: number) => (
          <Row key={`s${i}`} code={String(s.sqlId ?? '')} text={String(s.text ?? '').slice(0, 70)}
            right={`${ATTR[String(s.attr)] ?? String(s.attr)} · ${Number(s.elapsedMs ?? 0).toLocaleString()}ms`} />
        ))}
      </Body>
      <Foot note="归因由脚本判定（tmp/cpu/io/blk），模型不可改 · 只消费既有快照，不新建" />
    </div>
  );
});

// ── DDL 追溯 ────────────────────────────────────────────────────────────────
const ACT: Record<string, { cn: string; c: string }> = {
  added: { cn: '新增', c: '#3fa552' }, removed: { cn: '删除', c: '#d64545' },
  changed: { cn: '变更', c: '#e07a1f' }, ddl: { cn: 'DDL', c: '#4176e6' }, baseline: { cn: '批量', c: '#81858c' },
};
const DdlCard = makeCard('DDL 追溯采集', (p) => {
  const worst = String(p?.det?.worst ?? 'ok');
  const st = p?.stats ?? {};
  const tl = ((p?.timeline ?? []) as any[]).filter((e) => String(e.action) !== 'baseline').slice(0, 4);
  const users = (st.users ?? []) as string[];
  return (
    <div style={shell}>
      <Band level={worst} title={`${sev(worst).cn} · DDL 变更追溯 · ${String(p?.node ?? '')}`}
        right={`${Number(st.total ?? 0)} 起变更 / ${Number(p?.windowHours ?? 0)}h`}
        sub={`新增 ${Number(st.added ?? 0)} · 删除 ${Number(st.removed ?? 0)} · 结构变更 ${Number(st.changed ?? 0)} · ${p?.auditAvailable === true ? `操作者：${users.join('、') || '窗口内无审计记录'}` : '用户归因不可用（需 AUDITADMIN）'}`} />
      <Body>
        {tl.length === 0 ? <Row text="窗口内没有实际的数据字典变更" level="ok" />
          : tl.map((e: any, i: number) => {
            const a = ACT[String(e.action)] ?? ACT.ddl;
            return (
              <div key={i} style={{ display: 'flex', gap: 9, alignItems: 'baseline', padding: '7px 0', borderBottom: `1px solid ${T.line}` }}>
                <span style={{ fontFamily: mono, fontSize: 12, color: T.dim, flex: 'none' }}>{String(e.time ?? '').slice(5, 16).replace('T', ' ')}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: a.c, flex: 'none' }}>{a.cn}</span>
                <span style={{ fontFamily: mono, fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(e.object ?? '')}</span>
                {String(e.user ?? '') !== '' ? <span style={{ marginLeft: 'auto', fontSize: 12, color: '#0e3074', background: T.blueSoft, borderRadius: 999, padding: '1px 8px', flex: 'none' }}>👤 {String(e.user)}</span> : null}
              </div>
            );
          })}
      </Body>
      <Foot note="完整时间轴（按日分组 + DDL 原文）见任务页" extra={`时间轴 ${(p?.timeline ?? []).length} 条`} />
    </div>
  );
});

// ── 规则目录（markdown 输出，做轻量摘要卡）────────────────────────────────
function RulesCard({ block }: { block: any }) {
  if (block?.kind !== 'tool-result') return <Running label="读取规则目录" />;
  const text = resultText(block);
  const groups = (text.match(/^## /gm) ?? []).length;
  const rows = (text.match(/^\| `/gm) ?? []).length;
  return (
    <div style={shell}>
      <Band level="ok" title={`平台规则目录 · ${groups} 个插件 · ${rows} 条规则`} right="确定性判定层" />
      <Body>
        {(text.match(/^## .*$/gm) ?? []).slice(0, 5).map((h: string, i: number) => (
          <Row key={i} text={h.replace(/^##\s*/, '')} />
        ))}
      </Body>
      <Foot note="级别不可被模型下调 · 完整目录（含阈值与实现位置）见任务页「平台规则目录」" />
    </div>
  );
}

// ── task_report 提交卡（从调用参数渲染报告摘要）──────────────────────────
function ReportCard({ block }: { block: any }) {
  const argsRaw = block?.kind === 'tool-result' ? block?.call?.argsRaw : block?.argsRaw;
  let args: any;
  try { args = JSON.parse(String(argsRaw ?? '{}')); } catch { args = {}; }
  const sevKey = String(args.severity ?? 'ok');
  const settled = block?.kind === 'tool-result';
  const [open, setOpen] = useState(false);
  const data = args.data ?? {};
  const counts = data?.det?.counts;
  return (
    <div style={shell}>
      <Band level={sevKey} title={`${settled ? '报告已入库' : '提交报告中'} · ${sev(sevKey).cn}`}
        right={counts !== undefined ? `严重 ${Number(counts.critical ?? 0)} · 告警 ${Number(counts.warn ?? 0)}` : undefined} />
      <Body>
        <div style={{ fontSize: 13.5, color: T.ink, padding: '6px 0', cursor: 'pointer' }} onClick={() => setOpen(!open)}>
          {open || String(args.summary ?? '').length <= 150 ? String(args.summary ?? '') : `${String(args.summary).slice(0, 150)}…（点开全文）`}
        </div>
      </Body>
      <Foot note="报告自动入库归档 · 只读展示，无签收控件" extra="完整大盘见侧栏任务页" />
    </div>
  );
}

// ── 阈值清单卡（threshold_list：默认 vs 当前，被改过的置顶）────────────────────
const PLUGIN_CN: Record<string, string> = { health: '健康检查', sqlreview: 'SQL 审核', wdr: 'WDR', ddl: 'DDL 追溯' };
function ThresholdListCard({ block }: { block: any }) {
  if (block?.kind !== 'tool-result') return <Running label="读取平台阈值" />;
  const p = parsePayload(block);
  if (p === undefined) return <Failed label="平台阈值" block={block} />;
  const groups = (p.groups ?? []) as any[];
  const changed = groups.flatMap((g) => (g.items ?? []).filter((i: any) => i.overridden).map((i: any) => ({ ...i, plugin: g.plugin })));
  return (
    <div style={shell}>
      <Band level={changed.length > 0 ? 'notice' : 'ok'} title={`平台阈值 · ${Number(p.total ?? 0)} 个判据`} right={changed.length > 0 ? `${changed.length} 个已改动` : '全部为默认值'} />
      <Body>
        {changed.slice(0, 6).map((i: any) => (
          <Row key={`${i.plugin}/${i.key}`} level="notice" code={`${PLUGIN_CN[i.plugin] ?? i.plugin} · ${i.key}`} text={i.label} right={`${i.defaultText} → ${i.currentText}`} />
        ))}
        {changed.length === 0 && groups.map((g) => (
          <Row key={g.plugin} text={`${g.title} · ${(g.items ?? []).length} 个判据`} right="默认值" />
        ))}
        {groups.length === 0 && <Row text="没有被改过的阈值——全部为代码默认值" />}
      </Body>
      <Foot note="判定方向与阶梯由代码固定 · 只有数值可改" extra="完整大盘见任务页「阈值配置」" />
    </div>
  );
}

// ── 阈值修改/重置卡（threshold_set / threshold_reset：旧值 → 新值）─────────────
function ThresholdChangeCard({ block }: { block: any }) {
  const argsRaw = block?.kind === 'tool-result' ? block?.call?.argsRaw : block?.argsRaw;
  let args: any;
  try { args = JSON.parse(String(argsRaw ?? '{}')); } catch { args = {}; }
  if (block?.kind !== 'tool-result') return <Running label={`修改阈值 ${String(args.plugin ?? '')}/${String(args.key ?? '')}`} />;
  const p = parsePayload(block);
  if (p === undefined) {
    // 校验失败：工具返回的是纯文本原因，如实显示
    return (
      <div style={shell}>
        <Band level="warn" title="阈值未修改" />
        <Body><div style={{ fontSize: 13.5, color: T.ink, padding: '6px 0', whiteSpace: 'pre-wrap' }}>{resultText(block).replace(/^--.*\n?/, '')}</div></Body>
        <Foot note="校验拒绝（超范围或破坏阶梯单调）· 未做任何修改" />
      </div>
    );
  }
  const isReset = p.action === 'reset';
  return (
    <div style={shell}>
      <Band level={isReset ? 'ok' : 'notice'} title={`${isReset ? '阈值已重置' : '阈值已修改'} · ${PLUGIN_CN[p.plugin] ?? p.plugin}`} right={String(p.effective ?? '')} />
      <Body>
        <Row code={String(p.key ?? '')} text={String(p.label ?? '')} right={`${p.oldText} → ${p.newText}`} />
        {p.reason ? <Row text={`原因：${String(p.reason)}`} /> : null}
      </Body>
      <Foot note={`影响规则 ${String(p.rule ?? '')} · 已记入变更历史`} extra="完整大盘见任务页「阈值配置」" />
    </div>
  );
}

const CARDS: [string, any][] = [
  ['health_collect', HealthCard],
  ['sqlreview_collect', SqlReviewCard],
  ['wdr_collect', WdrCard],
  ['ddl_collect', DdlCard],
  ['rules_catalog', RulesCard],
  ['task_report', ReportCard],
  ['threshold_list', ThresholdListCard],
  ['threshold_set', ThresholdChangeCard],
  ['threshold_reset', ThresholdChangeCard],
];

export function apply(ctx: any): void {
  ctx.slots.inject('tool.call.toolview', () => {
    for (const [tool, Comp] of CARDS) {
      ctx.slots.register({ name: 'tool.call.toolview', key: tool }, Comp);
    }
  });
}
