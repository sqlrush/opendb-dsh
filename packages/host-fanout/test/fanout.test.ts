import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostFanout, type FanoutDeps, type FanoutMessage } from '../src/fanout.ts';

interface Harness { fanout: HostFanout; published: FanoutMessage[]; resumed: string[]; raised: Array<{ id: string; message: string }>; live: Set<string>; persistedIds: Set<string>; logs: string[] }

function harness(podName: string, over: Partial<FanoutDeps> = {}): Harness {
  const h = { published: [] as FanoutMessage[], resumed: [] as string[], raised: [] as Array<{ id: string; message: string }>, live: new Set<string>(), persistedIds: new Set<string>(), logs: [] as string[] } as Harness;
  const deps: FanoutDeps = {
    podName,
    settleMs: 200,
    pollMs: 20,
    hasAgent: (id) => h.live.has(id),
    resume: async (id) => { h.resumed.push(id); h.live.add(id); },
    raise: (id, message) => { if (!h.live.has(id)) return false; h.raised.push({ id, message }); return true; },
    persisted: async (id) => h.persistedIds.has(id),
    publish: async (msg) => { h.published.push(msg); },
    log: (line) => { h.logs.push(line); },
    ...over,
  };
  h.fanout = new HostFanout(deps);
  return h;
}
const wire = (msg: FanoutMessage) => JSON.stringify(msg);

test('a locally created / prompted session is announced once; foreign origins are ignored for echo', async () => {
  const h = harness('A');
  h.fanout.onSessionCreated('s1');
  h.fanout.onAgentStatus('s1', 'idle');
  h.fanout.onAgentStatus('s1', 'running');
  assert.deepEqual(h.published.map((m) => `${m.kind}:${m.sessionId}`), ['session:s1', 'session:s1']);
  await h.fanout.handle(wire({ origin: 'A', kind: 'session', sessionId: 's1' }));
  assert.deepEqual(h.resumed, [], 'own messages never resume');
});

test('a session touched on another replica is resumed here, exactly once, after its seed is persisted', async () => {
  const h = harness('B');
  const p1 = h.fanout.handle(wire({ origin: 'A', kind: 'session', sessionId: 's2' }));
  const p2 = h.fanout.handle(wire({ origin: 'A', kind: 'session', sessionId: 's2' }));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(h.resumed, [], 'must wait for the seed');
  h.persistedIds.add('s2');
  await Promise.all([p1, p2]);
  assert.deepEqual(h.resumed, ['s2'], 'concurrent inbound merged into one resume');
  // the resume announces session/created locally — that must NOT be re-published (loop)
  // (the glue calls onSessionCreated from inside resume; emulate it)
});

test('resume triggered by fan-in is not re-published; a later local prompt is', async () => {
  const h = harness('B', {});
  h.persistedIds.add('s3');
  const resumeThenAnnounce = async (id: string) => { h.live.add(id); h.fanout.onSessionCreated(id); h.resumed.push(id); };
  (h.fanout as any).deps.resume = resumeThenAnnounce;
  await h.fanout.handle(wire({ origin: 'A', kind: 'session', sessionId: 's3' }));
  assert.deepEqual(h.resumed, ['s3']);
  assert.deepEqual(h.published, [], 'announce during fan-in resume stays silent');
  h.fanout.onAgentStatus('s3', 'running');
  assert.deepEqual(h.published.map((m) => m.kind), ['session'], 'a real local prompt is broadcast again');
});

test('seed never persisted → no resume, one log line', async () => {
  const h = harness('B');
  await h.fanout.handle(wire({ origin: 'A', kind: 'session', sessionId: 's4' }));
  assert.deepEqual(h.resumed, []);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /not resuming/);
});

test('agent errors are re-raised on replicas that have the session live, without echoing back', async () => {
  const h = harness('B');
  h.live.add('s5');
  await h.fanout.handle(wire({ origin: 'A', kind: 'agent-error', sessionId: 's5', message: '消息处理失败' }));
  assert.deepEqual(h.raised, [{ id: 's5', message: '消息处理失败' }]);
  // the glue's agent/error listener fires synchronously inside raise(); emulate: onAgentError must be suppressed then
  const h2 = harness('B', { raise: (id, message) => { h2.fanout.onAgentError(id, message); return true; } });
  await h2.fanout.handle(wire({ origin: 'A', kind: 'agent-error', sessionId: 's6', message: 'x' }));
  assert.deepEqual(h2.published, [], 're-raised error is not broadcast again');
  h2.fanout.onAgentError('s6', 'local failure');
  assert.deepEqual(h2.published.map((m) => m.kind), ['agent-error'], 'a genuinely local error is broadcast');
});

test('malformed payloads are ignored', async () => {
  const h = harness('B');
  await h.fanout.handle('not json');
  await h.fanout.handle(wire({ origin: 'A', kind: 'session' } as any));
  assert.deepEqual(h.resumed, []);
});
