const H = process.env.OPENDB_HOST ?? '192.168.139.164', P = process.env.OPENDB_HOST_PORT ?? '30080';
const API = `http://${H}:${P}/api`, ORIGIN = `http://${H}:${P}`;
const rpc = async (method, payload) => (await fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
  body: JSON.stringify({ type: 'client-request', rpcId: `f-${Math.random().toString(36).slice(2)}`, method, payload }) })).json();
const sessionId = (await rpc('session.create', {})).result.value.sessionId;
console.log('session', sessionId);
const ws = new WebSocket(`ws://${H}:${P}/api/events.mux`, { headers: { origin: ORIGIN } });
const counts = {};
ws.addEventListener('message', (ev) => { const f = JSON.parse(String(ev.data)); const p = f.payload ?? f; const k = `${p.type}${p.event?.type ? ':' + p.event.type : ''}${p.sessionId === sessionId ? '' : (p.sessionId ? '(other)' : '')}`; counts[k] = (counts[k] ?? 0) + 1; });
ws.addEventListener('open', async () => { console.log('open'); const r = await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: '只回复 OK' }] }); console.log('prompt', JSON.stringify(r).slice(0, 100)); });
setTimeout(() => { console.log(JSON.stringify(counts, null, 0)); process.exit(0); }, 40000);
