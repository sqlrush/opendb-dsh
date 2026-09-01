/**
 * 处置优先级徽章归一化（chart-kit 的 normalizePriority）。
 * 起因：2026-08-31 user 报「DDL 报告处置优先级显示有问题」——模型把整句叙述填进了 `p`
 * （schema 只约束是字符串），面板用固定 34px 的徽章列去装，一个字一行把卡片撑成一条竖带。
 * 这里锁住三种真实形状的渲染契约（样例即线上存档里的原值）。
 * 注意：chart-kit 是 .tsx，node 的 strip-types 不认 JSX，所以从构建产物导入（CI 先 build 再 test）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePriority } from '@opendb-dsh/chart-kit';

test('P0/P1 原样识别为档位，不产生标题行', () => {
  assert.deepEqual(normalizePriority({ p: 'P0', action: '立即处置' }, 0), { badge: 'P0', title: '', action: '立即处置' });
  assert.equal(normalizePriority({ p: '1', action: 'x' }, 3).badge, 'P1');
  assert.equal(normalizePriority({ p: 'p2', action: 'x' }, 0).badge, 'P2');
});

test('短词档位（wdr 实际填过 high/medium/low）原样显示，不擅自映射成 P0/P1/P2', () => {
  const r = normalizePriority({ p: 'high', action: '强制串行大聚合' }, 0);
  assert.equal(r.badge, 'high');
  assert.equal(r.title, '');
});

test('整句叙述改当标题，徽章退回序号——正是 user 报的那条', () => {
  const p = { p: '人工确认 omm 于北京时间 10:07 的三条 DROP SCHEMA CASCADE 是否计划内、是否有备份/回退预案（对象已不可恢复，重点是知情确认与流程追溯）', action: '向 omm 及其主管发起变更知情确认' };
  const r = normalizePriority(p, 0);
  assert.equal(r.badge, '#1');
  assert.equal(r.title, p.p);
  assert.equal(r.action, p.action);
});

test('p 缺失或为空时不炸，退回序号', () => {
  assert.equal(normalizePriority({ action: 'x' }, 1).badge, '#2');
  assert.equal(normalizePriority({ p: '  ', action: 'x' }, 0).title, '');
});

