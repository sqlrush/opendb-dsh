import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlatformAgent } from '../src/agent.ts';

const registry = {
  async getAgentByWorkspace(id: string) { return id === 'ws1' ? { id: 'a1', name: 'by-ws' } : undefined; },
  async getAgentByName(name: string) { return name === 'og-lab' ? { id: 'a2', name: 'og-lab' } : undefined; },
};

test('workspace binding wins', async () => {
  const r = await resolvePlatformAgent(registry, { session: { header: { metadata: { workspaceId: 'ws1' }, cwd: '/x/agents/og-lab' } } });
  assert.deepEqual(r, { id: 'a1', name: 'by-ws' });
});

test('cwd /agents/<name> fallback', async () => {
  const r = await resolvePlatformAgent(registry, { session: { header: { cwd: '/home/dsh/agents/og-lab' } } });
  assert.deepEqual(r, { id: 'a2', name: 'og-lab' });
});

test('unresolvable → undefined', async () => {
  assert.equal(await resolvePlatformAgent(registry, { session: { header: { cwd: '/tmp/nope' } } }), undefined);
  assert.equal(await resolvePlatformAgent(registry, {}), undefined);
});
