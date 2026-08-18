import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMemoryContext, latestUserText } from '../src/index.ts';

const mem = (id: string, content: string) => ({ id, kind: 'report', createdAt: new Date('2026-08-19T00:00:00Z'), content });

test('renderMemoryContext: dedup, searched first, byte cap, empty→undefined', () => {
  const text = renderMemoryContext([mem('a', '巡检正常'), mem('b', '库大小 143MB')], [mem('a', '巡检正常')], 6144)!;
  assert.match(text, /<system-reminder>/);
  assert.equal((text.match(/- \(/g) ?? []).length, 2);   // a 去重
  assert.equal(renderMemoryContext([], [], 6144), undefined);
  const capped = renderMemoryContext([mem('x', 'y'.repeat(300)), mem('z', 'w'.repeat(300))], [], 350)!;
  assert.equal((capped.match(/- \(/g) ?? []).length, 1);
});

test('latestUserText: skips plugin-sourced, takes newest real user text', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '第一条' }] },
    { role: 'assistant', content: [{ type: 'text', text: '答' }] },
    { role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: '注入的指令' }] },
    { role: 'user', content: [{ type: 'text', text: '上次巡检结论是什么' }] },
  ];
  assert.equal(latestUserText(messages), '上次巡检结论是什么');
  assert.equal(latestUserText([]), '');
});
