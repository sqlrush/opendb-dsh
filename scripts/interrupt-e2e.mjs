// P0 acceptance ④: cross-process interrupt. Prompt a long generation, cancel after 4s via session.cancel,
// expect the Runtime to abort the turn (turn/end reason.kind !== 'completed').
const PORT = process.env.OPENDB_HOST_PORT ?? '3090';
const HOSTNAME = process.env.OPENDB_HOST ?? '127.0.0.1';
const API = `http://${HOSTNAME}:${PORT}/api`, ORIGIN = `http://${HOSTNAME}:${PORT}`;
const rpc = async (method, payload) => (await fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
  body: JSON.stringify({ type: 'client-request', rpcId: `i-${Math.random().toString(36).slice(2)}`, method, payload }) })).json();
const sessionId = (await rpc('session.create', {})).result.value.sessionId;
console.log('session', sessionId);
const ws = new WebSocket(`ws://${HOSTNAME}:${PORT}/api/events.mux`, { headers: { origin: ORIGIN } });
let chunks = 0, cancelled = false;
ws.addEventListener('open', async () => {
  await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: '请写一篇 3000 字的关于 PostgreSQL WAL 机制的详细文章，不要省略。' }] });
  setTimeout(async () => { const r = await rpc('session.cancel', { sessionId }); cancelled = true; console.log('cancel ->', JSON.stringify(r).slice(0, 160), 'chunks so far', chunks); }, 6000);
});
ws.addEventListener('message', (ev) => {
  const p = JSON.parse(String(ev.data)).payload ?? {};
  if (p.type !== 'session/event' || p.sessionId !== sessionId) return;
  if (p.event.type === 'assistant/chunk') chunks++;
  if (p.event.type === 'turn/end') { console.log('turn/end', JSON.stringify(p.event.data.reason), 'chunks', chunks, 'cancelled', cancelled); process.exit(p.event.data.reason.kind === 'completed' ? 2 : 0); }
});
setTimeout(() => { console.log('TIMEOUT chunks', chunks); process.exit(3); }, 120000);
