import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatReportMemory } from '../src/index.ts';

test('formatReportMemory: inspection findings', () => {
  const s = formatReportMemory({
    date: '2026-08-19', taskName: 'og5手动巡检', taskType: 'inspection', severity: 'warn', summary: '发现锁等待',
    findings: [
      { node: 'og5', item: 'locks', level: 'warn', detail: '3 个等待锁' },
      { node: 'og5', item: 'sessions', level: 'ok', detail: '' },
    ],
    maxFindings: 5,
  });
  assert.match(s, /\[2026-08-19\] 任务「og5手动巡检」\(inspection\) 结论 warn：发现锁等待/);
  assert.match(s, /- \[warn\] og5 locks：3 个等待锁/);
  assert.match(s, /- \[ok\] og5 sessions/);
});

test('formatReportMemory: sql-audit findings + truncation note', () => {
  const s = formatReportMemory({
    date: '2026-08-19', taskName: 'SQL审核', taskType: 'sql-audit', severity: 'warn', summary: '2 条建议',
    findings: [
      { sql: 'SELECT * FROM big', issue: '全表扫', suggestion: '加索引 idx_x' },
      { sql: 'UPDATE t ...', issue: '无 WHERE', suggestion: '补条件' },
      { sql: 'q3', issue: 'i3', suggestion: 's3' },
    ],
    maxFindings: 2,
  });
  assert.match(s, /SQL「SELECT \* FROM big」全表扫（建议：加索引 idx_x）/);
  assert.match(s, /（其余 1 条略）/);
});
