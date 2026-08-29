import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeModelError } from '../src/engine.ts';

test('describeModelError：余额不足 / 鉴权 / 限流 / 其他，都以「模型调用失败」开头且带可执行的下一步', () => {
  const quota = describeModelError({ code: 'QUOTA', status: 402, message: 'Insufficient Balance' });
  assert.match(quota, /^模型调用失败：模型服务余额不足（402 Insufficient Balance）/);
  assert.match(quota, /充值后任务自动恢复/);
  assert.match(describeModelError({ status: 401, message: 'invalid api key' }), /鉴权失败（401/);
  assert.match(describeModelError({ status: 429, message: 'rate limited' }), /限流（429/);
  assert.equal(describeModelError({ code: 'TRANSPORT', message: 'stream failed' }), '模型调用失败：TRANSPORT stream failed');
  assert.equal(describeModelError({}), '模型调用失败：ERROR');
});
