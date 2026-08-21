/**
 * DDL 变更追溯与规范扫描——纯函数层（可单测）。
 * 三源阶梯：字典变更（对象/时间主干，10 分钟粒度）+ 审计日志（用户归因，有权限才有）
 * + dbe_perf DDL 文本（辅助）。时间轴合并 = 审计条目按对象名±15 分钟窗口吸附字典条目。
 * 洪峰折叠：同一时刻 >30 条字典变更（collector 首轮基线导入）折叠为单条 baseline 条目。
 */

export type DdlLevel = 'ok' | 'notice' | 'warn' | 'critical';
export const LEVEL_ORDER: Record<DdlLevel, number> = { ok: 0, notice: 1, warn: 2, critical: 3 };

export interface TimelineEntry {
  time: string;                 // ISO
  action: string;               // added | removed | changed | baseline | ddl
  kind: string;                 // table | index | view | function | sequence | schema | bulk | statement
  object: string;               // sch.name（baseline 时为汇总描述）
  user: string;                 // 审计归因；无审计时空串
  sqlText: string;              // 审计 detail 里的 DDL 文本；无则空串
  sources: string[];            // ['dict'] | ['audit'] | ['dict','audit']
  count?: number;               // baseline 折叠条目的对象数
}

export interface DdlRuleFinding {
  rule: string; level: DdlLevel; object: string; time: string;
  problem: string; advice: string; evidence: string;
}

export interface DictChangeRow { time: unknown; kind: unknown; sch: unknown; name: unknown; change: unknown }
export interface AuditRow { time: unknown; type: unknown; result: unknown; username: unknown; object_name: unknown; detail_info: unknown }

const iso = (v: unknown): string => {
  const d = new Date(v as any);
  return Number.isNaN(d.getTime()) ? String(v ?? '') : d.toISOString();
};
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** 字典变更 → 时间轴条目（含洪峰折叠） */
export function dictToTimeline(rows: DictChangeRow[], collapseThreshold = 30): TimelineEntry[] {
  const byTime = new Map<string, DictChangeRow[]>();
  for (const r of rows) {
    const t = iso(r.time);
    byTime.set(t, [...(byTime.get(t) ?? []), r]);
  }
  const out: TimelineEntry[] = [];
  for (const [t, group] of byTime) {
    if (group.length > collapseThreshold) {
      const byKind = new Map<string, number>();
      for (const g of group) byKind.set(s(g.kind), (byKind.get(s(g.kind)) ?? 0) + 1);
      out.push({
        time: t, action: 'baseline', kind: 'bulk',
        object: `批量登记 ${group.length} 个对象（${[...byKind.entries()].map(([k, n]) => `${k}×${n}`).join(' ')}）——多为字典基线导入或批量部署`,
        user: '', sqlText: '', sources: ['dict'], count: group.length,
      });
      continue;
    }
    for (const g of group) {
      out.push({ time: t, action: s(g.change), kind: s(g.kind), object: `${s(g.sch)}.${s(g.name)}`, user: '', sqlText: '', sources: ['dict'] });
    }
  }
  return out;
}

/** 审计 DDL → 时间轴条目 */
export function auditToTimeline(rows: AuditRow[]): TimelineEntry[] {
  return rows.map((r) => ({
    time: iso(r.time), action: 'ddl', kind: s(r.type).replace(/^ddl_/i, '') || 'statement',
    object: s(r.object_name), user: s(r.username), sqlText: s(r.detail_info).slice(0, 300), sources: ['audit'],
  }));
}

/** 合并：审计条目按对象名 ±15 分钟吸附字典条目（吸附后字典条目获得 user/sqlText，action 保留字典语义） */
export function mergeTimeline(dict: TimelineEntry[], audit: TimelineEntry[], windowMs = 15 * 60 * 1000): TimelineEntry[] {
  const merged: TimelineEntry[] = dict.map((d) => ({ ...d }));
  const leftover: TimelineEntry[] = [];
  for (const a of audit) {
    const at = new Date(a.time).getTime();
    const objTail = a.object.split('.').pop() ?? a.object;
    const hit = merged.find((d) =>
      !d.sources.includes('audit') && d.action !== 'baseline' && objTail !== '' &&
      (d.object === a.object || d.object.endsWith(`.${objTail}`)) &&
      Math.abs(new Date(d.time).getTime() - at) <= windowMs);
    if (hit !== undefined) {
      hit.user = a.user; hit.sqlText = a.sqlText; hit.time = a.time;   // 审计时间更精确
      hit.sources = [...hit.sources, 'audit'];
    } else {
      leftover.push(a);
    }
  }
  return [...merged, ...leftover].sort((x, y) => y.time.localeCompare(x.time));
}

/** 规范扫描：确定性规则（对时间轴条目；时段按北京时间） */
export function scanDdlRules(entries: TimelineEntry[], tzOffsetMinutes = 480): DdlRuleFinding[] {
  const out: DdlRuleFinding[] = [];
  const real = entries.filter((e) => e.action !== 'baseline');
  for (const e of real) {
    const sql = e.sqlText.toLowerCase();
    if (e.kind === 'schema' && (e.action === 'removed' || /\bdrop\s+schema\b/.test(sql))) {
      out.push({ rule: 'DDLR00', level: 'critical', object: e.object, time: e.time, problem: 'DROP SCHEMA——整个模式被删除', advice: '确认是否计划内；schema 级删除应有备份与回退预案', evidence: e.sqlText || 'dict: schema removed' });
    } else if (e.kind === 'table' && (e.action === 'removed' || /\bdrop\s+table\b/.test(sql))) {
      out.push({ rule: 'DDLR01', level: 'warn', object: e.object, time: e.time, problem: '表被删除', advice: '确认计划内且有备份；生产删除表应走归档流程', evidence: e.sqlText || 'dict: table removed' });
    }
    if (/\btruncate\b/.test(sql)) {
      out.push({ rule: 'DDLR02', level: 'warn', object: e.object, time: e.time, problem: 'TRUNCATE 清空表（不可回滚点较多的场景高危）', advice: '确认数据可弃或已备份', evidence: e.sqlText });
    }
    if (/\balter\s+table\b[\s\S]*\bdrop\s+(column|constraint)\b/.test(sql)) {
      out.push({ rule: 'DDLR03', level: 'warn', object: e.object, time: e.time, problem: 'DROP COLUMN/CONSTRAINT——破坏性结构变更', advice: '下游依赖（视图/应用字段映射）需先行核对', evidence: e.sqlText });
    }
    if (/\bdrop\s+(table|index|view|schema)\s+(?!if\s+exists)/.test(sql)) {
      out.push({ rule: 'DDLR07', level: 'notice', object: e.object, time: e.time, problem: 'DROP 未带 IF EXISTS——重复执行会报错，脚本不幂等', advice: '变更脚本使用 IF EXISTS 保证幂等', evidence: e.sqlText });
    }
    // 业务时段变更（北京时间 09:00-20:00 的删除/变更类）
    const local = new Date(new Date(e.time).getTime() + tzOffsetMinutes * 60 * 1000);
    const hour = local.getUTCHours();
    if (hour >= 9 && hour < 20 && (e.action === 'removed' || e.action === 'changed' || /\b(drop|alter|truncate)\b/.test(sql))) {
      out.push({ rule: 'DDLR04', level: 'notice', object: e.object, time: e.time, problem: `业务时段（北京 ${String(hour).padStart(2, '0')} 点）执行破坏/变更类 DDL`, advice: '高危 DDL 建议移到低峰窗口', evidence: e.sqlText || `dict: ${e.action}` });
    }
  }
  // 变更抖动：同一对象 24h 内 ≥3 条
  const byObj = new Map<string, TimelineEntry[]>();
  for (const e of real) byObj.set(e.object, [...(byObj.get(e.object) ?? []), e]);
  for (const [obj, list] of byObj) {
    if (list.length < 3) continue;
    const times = list.map((e) => new Date(e.time).getTime()).sort((a, b) => a - b);
    for (let i = 0; i + 2 < times.length; i += 1) {
      if (times[i + 2] - times[i] <= 24 * 3600 * 1000) {
        out.push({ rule: 'DDLR05', level: 'warn', object: obj, time: new Date(times[i + 2]).toISOString(), problem: `24 小时内同一对象变更 ≥3 次（共 ${list.length} 条）——变更抖动`, advice: '合并变更批次；确认是否脚本重试/回滚循环', evidence: list.slice(0, 3).map((e) => `${e.time} ${e.action}`).join(' | ') });
        break;
      }
    }
  }
  return out.sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level]);
}

export function worstOf(findings: DdlRuleFinding[]): DdlLevel {
  return findings.reduce<DdlLevel>((acc, f) => (LEVEL_ORDER[f.level] > LEVEL_ORDER[acc] ? f.level : acc), 'ok');
}

export function timelineStats(entries: TimelineEntry[]): { total: number; added: number; removed: number; changed: number; users: string[]; byKind: Record<string, number> } {
  const real = entries.filter((e) => e.action !== 'baseline');
  const byKind: Record<string, number> = {};
  const users = new Set<string>();
  let added = 0; let removed = 0; let changed = 0;
  for (const e of real) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    if (e.user !== '') users.add(e.user);
    if (e.action === 'added') added += 1;
    else if (e.action === 'removed') removed += 1;
    else if (e.action === 'changed') changed += 1;
  }
  return { total: real.length, added, removed, changed, users: [...users].sort(), byKind };
}
