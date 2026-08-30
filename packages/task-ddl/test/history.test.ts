import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHistory, stateAt, compareVersions, diffDefinition, toTimelineEntries } from '../src/history.ts';

// 模拟 og5 ddl_lab 实验 schema 的五个版本（时间为 ISO）
const SINCE = '2026-08-30T00:00:00Z', UNTIL = '2026-08-30T12:00:00Z';
const ORDERS_V1 = 'id:bigint:true,customer_id:bigint:true,amount:numeric(12,2):true';
const ORDERS_V2 = 'id:bigint:true,customer_id:bigint:true,amount:numeric(12,2):true,status:integer:true';
const ORDERS_V3 = 'id:bigint:true,customer_id:bigint:true,amount:numeric(18,2):true,status:integer:true';
const CUST_V1 = 'id:bigint:true,name:character varying(96):false';
const CUST_V2 = 'id:bigint:true,name:character varying(96):false,email:character varying(128):false';
const changes = [
  { time: '2026-08-30T01:00:00Z', kind: 'table', sch: 'ddl_lab', name: 'orders', change: 'added' as const, newDefinition: ORDERS_V1 },
  { time: '2026-08-30T01:00:00Z', kind: 'table', sch: 'ddl_lab', name: 'customers', change: 'added' as const, newDefinition: CUST_V1 },
  { time: '2026-08-30T01:00:00Z', kind: 'table', sch: 'ddl_lab', name: 'audit_log', change: 'added' as const, newDefinition: 'id:bigint:true,msg:text:false' },
  { time: '2026-08-30T02:00:00Z', kind: 'table', sch: 'ddl_lab', name: 'orders', change: 'modified' as const, oldDefinition: ORDERS_V1, newDefinition: ORDERS_V2 },
  { time: '2026-08-30T02:00:00Z', kind: 'index', sch: 'ddl_lab', name: 'orders_customer_idx', change: 'added' as const, newDefinition: 'CREATE INDEX orders_customer_idx ON ddl_lab.orders USING btree (customer_id)' },
  { time: '2026-08-30T02:00:00Z', kind: 'table', sch: 'ddl_lab', name: 'customers', change: 'modified' as const, oldDefinition: CUST_V1, newDefinition: CUST_V2 },
  { time: '2026-08-30T03:00:00Z', kind: 'table', sch: 'ddl_lab', name: 'orders', change: 'modified' as const, oldDefinition: ORDERS_V2, newDefinition: ORDERS_V3 },
  { time: '2026-08-30T03:00:00Z', kind: 'index', sch: 'ddl_lab', name: 'orders_customer_idx', change: 'removed' as const, oldDefinition: 'CREATE INDEX orders_customer_idx ON ddl_lab.orders USING btree (customer_id)' },
  { time: '2026-08-30T04:00:00Z', kind: 'table', sch: 'ddl_lab', name: 'audit_log', change: 'removed' as const, oldDefinition: 'id:bigint:true,msg:text:false' },
  { time: '2026-08-30T04:00:00Z', kind: 'table', sch: 'ddl_lab', name: 'customers', change: 'modified' as const, oldDefinition: CUST_V2, newDefinition: CUST_V1 },
];
const current = [
  { kind: 'table', sch: 'ddl_lab', name: 'orders', definition: ORDERS_V3, firstSeen: '2026-08-30T01:00:00Z' },
  { kind: 'table', sch: 'ddl_lab', name: 'customers', definition: CUST_V1, firstSeen: '2026-08-30T01:00:00Z' },
];
const pgObjects = [
  { sch: 'ddl_lab', name: 'orders', kind: 'r', ctime: '2026-08-30T00:59:40Z', mtime: '2026-08-30T02:59:50Z', creator: 'opendb_ro' },
  { sch: 'ddl_lab', name: 'customers', kind: 'r', ctime: '2026-08-30T00:59:41Z', mtime: '2026-08-30T03:59:50Z', creator: 'opendb_ro' },
];
const audit = [
  { time: '2026-08-30T02:59:50Z', type: 'ddl_table', username: 'opendb_ro', object: 'ddl_lab.orders', sql: 'ALTER TABLE ddl_lab.orders ALTER COLUMN amount TYPE numeric(18,2);' },
  { time: '2026-08-30T05:00:00Z', type: 'ddl_user', username: 'omm', object: 'opendb_ro', sql: 'ALTER USER opendb_ro SYSADMIN;' },
];
// 不传 indexOwners：已删索引在 pg_indexes 里查不到，归属表要从定义原文 "ON ddl_lab.orders" 解析
const H = buildHistory({ since: SINCE, until: UNTIL, changes, current, pgObjects, audit });

test('版本：同一操作者一分钟内的批次合成一版；账号 DDL 独立成版', () => {
  assert.deepEqual(H.versions.map((v) => `${v.v}:${v.kind}:${v.objs}`), ['v1:add:3', 'v2:mod:3', 'v3:mod:2', 'v4:del:2', 'v5:user:1'], '只动列/索引 = mod，删表 = del');
  assert.match(H.versions[0].label, /建 schema ddl_lab：3 表/);
  assert.equal(H.versions[0].who, 'opendb_ro', 'pg_object.creator 给字典事件补上操作者');
  assert.equal(H.versions[4].who, 'omm');
});

test('审计吸附：ALTER 原文挂到同一对象 ±15 分钟内的字典事件上', () => {
  const e = H.events.find((x) => x.name === 'orders' && x.change === 'modified' && x.sql !== '');
  assert.ok(e !== undefined);
  assert.deepEqual(e!.sources, ['dict', 'audit']);
  assert.match(e!.sql, /ALTER COLUMN amount/);
});

test('分支：schema 泳道从建立分出，子线含表与挂到表上的索引事件，账号泳道独立', () => {
  const lane = H.lanes.find((l) => l.id === 'ddl_lab')!;
  assert.equal(lane.born, '2026-08-30T01:00:00.000Z');
  assert.equal(lane.died, null);
  assert.equal(lane.tables, 2);
  const orders = lane.subs.find((s) => s.name === 'orders')!;
  assert.deepEqual(orders.events.map((e) => e.change), ['added', 'modified', 'added', 'modified', 'removed'], '索引事件挂在 orders 子线上');
  const audit_log = lane.subs.find((s) => s.name === 'audit_log')!;
  assert.equal(audit_log.died, '2026-08-30T04:00:00.000Z');
  assert.ok(H.lanes.some((l) => l.kind === 'account'));
});

test('定义时间线与 stateAt：任意时点还原每个对象的结构', () => {
  const s1 = stateAt(H.objects, '2026-08-30T01:30:00Z');
  assert.equal(s1['table ddl_lab.orders'], ORDERS_V1);
  assert.equal(s1['table ddl_lab.customers'], CUST_V1);
  const s3 = stateAt(H.objects, '2026-08-30T03:30:00Z');
  assert.equal(s3['table ddl_lab.orders'], ORDERS_V3);
  assert.equal(s3['index ddl_lab.orders_customer_idx'], null, '索引 03:00 已删');
  assert.equal(stateAt(H.objects, '2026-08-30T00:30:00Z')['table ddl_lab.orders'], null, '窗口起点尚未建表');
  assert.equal(stateAt(H.objects, '2026-08-30T04:30:00Z')['table ddl_lab.audit_log'], null);
});

test('compareVersions：v1 → v3 列级 diff（+status、amount 类型变、索引先加后删净零）', () => {
  // 版本之后的结构用 until（批次最后一个事件时刻）：v3 批次内 orders 改列在前、删索引在后
  const c = compareVersions(H.objects, H.versions[0].until, H.versions[2].until);
  const orders = c.objects.find((o) => o.name === 'orders')!;
  assert.equal(orders.change, 'mod');
  assert.deepEqual(orders.rows.filter((r) => r.k !== 'same').map((r) => `${r.k}:${r.t}`), ['mod:amount numeric(12,2) NOT NULL → numeric(18,2) NOT NULL', 'add:status integer NOT NULL']);
  assert.equal(c.objects.some((o) => o.name === 'orders_customer_idx'), false, '索引在 v2 建 v3 删，两端都不存在 → 不出现');
  assert.equal(c.summary.cols.add, 2, 'orders.status + customers.email');
  const v4 = compareVersions(H.objects, H.versions[0].until, H.versions[3].until);
  assert.equal(v4.objects.find((o) => o.name === 'audit_log')?.change, 'del');
  assert.equal(v4.objects.find((o) => o.name === 'customers'), undefined, 'email 加了又删，v1 与 v4 结构一致');
});

test('diffDefinition：numeric(18,2) 里的逗号不拆列；索引/视图整体比较；未知定义如实标注', () => {
  const rows = diffDefinition('table', 'a:numeric(18,2):true,b:text:false', 'a:numeric(18,2):true');
  assert.deepEqual(rows, [{ k: 'same', t: 'a numeric(18,2) NOT NULL' }, { k: 'del', t: 'b text' }]);
  assert.deepEqual(diffDefinition('index', 'CREATE INDEX i ON s.t USING btree (a)', 'CREATE INDEX i ON s.t USING btree (a, b)'), [{ k: 'mod', t: 'USING btree (a) → USING btree (a, b)' }]);
  assert.equal(diffDefinition('table', undefined, 'a:int:true')[0].t.includes('定义未知'), true);
});

test('pg_object 兜底：字典没观测到的建表/改表按 ctime/mtime 补事件并标 defUnknown；建表且此后无改动则定义 = 当前定义', () => {
  const h = buildHistory({ since: SINCE, until: UNTIL, changes: [], current: [{ kind: 'table', sch: 'lab2', name: 't1', definition: 'id:bigint:true' }], pgObjects: [{ sch: 'lab2', name: 't1', kind: 'r', ctime: '2026-08-30T06:00:00Z', mtime: '2026-08-30T06:00:00Z', creator: 'gaussdb' }, { sch: 'lab2', name: 't2', kind: 'r', ctime: '2026-08-29T06:00:00Z', mtime: '2026-08-30T07:00:00Z', creator: 'gaussdb' }], audit: [] });
  assert.deepEqual(h.events.map((e) => `${e.name}:${e.change}:${e.sources[0]}:${e.defUnknown}`), ['t1:added:pg_object:false', 't2:modified:pg_object:true']);
  assert.equal(stateAt(h.objects, UNTIL)['table lab2.t1'], 'id:bigint:true');
  assert.equal(stateAt(h.objects, UNTIL)['table lab2.t2'], undefined, 't2 当前定义未知（不在 current 且只有 mtime）');
  const tl = toTimelineEntries(h.events);
  assert.equal(tl[0].object, 'lab2.t1'); assert.equal(tl[0].action, 'added');
});
