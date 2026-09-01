/**
 * 规则标签表 ↔ 判定的对账。面板的「通过项」= 标签表的键减去本次命中的，所以两个方向都会骗人：
 * 表里多一条平台从未实现的规则（曾经的 DDLR06「账号权限提升」）会凭空报"已通过"；
 * 少一条真会扫的规则（曾经的 DDLR07 不在通过项清单里）则从不出现，看报告的人以为没查过。
 * 2026-08-31 查 user 报的处置优先级显示问题时发现，顺手立此对账。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanDdlRules } from '../src/ddl.ts';
import { DDL_RULE_LABEL } from '../src/rule-label.ts';

/** 覆盖 scanDdlRules 全部分支的样例（DROP SCHEMA / DROP TABLE / TRUNCATE / DROP COLUMN / 业务时段 / 抖动 / 无 IF EXISTS） */
const ENTRIES = [
  { time: '2026-08-18T03:30:00.000Z', action: 'removed', kind: 'schema', object: 'gone_sch', user: 'omm', sqlText: 'DROP SCHEMA gone_sch CASCADE', sources: ['audit'] },
  { time: '2026-08-18T03:30:00.000Z', action: 'removed', kind: 'table', object: 'public.gone', user: 'omm', sqlText: 'DROP TABLE public.gone', sources: ['dict'] },
  { time: '2026-08-18T18:00:00.000Z', action: 'ddl', kind: 'statement', object: 'public.t2', user: '', sqlText: 'TRUNCATE public.t2', sources: ['audit'] },
  { time: '2026-08-18T18:05:00.000Z', action: 'ddl', kind: 'statement', object: 'public.t3', user: '', sqlText: 'ALTER TABLE public.t3 DROP COLUMN c1', sources: ['audit'] },
  { time: '2026-08-18T01:00:00.000Z', action: 'changed', kind: 'table', object: 'public.hot', user: '', sqlText: '', sources: ['dict'] },
  { time: '2026-08-18T02:00:00.000Z', action: 'changed', kind: 'table', object: 'public.hot', user: '', sqlText: '', sources: ['dict'] },
  { time: '2026-08-18T03:00:00.000Z', action: 'changed', kind: 'table', object: 'public.hot', user: '', sqlText: '', sources: ['dict'] },
] as any;

test('标签表覆盖扫描器吐出的每个规则码，且不含平台没实现的码', () => {
  const emitted = new Set(scanDdlRules(ENTRIES).map((f) => f.rule));
  for (const r of emitted) assert.ok(DDL_RULE_LABEL[r] !== undefined, `${r} 没有标签`);
  // 反向：表里除 DDLR90（审计不可用时由 tool-ddl-collect 补）外，都应是扫描器真会产出的码
  const scannerCodes = ['DDLR00', 'DDLR01', 'DDLR02', 'DDLR03', 'DDLR04', 'DDLR05', 'DDLR07'];
  assert.deepEqual(Object.keys(DDL_RULE_LABEL).filter((r) => r !== 'DDLR90').sort(), scannerCodes);
  for (const r of scannerCodes) assert.ok(emitted.has(r), `样例应触发 ${r}，未触发说明扫描器或样例漂了`);
});
