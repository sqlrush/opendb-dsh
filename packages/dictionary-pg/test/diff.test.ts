import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDictDiff } from '../src/diff.ts';

const o = (kind: string, sch: string, name: string, signature: string) => ({ kind, sch, name, signature });

test('added / removed / modified / unchanged', () => {
  const stored = [o('table', 'public', 'a', 's1'), o('table', 'public', 'b', 's2'), o('view', 'public', 'v', 's3')];
  const current = [o('table', 'public', 'a', 's1'), o('table', 'public', 'b', 'sX'), o('index', 'public', 'i', 's4')];
  const changes = computeDictDiff(stored, current);
  const by = (c: string) => changes.filter((x) => x.change === c);
  assert.deepEqual(by('added').map((x) => x.name), ['i']);
  assert.deepEqual(by('modified').map((x) => x.name), ['b']);
  assert.deepEqual(by('removed').map((x) => x.name).sort(), ['v']);
  const mod = by('modified')[0];
  assert.equal(mod.oldSignature, 's2');
  assert.equal(mod.newSignature, 'sX');
});

test('empty stored → everything added; empty current → everything removed', () => {
  assert.equal(computeDictDiff([], [o('table', 's', 't', 'x')]).length, 1);
  assert.equal(computeDictDiff([o('table', 's', 't', 'x')], [])[0].change, 'removed');
  assert.deepEqual(computeDictDiff([], []), []);
});

test('duplicate snapshot rows count once', () => {
  const changes = computeDictDiff([], [o('table', 's', 't', 'x'), o('table', 's', 't', 'x')]);
  assert.equal(changes.length, 1);
});
