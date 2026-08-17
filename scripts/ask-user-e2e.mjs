// P0 acceptance ③: cross-process ask_user. Connects to the Host mux stream, prompts the agent to ask a
// question, auto-answers the first question/requested frame, and waits for the assistant's final message.
const PORT = process.env.OPENDB_HOST_PORT ?? '3090';
const API = `http://127.0.0.1:${PORT}/api`;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const rpc = async (method, payload) => {
  const r = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ type: 'client-request', rpcId: `q-${Math.random().toString(36).slice(2)}`, method, payload }) });
  return r.json();
};
const created = await rpc('session.create', {});
const sessionId = created.result.value.sessionId;
console.log('session', sessionId);
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/events.mux`, { headers: { origin: ORIGIN } });
let answered = false, done = false;
const finish = (msg) => { console.log(msg); done = true; ws.close(); };
ws.addEventListener('open', async () => {
  console.log('mux open');
  await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: '在回答之前，必须先用 ask_user_question 工具问我一个单选问题："今天检查哪个库？"，选项 A=orders B=billing。等我回答后，只回复一句"你选了 X"。' }] });
});
ws.addEventListener('message', async (ev) => {
  const frame = JSON.parse(String(ev.data));
  const p = frame.payload ?? frame;
  if (p.type === 'question/requested' && p.sessionId === sessionId && !answered) {
    answered = true;
    console.log('question/requested:', JSON.stringify(p.questions).slice(0, 300));
    const q = p.questions[0];
    const selected = [q.options?.[0]?.label ?? 'A = orders'];   // answers select by option label
    const r = await fetch(`${API}/respond`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ type: 'client-response', rpcId: frame.rpcId, result: { ok: true, value: { sessionId, answer: { answers: [{ id: q.id, selected }] } } } }) });
    const resp = await r.json();
    console.log('respond ->', JSON.stringify(resp).slice(0, 200));
  }
  if (p.type === 'session/event' && p.sessionId === sessionId && p.event?.type === 'assistant/message') {
    const text = JSON.stringify(p.event.data.message?.content ?? '').slice(0, 200);
    console.log('assistant/message:', text);
  }
  if (p.type === 'session/event' && p.sessionId === sessionId && p.event?.type === 'turn/end') finish(`turn/end ${JSON.stringify(p.event.data.reason)} answered=${answered}`);
});
ws.addEventListener('error', (e) => console.log('ws error', e.message ?? e));
setTimeout(() => { if (!done) finish('TIMEOUT'); process.exit(answered ? 0 : 2); }, 150000);
