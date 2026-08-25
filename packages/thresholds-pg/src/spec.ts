/**
 * 阈值规格与纯函数层（可单测，不碰连接）。
 *
 * 一条 ThresholdSpec = 某插件的某个数值判据：默认值来自该插件代码里的常量（代码即真相），
 * 覆盖值来自 opendb_thresholds 表。判定方向 cmp 与级别阶梯 tier 只用于展示与校验——
 * 真正的比较逻辑仍在各插件的采集器里，这里不复制判定语义。
 */

export type ThresholdUnit = 'ratio' | 'ms' | 's' | 'count' | 'bytes' | 'hour' | 'x';
export type ThresholdTier = 'notice' | 'warn' | 'critical';
export type ThresholdCmp = '>=' | '>' | '<' | '<=';

export interface ThresholdSpec {
  plugin: string;            // health / sqlreview / wdr / ddl
  key: string;               // 点路径，与插件常量对象的结构一致：connRatio.warn / bloatMinLive
  label: string;             // 人读名，如「连接占用 · warn」
  rule: string;              // 命中时产出的规则 code，如 CONN_HIGH
  cmp: ThresholdCmp;         // 判定方向（>= 越大越严重；< 越小越严重）
  unit: ThresholdUnit;
  desc: string;
  default: number;
  /** 同一阶梯组（如 connRatio 下的 warn/critical）共享 group，用于单调性校验 */
  group?: string;
  tier?: ThresholdTier;
}

export interface ThresholdValue extends ThresholdSpec {
  current: number;
  overridden: boolean;
  updatedAt?: string;
  updatedBy?: string;
  reason?: string;
}

export type Validation = { ok: true } | { ok: false; reason: string };

const TIER_RANK: Record<ThresholdTier, number> = { notice: 0, warn: 1, critical: 2 };

/** 单位的取值范围：越界直接拒绝，不让一个手滑把 ratio 写成 80 */
export function validateRange(spec: ThresholdSpec, value: number): Validation {
  if (!Number.isFinite(value)) return { ok: false, reason: '必须是有限数值' };
  switch (spec.unit) {
    case 'ratio':
      return value >= 0 && value <= 1 ? { ok: true } : { ok: false, reason: '比例类阈值取值范围 0~1（如 80% 写 0.8）' };
    case 'hour':
      return value >= 0 && value <= 24 ? { ok: true } : { ok: false, reason: '小时取值范围 0~24' };
    default:
      return value >= 0 ? { ok: true } : { ok: false, reason: '不能为负数' };
  }
}

/**
 * 阶梯单调性：同组内 notice/warn/critical 必须按判定方向排好序，否则阶梯失去意义
 * （例如 cmp='>=' 时 warn 不能比 critical 大；cmp='<' 时 notice 不能比 warn 小）。
 * siblings = 同组其它阶梯的当前值（改完后的视角）。
 */
export function validateMonotonic(spec: ThresholdSpec, value: number, siblings: { tier: ThresholdTier; value: number }[]): Validation {
  if (spec.tier === undefined || spec.group === undefined) return { ok: true };
  const ascending = spec.cmp === '>=' || spec.cmp === '>';   // 越大越严重 → 阶梯递增
  const mine = TIER_RANK[spec.tier];
  for (const s of siblings) {
    const theirs = TIER_RANK[s.tier];
    if (theirs === mine) continue;
    const shouldBeHigher = ascending ? theirs > mine : theirs < mine;   // 对方级别更严重（或方向反转）时应更大
    const ok = shouldBeHigher ? s.value >= value : s.value <= value;
    if (!ok) {
      return { ok: false, reason: `与同组 ${s.tier}=${s.value} 冲突：${spec.cmp} 判定下阶梯须保持 ${ascending ? 'notice ≤ warn ≤ critical' : 'notice ≥ warn ≥ critical'}` };
    }
  }
  return { ok: true };
}

/** 把嵌套常量对象压平成点路径 → 数值（只收数值叶子） */
export function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix === '' ? k : `${prefix}.${k}`;
    if (typeof v === 'number') out[path] = v;
    else if (typeof v === 'object' && v !== null) Object.assign(out, flatten(v as Record<string, unknown>, path));
  }
  return out;
}

/** 把点路径覆盖项套回默认值的形状——返回新对象，绝不改 defaults（各插件的常量是 as const 的） */
export function applyOverrides<T extends Record<string, unknown>>(defaults: T, overrides: Record<string, number>): T {
  const clone = (v: unknown): unknown => (typeof v === 'object' && v !== null ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, clone(x)])) : v);
  const next = clone(defaults) as Record<string, unknown>;
  for (const [path, value] of Object.entries(overrides)) {
    if (!Number.isFinite(value)) continue;
    const parts = path.split('.');
    let cur: Record<string, unknown> = next;
    let valid = true;
    for (const p of parts.slice(0, -1)) {
      const child = cur[p];
      if (typeof child !== 'object' || child === null) { valid = false; break; }
      cur = child as Record<string, unknown>;
    }
    const leaf = parts[parts.length - 1];
    if (valid && typeof cur[leaf] === 'number') cur[leaf] = value;   // 只覆盖已存在的数值叶子，路径不存在则忽略
  }
  return next as T;
}

/** 从嵌套常量 + 元数据表生成规格：一处声明，默认值永远与代码常量一致 */
export function specsFrom(
  plugin: string,
  defaults: Record<string, unknown>,
  meta: Record<string, { label: string; rule: string; cmp: ThresholdCmp; unit: ThresholdUnit; desc: string }>,
): ThresholdSpec[] {
  const flat = flatten(defaults);
  const out: ThresholdSpec[] = [];
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    const group = parts.length === 2 ? parts[0] : undefined;
    const tier = parts.length === 2 && (parts[1] === 'notice' || parts[1] === 'warn' || parts[1] === 'critical') ? (parts[1] as ThresholdTier) : undefined;
    const m = meta[group ?? key] ?? meta[key];
    if (m === undefined) continue;   // 没写元数据的键不进目录（例如纯内部参数）
    out.push({
      plugin, key, default: value, group, tier,
      label: tier !== undefined ? `${m.label} · ${tier}` : m.label,
      rule: m.rule, cmp: m.cmp, unit: m.unit, desc: m.desc,
    });
  }
  return out;
}
