/**
 * 采集编排：单节点 12 维 → NodeHealth；多节点 → ClusterHealth（跨实例共性 / 参数漂移 / 最差上浮）。
 * 汇总 ≠ N 份单机报告钉在一起——集群层的增量价值在横向分析（设计稿裁决点⑧）。
 */
import { COLLECTORS, worstOf, LEVEL_ORDER, type DetFinding, type DetLevel, type DimResult, type QueryFn } from './collectors.ts';

export interface NodeHealth {
  node: string;
  worst: DetLevel;
  dims: { dim: string; title: string; ok: boolean; worst: DetLevel; note?: string }[];
  findings: DetFinding[];
  collectionNotes: string[];
  settings: Record<string, string>;
  cacheHitRatio?: number;
}

export interface ClusterFinding { code: string; level: DetLevel; item: string; detail: string; nodes: string[] }

export interface HealthCollectResult {
  scope: 'instance' | 'cluster';
  collectedAt: string;
  nodes: NodeHealth[];
  worst: DetLevel;
  counts: Record<DetLevel, number>;
  clusterFindings: ClusterFinding[];
}

export async function collectNode(name: string, q: QueryFn, dims?: string[]): Promise<NodeHealth> {
  const wanted = dims === undefined || dims.length === 0 ? COLLECTORS : COLLECTORS.filter((c) => dims.includes(c.key));
  const results: DimResult[] = [];
  const notes: string[] = [];
  for (const c of wanted) {
    try {
      results.push(await c.run(q));
    } catch (cause) {
      const msg = String((cause as Error).message ?? cause).slice(0, 160);
      results.push({ dim: c.key, title: c.title, ok: false, findings: [], note: msg });
      notes.push(`维度「${c.title}」采集降级：${msg}（该维不产结论）`);
    }
  }
  const findings = results.flatMap((r) => r.findings);
  const overviewEv = results.find((r) => r.dim === 'overview')?.evidence as Record<string, unknown> | undefined;
  return {
    node: name,
    worst: worstOf(findings.map((f) => f.level)),
    dims: results.map((r) => ({ dim: r.dim, title: r.title, ok: r.ok, worst: worstOf(r.findings.map((f) => f.level)), note: r.note })),
    findings,
    collectionNotes: notes,
    settings: (overviewEv?.settings as Record<string, string>) ?? {},
    cacheHitRatio: typeof overviewEv?.cacheHitRatio === 'number' ? (overviewEv.cacheHitRatio as number) : undefined,
  };
}

/** 跨实例分析：同 code 共性（≥半数实例）、关键参数漂移、最差实例驱动上浮 */
export function analyzeCluster(nodes: NodeHealth[]): ClusterFinding[] {
  if (nodes.length <= 1) return [];
  const out: ClusterFinding[] = [];
  const half = Math.ceil(nodes.length / 2);

  // 共性：同一 code 出现在 >= 半数实例
  const byCode = new Map<string, { nodes: Set<string>; level: DetLevel; sample: DetFinding }>();
  for (const n of nodes) {
    for (const f of n.findings) {
      const cur = byCode.get(f.code) ?? { nodes: new Set<string>(), level: 'ok' as DetLevel, sample: f };
      cur.nodes.add(n.node);
      if (LEVEL_ORDER[f.level] > LEVEL_ORDER[cur.level]) { cur.level = f.level; cur.sample = f; }
      byCode.set(f.code, cur);
    }
  }
  for (const [code, v] of byCode) {
    if (v.nodes.size >= half) {
      out.push({
        code: `COMMON_${code}`, level: v.level,
        item: `共性异常：${v.nodes.size}/${nodes.length} 实例命中 ${code}`,
        detail: `示例（最重实例）：${v.sample.detail}。同类问题跨半数以上实例出现——优先怀疑共享层（宿主机 IO / 集中批处理 / 统一配置），而非单库自身。`,
        nodes: [...v.nodes].sort(),
      });
    }
  }

  // 参数漂移：关键 setting 存在多个取值
  const keys = new Set(nodes.flatMap((n) => Object.keys(n.settings)));
  for (const k of keys) {
    const values = new Map<string, string[]>();
    for (const n of nodes) {
      const v = n.settings[k];
      if (v === undefined) continue;
      values.set(v, [...(values.get(v) ?? []), n.node]);
    }
    if (values.size > 1) {
      const parts = [...values.entries()].sort((a, b) => b[1].length - a[1].length);
      const minority = parts.slice(1).flatMap(([, ns]) => ns);
      out.push({
        code: 'SET_DRIFT', level: 'notice',
        item: `配置离群：${k} 有 ${values.size} 种取值`,
        detail: parts.map(([v, ns]) => `${v}（${ns.length} 台${ns.length <= 3 ? `: ${ns.join(',')}` : ''}）`).join(' vs '),
        nodes: minority.sort(),
      });
    }
  }

  // 最差实例上浮
  const worstNode = [...nodes].sort((a, b) => LEVEL_ORDER[b.worst] - LEVEL_ORDER[a.worst])[0];
  if (worstNode !== undefined && LEVEL_ORDER[worstNode.worst] >= LEVEL_ORDER['warn']) {
    const driver = [...worstNode.findings].sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level])[0];
    out.push({
      code: 'WORST_INSTANCE', level: worstNode.worst,
      item: `最差实例：${worstNode.node}（${worstNode.worst}）`,
      detail: driver !== undefined ? `驱动发现：[${driver.code}] ${driver.detail}` : '无驱动发现明细',
      nodes: [worstNode.node],
    });
  }
  return out.sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level]);
}

export function summarize(nodes: NodeHealth[]): HealthCollectResult {
  const all = nodes.flatMap((n) => n.findings);
  const counts: Record<DetLevel, number> = { ok: 0, notice: 0, warn: 0, critical: 0 };
  for (const f of all) counts[f.level] += 1;
  return {
    scope: nodes.length > 1 ? 'cluster' : 'instance',
    collectedAt: new Date().toISOString(),
    nodes,
    worst: worstOf(nodes.map((n) => n.worst)),
    counts,
    clusterFindings: analyzeCluster(nodes),
  };
}
