import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQL_AUDIT_TASK_TYPE } from '../src/index.ts';

const ctx = { nodesOf: async () => [{ id: 'n1', name: 'og5', engine: 'opengauss', host: 'h', port: 5433, dbname: 'postgres', status: 'online' }] } as any;

test('config bounds and report schema', () => {
  const c = SQL_AUDIT_TASK_TYPE.configSchema({ topN: 5 });
  assert.equal(c.topN, 5);
  assert.equal(c.minCalls, 2);
  assert.throws(() => SQL_AUDIT_TASK_TYPE.configSchema({ topN: 99 }));
  assert.throws(() => SQL_AUDIT_TASK_TYPE.reportSchema({ findings: [{ sql: 'x' }] }));
  const ok = SQL_AUDIT_TASK_TYPE.reportSchema({ findings: [{ sql: 's', issue: 'i', suggestion: 'g' }] }) as any;
  assert.equal(ok.findings[0].evidence, '');
});

test('buildPrompt embeds node, topN, minCalls', async () => {
  const task = { agentId: 'a1', config: SQL_AUDIT_TASK_TYPE.configSchema({ topN: 7, minCalls: 3 }) } as any;
  const p = await SQL_AUDIT_TASK_TYPE.buildPrompt(task, {} as any, ctx);
  assert.match(p, /「og5」/);
  assert.match(p, /LIMIT 7/);
  assert.match(p, /n_calls >= 3/);
  assert.match(p, /EXPLAIN ANALYZE 会被平台拒绝/);
});
