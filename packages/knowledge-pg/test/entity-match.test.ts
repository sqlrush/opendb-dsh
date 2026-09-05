import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entityMatchScore } from '../src/index.ts';

test('entityMatchScore：精确 / 包含 / 写法差异（空白、大小写、标点）不影响', () => {
  assert.equal(entityMatchScore('P1 事故', 'P1事故'), 1);
  assert.equal(entityMatchScore('BATCH_EOD', 'BATCH_EOD_*日终批作业'), 0.9);
  assert.equal(entityMatchScore('锁等待', '核心账务库在线锁等待/阻塞事件'), 0.9);
  assert.equal(entityMatchScore('核心账务库在线锁等待/阻塞事件', '锁等待'), 0.9);
});

test('entityMatchScore：短词对长实体靠字二元组覆盖率（2026-09-04 演示实测 kg_query 查不到的坑）', () => {
  // 核心/锁等/等待 三组命中，查询词 5 组二元组 → 0.6 × 0.85 = 0.51，过 0.45 下限但低于包含档
  const s = entityMatchScore('核心库锁等待', '核心账务库在线锁等待/阻塞事件');
  assert.ok(s >= 0.45 && s < 0.9, `score=${s}`);
  assert.ok(entityMatchScore('核心库锁等待', '双人复核') < 0.45);
});

test('entityMatchScore：空串与单字边界', () => {
  assert.equal(entityMatchScore('', 'x'), 0);
  assert.equal(entityMatchScore('x', ''), 0);
  assert.equal(entityMatchScore('a', 'b'), 0);
  assert.equal(entityMatchScore('a', 'abc'), 0.9);
});
