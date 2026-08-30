/**
 * 表结构变更追溯 R2（2026-08-30 user 定稿 docs/prototypes/ddl-r2.html）：把三源事实（平台字典变更含定义原文 /
 * openGauss pg_object 的建改时间与创建者 / 审计 DDL 原文）合成一条"结构历史"——
 *   事件 → 主干版本（同一操作者一分钟内的 DDL 批次记一版）→ 分支生命线（schema + 有变化的表）→ 各对象的定义时间线，
 * 以及任意两个时点之间的结构 diff（GitHub compare 式）。纯函数、无 IO；客户端面板同样引用本文件算 diff。
 * 规则与阈值仍走 ddl.ts（借鉴规则不动），本文件只多产出数据。
 */

export type Change = 'added' | 'removed' | 'modified' | 'user';
export interface DictChangeFull { time: string; kind: string; sch: string; name: string; change: 'added' | 'removed' | 'modified'; oldDefinition?: string; newDefinition?: string }
export interface CurrentObject { kind: string; sch: string; name: string; definition?: string; firstSeen?: string }
export interface PgObjectRow { sch: string; name: string; kind: string; ctime: string; mtime: string; creator: string }
export interface AuditDdl { time: string; type: string; username: string; object: string; sql: string }
export interface IndexOwner { sch: string; index: string; table: string }

export interface DdlEvent {
  id: string; time: string; sch: string; name: string; kind: string; change: Change;
  who: string; sql: string; sources: string[];
  /** 版本分批键：字典事件 = 该次快照的时间（同一快照里的变更是同一版），其它 = 事件时间取整到分钟 */
  bucket?: string;
  oldDef?: string | null; newDef?: string | null;
  /** 只有 pg_object 时间戳、没有字典观测到的定义差异（签名未变或窗口内未快照） */
  defUnknown?: boolean;
}
/** time = 批次首个事件时刻（图上的位置）；until = 批次最后一个事件时刻（"这一版之后"的结构用它取） */
export interface Version { v: string; time: string; until: string; who: string; kind: 'add' | 'mod' | 'del' | 'user'; label: string; objs: number; eventIds: string[]; schemas: string[] }
export interface SubLane { key: string; sch: string; name: string; kind: string; born: string | null; died: string | null; events: { time: string; change: Change; versionId: string; who: string }[] }
export interface Lane { id: string; kind: 'schema' | 'account'; born: string | null; died: string | null; tables: number; objects: number; note: string; versionIds: string[]; subs: SubLane[] }
export interface DefPoint { time: string; versionId: string | null; def: string | null | undefined }
export interface ObjectHistory { key: string; kind: string; sch: string; name: string; defs: DefPoint[] }
export interface History { since: string; until: string; events: DdlEvent[]; versions: Version[]; lanes: Lane[]; objects: Record<string, ObjectHistory> }

const ms = (t: string) => new Date(t).getTime();
const iso = (v: unknown): string => { const d = new Date(v as any); return Number.isNaN(d.getTime()) ? String(v ?? '') : d.toISOString(); };
export const objKey = (kind: string, sch: string, name: string): string => `${kind} ${sch}.${name}`;
const KIND_OF_RELKIND: Record<string, string> = { r: 'table', i: 'index', v: 'view', S: 'sequence', m: 'matview', f: 'foreign', p: 'table' };

export function buildHistory(input: {
  since: string; until: string;
  changes: readonly DictChangeFull[]; current: readonly CurrentObject[]; pgObjects?: readonly PgObjectRow[]; audit?: readonly AuditDdl[]; indexOwners?: readonly IndexOwner[];
  mergeWindowMs?: number; batchWindowMs?: number;
}): History {
  const since = iso(input.since); const until = iso(input.until);
  const mergeWindow = input.mergeWindowMs ?? 15 * 60_000; const batchWindow = input.batchWindowMs ?? 60_000;
  const inWindow = (t: string) => ms(t) >= ms(since) && ms(t) <= ms(until);
  const creatorOf = new Map<string, string>();
  for (const o of input.pgObjects ?? []) creatorOf.set(`${o.sch}.${o.name}`, o.creator);
  const events: DdlEvent[] = [];
  let n = 0;
  // ① 字典变更（含定义）
  for (const c of input.changes) {
    if (!inWindow(iso(c.time))) continue;
    events.push({ id: `d${++n}`, time: iso(c.time), sch: c.sch, name: c.name, kind: c.kind, change: c.change, who: creatorOf.get(`${c.sch}.${c.name}`) ?? '', sql: '', sources: ['dict'], oldDef: c.oldDefinition ?? null, newDef: c.newDefinition ?? null, bucket: `snap:${iso(c.time)}` });
  }
  const near = (sch: string, name: string, change: Change, t: string) => events.find((e) => e.sch === sch && e.name === name && e.change === change && Math.abs(ms(e.time) - ms(t)) <= mergeWindow);
  // ② pg_object：字典没观测到的建/改（窗口内 ctime/mtime）
  for (const o of input.pgObjects ?? []) {
    const kind = KIND_OF_RELKIND[o.kind] ?? o.kind;
    const ct = iso(o.ctime); const mt = iso(o.mtime);
    if (inWindow(ct) && near(o.sch, o.name, 'added', ct) === undefined) {
      events.push({ id: `p${++n}`, time: ct, sch: o.sch, name: o.name, kind, change: 'added', who: o.creator, sql: '', sources: ['pg_object'], newDef: undefined, defUnknown: true });
    }
    if (inWindow(mt) && ms(mt) - ms(ct) > 1000 && near(o.sch, o.name, 'modified', mt) === undefined && near(o.sch, o.name, 'added', mt) === undefined) {
      events.push({ id: `p${++n}`, time: mt, sch: o.sch, name: o.name, kind, change: 'modified', who: o.creator, sql: '', sources: ['pg_object'], defUnknown: true });
    }
  }
  // ③ 审计：按对象名 ±窗口吸附；吸不上的成独立事件（账号类 → user 泳道）
  for (const a of input.audit ?? []) {
    const t = iso(a.time); if (!inWindow(t)) continue;
    const tail = a.object.split('.').pop() ?? a.object;
    const hit = tail !== '' ? events.find((e) => !e.sources.includes('audit') && (e.name === tail || `${e.sch}.${e.name}` === a.object) && Math.abs(ms(e.time) - ms(t)) <= mergeWindow) : undefined;
    if (hit !== undefined) { hit.who = a.username; hit.sql = a.sql; hit.sources = [...hit.sources, 'audit']; hit.time = t; continue; }
    const isUser = /^ddl_(user|role|group)$/i.test(a.type);
    const kind = a.type.replace(/^ddl_/i, '') || 'statement';
    const change: Change = isUser ? 'user' : /^\s*drop/i.test(a.sql) ? 'removed' : /^\s*create/i.test(a.sql) ? 'added' : 'modified';
    events.push({ id: `a${++n}`, time: t, sch: isUser ? '' : (a.object.includes('.') ? a.object.split('.')[0] : ''), name: isUser ? a.object : tail, kind, change, who: a.username, sql: a.sql, sources: ['audit'], defUnknown: !isUser });
  }
  events.sort((x, y) => ms(x.time) - ms(y.time) || x.id.localeCompare(y.id));
  // pg_object 建表事件且此后无字典改动：当前定义即建表时定义
  const curDef = new Map<string, string | undefined>();
  for (const o of input.current) curDef.set(objKey(o.kind, o.sch, o.name), o.definition);
  for (const e of events) {
    if (e.sources[0] === 'pg_object' && e.change === 'added') {
      const later = events.some((x) => x !== e && x.sch === e.sch && x.name === e.name && x.change === 'modified' && ms(x.time) > ms(e.time) && x.sources.includes('dict'));
      const def = curDef.get(objKey(e.kind, e.sch, e.name));
      if (!later && def !== undefined) { e.newDef = def; e.defUnknown = false; }
    }
  }
  // ④ 主干版本：同一次字典快照里的变更是同一版（字典事件按快照时间分批；只有 pg_object/审计的事件按分钟取整），
  //    批内操作者以第一个有归因的为准，归因冲突才拆批；账号类单独成批
  const versions: Version[] = [];
  let cur: DdlEvent[] = [];
  const whoOf = (batch: DdlEvent[]) => batch.find((x) => x.who !== '')?.who ?? '';
  const bucketOf = (e: DdlEvent) => e.bucket ?? `min:${Math.floor(ms(e.time) / batchWindow)}`;
  const flush = () => {
    if (cur.length === 0) return;
    const who = whoOf(cur);
    for (const e of cur) if (e.who === '' && who !== '') e.who = who;   // 同批次同操作者
    versions.push(makeVersion(cur, versions.length + 1)); cur = [];
  };
  for (const e of events) {
    if (cur.length > 0) {
      const w = whoOf(cur);
      const split = bucketOf(cur[0]) !== bucketOf(e) || (cur[0].change === 'user') !== (e.change === 'user') || (w !== '' && e.who !== '' && w !== e.who);
      if (split) flush();
    }
    cur.push(e);
  }
  flush();
  const versionOf = new Map<string, string>();
  for (const v of versions) for (const id of v.eventIds) versionOf.set(id, v.v);
  // ⑤ 分支：schema 生命线 + 有变化对象的子线
  const lanes: Lane[] = [];
  const schemas = [...new Set(events.filter((e) => e.change !== 'user' && e.sch !== '').map((e) => e.sch))];
  const indexOwner = new Map<string, string>();
  for (const io of input.indexOwners ?? []) indexOwner.set(`${io.sch}.${io.index}`, io.table);
  for (const sch of schemas) {
    const evs = events.filter((e) => e.sch === sch && e.change !== 'user');
    const currentInSch = input.current.filter((o) => o.sch === sch);
    const earliestCtime = (input.pgObjects ?? []).filter((o) => o.sch === sch).map((o) => ms(iso(o.ctime))).sort((a, b) => a - b)[0];
    const firstAdd = evs.find((e) => e.change === 'added');
    const born = firstAdd !== undefined && (earliestCtime === undefined || earliestCtime >= ms(since) - 60_000) && !currentInSch.some((o) => o.firstSeen !== undefined && ms(iso(o.firstSeen)) < ms(firstAdd.time) - mergeWindow) ? firstAdd.time : null;
    const died = currentInSch.length === 0 && evs.some((e) => e.change === 'removed') && !evs.some((e) => e.change === 'added' && ms(e.time) > ms(evs.filter((x) => x.change === 'removed').map((x) => x.time).sort().pop() ?? '')) ? (evs.filter((e) => e.change === 'removed').map((e) => e.time).sort().pop() ?? null) : null;
    // 子线：表/视图各一条；索引事件挂到所属表
    const subs = new Map<string, SubLane>();
    const subFor = (kind: string, name: string): SubLane => {
      const key = objKey(kind, sch, name);
      let s = subs.get(key);
      if (s === undefined) { s = { key, sch, name, kind, born: null, died: null, events: [] }; subs.set(key, s); }
      return s;
    };
    // 索引归属表：优先 pg_indexes（现存索引），已删索引从定义原文 "ON sch.table" 里解析
    const ownerFromDef = (e: DdlEvent): string | undefined => {
      const m = /\bON\s+(?:"?[\w$]+"?\.)?"?([\w$]+)"?/i.exec(String(e.newDef ?? e.oldDef ?? ''));
      return m?.[1];
    };
    for (const e of evs) {
      let target: SubLane;
      if (e.kind === 'index') { const t = indexOwner.get(`${sch}.${e.name}`) ?? ownerFromDef(e); target = t !== undefined ? subFor('table', t) : subFor('index', e.name); }
      else target = subFor(e.kind, e.name);
      target.events.push({ time: e.time, change: e.change, versionId: versionOf.get(e.id) ?? '', who: e.who });
      const ownLane = target.kind === e.kind && target.name === e.name;   // 索引挂到表上时不改表的生死
      if (ownLane && e.change === 'added') target.born = e.time;
      if (ownLane && e.change === 'removed') target.died = e.time;
    }
    for (const s of subs.values()) s.events.sort((a, b) => ms(a.time) - ms(b.time));
    lanes.push({ id: sch, kind: 'schema', born, died, tables: currentInSch.filter((o) => o.kind === 'table').length, objects: currentInSch.length, note: `${evs.length} 次变更 · ${subs.size} 个对象`, versionIds: [...new Set(evs.map((e) => versionOf.get(e.id) ?? ''))].filter((v) => v !== ''), subs: [...subs.values()].sort((a, b) => ms(a.events[0]?.time ?? since) - ms(b.events[0]?.time ?? since)) });
  }
  const userEvents = events.filter((e) => e.change === 'user');
  if (userEvents.length > 0) lanes.push({ id: '账号 / 权限', kind: 'account', born: null, died: null, tables: 0, objects: 0, note: `${userEvents.length} 次账号/权限 DDL`, versionIds: [...new Set(userEvents.map((e) => versionOf.get(e.id) ?? ''))].filter((v) => v !== ''), subs: [] });
  // ⑥ 各对象定义时间线：从当前定义倒推
  const objects: Record<string, ObjectHistory> = {};
  const keys = [...new Set(events.filter((e) => e.change !== 'user' && e.sch !== '').map((e) => objKey(e.kind, e.sch, e.name)))];
  for (const key of keys) {
    const evs = events.filter((e) => objKey(e.kind, e.sch, e.name) === key);
    const first = evs[0];
    const exists = curDef.has(key);
    // 倒推：从当前状态出发，逐个变更回溯出"变更前"的定义
    let def: string | null | undefined = exists ? curDef.get(key) : null;
    const points: DefPoint[] = [];
    for (let i = evs.length - 1; i >= 0; i -= 1) {
      const e = evs[i];
      const after: string | null | undefined = e.change === 'removed' ? null : e.defUnknown ? (def ?? undefined) : (e.newDef ?? undefined);
      points.unshift({ time: e.time, versionId: versionOf.get(e.id) ?? null, def: after });
      def = e.change === 'added' ? null : e.defUnknown ? (e.change === 'modified' ? undefined : def) : (e.oldDef ?? undefined);
    }
    points.unshift({ time: since, versionId: null, def });
    objects[key] = { key, kind: first.kind, sch: first.sch, name: first.name, defs: points };
  }
  return { since, until, events, versions, lanes, objects };
}

function makeVersion(batch: DdlEvent[], idx: number): Version {
  const who = batch[0].who; const time = batch[0].time;
  const adds = batch.filter((e) => e.change === 'added'); const dels = batch.filter((e) => e.change === 'removed'); const mods = batch.filter((e) => e.change === 'modified');
  // 版本性质看表/视图/schema 级动作：删表 → del；建表 → add；只动索引/列 → mod
  const heavy = (e: DdlEvent) => e.kind === 'table' || e.kind === 'view' || e.kind === 'schema' || e.kind === 'matview';
  const kind: Version['kind'] = batch.every((e) => e.change === 'user') ? 'user' : dels.some(heavy) ? 'del' : adds.some(heavy) ? 'add' : 'mod';
  const schemas = [...new Set(batch.map((e) => e.sch).filter((s) => s !== ''))];
  const cnt = (list: DdlEvent[], k: string) => list.filter((e) => e.kind === k).length;
  let label: string;
  if (kind === 'user') label = batch.map((e) => e.sql !== '' ? e.sql.slice(0, 80) : `${e.kind} ${e.name}`).join('；');
  else if (adds.length >= 3 && schemas.length === 1 && mods.length === 0 && dels.length === 0) label = `建 schema ${schemas[0]}：${cnt(adds, 'table')} 表 · ${cnt(adds, 'index')} 索引${cnt(adds, 'view') > 0 ? ` · ${cnt(adds, 'view')} 视图` : ''}`;
  else if (dels.length >= 3 && schemas.length === 1 && adds.length === 0) label = `删 schema ${schemas[0]} 内 ${dels.length} 个对象`;
  else {
    const verb = (e: DdlEvent) => (e.change === 'added' ? '建' : e.change === 'removed' ? '删' : '改');
    const nameOf = (e: DdlEvent) => `${e.kind === 'table' ? '' : `${e.kind} `}${e.sch !== '' ? `${e.sch}.` : ''}${e.name}`;
    const head = batch.slice(0, 3).map((e) => `${verb(e)} ${nameOf(e)}`).join('；');
    label = batch.length > 3 ? `${head} 等 ${batch.length} 个对象` : head;
  }
  return { v: `v${idx}`, time, until: batch[batch.length - 1].time, who, kind, label, objs: batch.length, eventIds: batch.map((e) => e.id), schemas };
}

/** 某时点各对象的定义：null = 不存在，undefined = 未知（窗口内没有观测到定义） */
export function stateAt(objects: Record<string, ObjectHistory>, time: string): Record<string, string | null | undefined> {
  const t = ms(time); const out: Record<string, string | null | undefined> = {};
  for (const [key, o] of Object.entries(objects)) {
    let def: string | null | undefined = o.defs[0]?.def ?? null;
    for (const p of o.defs) { if (ms(p.time) <= t) def = p.def; else break; }
    out[key] = def;
  }
  return out;
}

export interface DiffRow { k: 'add' | 'del' | 'mod' | 'same'; t: string }
const splitCols = (def: string): { name: string; type: string; nn: boolean }[] =>
  def === '' ? [] : def.split(/,(?=[A-Za-z_"][^,:]*:)/).map((c) => { const parts = c.split(':'); const nn = parts[parts.length - 1] === 'true'; return { name: parts[0], type: parts.slice(1, -1).join(':'), nn }; });
const stripIndexDef = (d: string): string => d.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+\S+\s+ON\s+\S+\s+/i, '$1').trim();

/** 两个定义之间的行级差异（表按列名对齐；索引/视图整体比较） */
export function diffDefinition(kind: string, oldDef: string | null | undefined, newDef: string | null | undefined): DiffRow[] {
  if (oldDef === undefined || newDef === undefined) return [{ k: 'mod', t: '定义未知（该时段字典未观测到定义，只有时间戳）' }];
  if (kind === 'table') {
    const a = oldDef === null ? [] : splitCols(oldDef); const b = newDef === null ? [] : splitCols(newDef);
    const byA = new Map(a.map((c) => [c.name, c])); const byB = new Map(b.map((c) => [c.name, c]));
    const fmt = (c: { name: string; type: string; nn: boolean }) => `${c.name} ${c.type}${c.nn ? ' NOT NULL' : ''}`;
    const rows: DiffRow[] = [];
    for (const c of b) { const o = byA.get(c.name); if (o === undefined) rows.push({ k: 'add', t: fmt(c) }); else if (o.type !== c.type || o.nn !== c.nn) rows.push({ k: 'mod', t: `${c.name} ${o.type}${o.nn ? ' NOT NULL' : ''} → ${c.type}${c.nn ? ' NOT NULL' : ''}` }); else rows.push({ k: 'same', t: fmt(c) }); }
    for (const c of a) if (!byB.has(c.name)) rows.push({ k: 'del', t: fmt(c) });
    return rows;
  }
  const clean = (d: string) => (kind === 'index' ? stripIndexDef(d) : d.replace(/\s+/g, ' ').trim().slice(0, 400));
  if (oldDef === null && newDef !== null) return [{ k: 'add', t: clean(newDef) }];
  if (oldDef !== null && newDef === null) return [{ k: 'del', t: clean(oldDef) }];
  if (oldDef === newDef) return [{ k: 'same', t: clean(oldDef ?? '') }];
  return [{ k: 'mod', t: `${clean(oldDef ?? '')} → ${clean(newDef ?? '')}` }];
}

export interface ObjectDiff { key: string; kind: string; sch: string; name: string; change: 'add' | 'del' | 'mod'; rows: DiffRow[]; unknown: boolean }
export interface Compare { objects: ObjectDiff[]; summary: { add: number; del: number; mod: number; cols: { add: number; del: number; mod: number }; idx: { add: number; del: number; mod: number }; unknown: number } }
/** GitHub compare：两个时点之间每个对象的差异（只含有变化的对象） */
export function compareVersions(objects: Record<string, ObjectHistory>, timeA: string, timeB: string): Compare {
  const A = stateAt(objects, timeA); const B = stateAt(objects, timeB);
  const out: ObjectDiff[] = [];
  const summary = { add: 0, del: 0, mod: 0, cols: { add: 0, del: 0, mod: 0 }, idx: { add: 0, del: 0, mod: 0 }, unknown: 0 };
  for (const [key, o] of Object.entries(objects)) {
    const a = A[key]; const b = B[key];
    if (a === b) continue;
    if ((a === null || a === undefined) && (b === null || b === undefined)) continue;
    const unknown = a === undefined || b === undefined;
    const change: ObjectDiff['change'] = a === null ? 'add' : b === null ? 'del' : 'mod';
    const rows = diffDefinition(o.kind, a, b);
    out.push({ key, kind: o.kind, sch: o.sch, name: o.name, change, rows, unknown });
    summary[change] += 1; if (unknown) summary.unknown += 1;
    const bucket = o.kind === 'table' ? summary.cols : summary.idx;
    for (const r of rows) if (r.k !== 'same') bucket[r.k] += 1;
  }
  out.sort((x, y) => (x.change === y.change ? x.key.localeCompare(y.key) : x.change === 'mod' ? -1 : y.change === 'mod' ? 1 : x.change === 'add' ? -1 : 1));
  return { objects: out, summary };
}

/** 事件 → 规则引擎/时间轴用的 TimelineEntry（ddl.ts 的规则不动，只换数据来源） */
export function toTimelineEntries(events: readonly DdlEvent[]): { time: string; action: string; kind: string; object: string; user: string; sqlText: string; sources: string[] }[] {
  return events.map((e) => ({ time: e.time, action: e.change === 'user' ? 'ddl' : e.change, kind: e.change === 'user' ? e.kind : e.kind, object: e.sch !== '' ? `${e.sch}.${e.name}` : e.name, user: e.who, sqlText: e.sql, sources: e.sources }));
}
