// 队列语义 e2e（2026-08-25，中毒 Runtime 复盘 Q2/Q3）：Host 派发 + Runtime 接力下，
// 连续提交的提问必须①在排队投影里可见 ②可移除 ③可插队进当前轮（steer）④最终全部处理、无残留。
// 走 Host 的 API（与浏览器同一条 socat 通道）：session.* RPC + /opendb queue/list + events.mux。
//   OPENDB_HOST_PORT=18080 node scripts/e2e-queue.mjs
const PORT = process.env.OPENDB_HOST_PORT ?? '18080';
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = BASE;
const envelope = (method, payload) => ({ type: 'client-request', rpcId: `q-${Math.random().toString(36).slice(2)}`, method, payload });
// 与浏览器同款：带上 traefik 粘性 cookie（opendb-host），HTTP 与 WS 落在同一个 Host 副本
let cookie = '';
const hdrs = () => ({ 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) });
const post = async (url, method, payload) => {
  const r = await fetch(url, { method: 'POST', headers: hdrs(), body: JSON.stringify(envelope(method, payload)) });
  const set = r.headers.get('set-cookie');
  if (set && !cookie && !process.env.NO_STICKY) cookie = set.split(';')[0];   // NO_STICKY=1：故意跨副本，验证 Host 写保护
  return r.json();
};
const rpc = (method, payload) => post(`${BASE}/api/${method}`, method, payload);
const opendb = async (endpoint, payload) => (await post(`${BASE}/opendb/${endpoint}`, endpoint, payload)).result;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (content) => (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');

// A 要跑得够久（>40s）：上一版三步 14s 就完了，B 还没来得及被插队
// 只用指标类工具：健康体检那类工具在绑定异常时会让模型反问用户（ask_user），e2e 无人应答就会卡住整轮
const A = '请严格分五步做，每步都必须真实调用工具，每步完成后用一两句话说明再进入下一步，任何情况下都不要向我提问、不要用 ask_user_question：1) 用 metrics_chart 画 og5 最近 10 分钟的 TPS 曲线；2) 用 metrics_chart 画 og5 最近 30 分钟的连接数曲线；3) 用 metrics_recent 列出 og5 最近 5 分钟的 QPS；4) 用 metrics_chart 画 og5 最近 1 小时的 CPU 曲线；5) 用 metrics_chart 画 og5 最近 1 小时的缓存命中率曲线。最后给出总结。';
const B = '排队消息B：把上面的结论压缩成一句话。';
const C = '排队消息C：这条会被移除，不应被处理。';

const created = await rpc('session.create', {});
const sessionId = created.result.value.sessionId;
console.log('session', sessionId);

const durable = [];            // user/message in log order: {id, text, seq}
const turns = [];              // 'start' | 'end' in order with seq
let running = null;
let hostQueueFrames = 0;
let agentErrors = [];
// 两条流：events.mux 带会话事件/排队帧，events.host 带 host/session-status、host/agent-error（浏览器两条都连）
const onFrame = (ev) => {
  const frame = JSON.parse(String(ev.data));
  const p = frame.payload ?? frame;
  if (p.sessionId !== sessionId) return;
  if (p.type === 'session/event') {
    const e = p.event;
    if (e.type === 'user/message') durable.push({ id: e.data.id, text: textOf(e.data.content), seq: e.seq });
    if (e.type === 'turn/start' || e.type === 'turn/end') turns.push({ kind: e.type, seq: e.seq });
  } else if (p.type === 'host/session-status') running = p.running;
  else if (p.type === 'session/queue') { if (p.items.length > 0) hostQueueFrames++; }
  else if (p.type === 'host/agent-error') agentErrors.push(p.message);
};
const sockets = ['events.mux', 'events.host'].map((s) => new WebSocket(`ws://127.0.0.1:${PORT}/api/${s}`, { headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } }));
for (const s of sockets) s.addEventListener('message', onFrame);
await Promise.all(sockets.map((s) => new Promise((r) => s.addEventListener('open', r))));
const ws = { close: () => sockets.forEach((s) => s.close()) };

const t0 = Date.now();
const prompt = (text) => rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] });
console.log('prompt A ->', JSON.stringify((await prompt(A)).result).slice(0, 80));
await sleep(1500);
console.log('prompt B ->', JSON.stringify((await prompt(B)).result).slice(0, 80));
await sleep(300);
console.log('prompt C ->', JSON.stringify((await prompt(C)).result).slice(0, 80));

let sawBothQueued = false, removedC = false, steeredB = false, steerResult = null, removeResult = null;
let lastItems = [];
const deadline = t0 + 300_000;
while (Date.now() < deadline) {
  const v = await opendb('queue/list', { sessionId });
  lastItems = v?.value?.items ?? [];
  const byText = (t) => lastItems.find((i) => textOf(i.message.content) === t);
  const b = byText(B), c = byText(C);
  if (b && c && !sawBothQueued) {
    sawBothQueued = true;
    console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s 排队投影: ${lastItems.map((i) => `${i.placement}:${textOf(i.message.content).slice(0, 8)}`).join(' | ')}`);
  }
  if (c && !removedC) {
    removeResult = (await rpc('session.updateQueue', { sessionId, itemId: c.id, action: { kind: 'remove' } })).result;
    removedC = true;
    console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s remove C ->`, JSON.stringify(removeResult).slice(0, 120));
  }
  if (b && removedC && !steeredB && running === true) {
    steerResult = (await rpc('session.updateQueue', { sessionId, itemId: b.id, action: { kind: 'steer' } })).result;
    steeredB = true;
    console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s steer B ->`, JSON.stringify(steerResult).slice(0, 120));
  }
  // done: idle, nothing projected, A's turn closed
  if (running === false && lastItems.length === 0 && turns.some((t) => t.kind === 'end') && durable.length >= 1 && Date.now() - t0 > 8000) break;
  await sleep(400);
}
ws.close();

// PG 实况（脚本在 mac 上跑，有 kubectl）：turn 骨架 + turn/end 原因——跨副本 resume 不得再往运行中的日志补 interrupted 闭合
let pgTurns = null;
try {
  const { execSync } = await import('node:child_process');
  const sql = `SELECT string_agg(seq || ':' || replace(type, 'turn/', '') || coalesce(':' || (data->'reason'->>'kind'), ''), ' ' ORDER BY seq) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type IN ('turn/start','turn/end')`;
  // k8s API 经 k8s-cp.orb.local（仅 IPv6）偶发 "no route to host" 几十秒：重试几次
  let lastErr;
  for (let i = 0; i < 4 && pgTurns === null; i++) {
    try {
      pgTurns = execSync(`kubectl -n opendb-dsh exec pod/opendb-dsh-postgres-0 -- psql -U dsh -d dsh -Atc "${sql}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin` } }).trim();
    } catch (e) { lastErr = e; await sleep(8000); }
  }
  if (pgTurns === null) throw lastErr;
} catch (e) { console.log('PG 实况检查跳过:', String(e.stderr ?? e.message).slice(0, 120)); }
const seqB = durable.find((d) => d.text.includes(B.slice(0, 8)))?.seq;
const seqA = durable.find((d) => d.text.includes(A.slice(0, 8)))?.seq;
const lastEnd = turns.filter((t) => t.kind === 'turn/end').at(-1)?.seq;
const starts = pgTurns !== null ? pgTurns.split(' ').filter((t) => t.endsWith(':start')).length : turns.filter((t) => t.kind === 'turn/start').length;
console.log('调试:', JSON.stringify({ seqA, seqB, lastEnd, starts }));
const bInsideATurn = seqA !== undefined && seqB !== undefined && lastEnd !== undefined && seqA < seqB && seqB < lastEnd && starts === 1;
const cDurable = durable.some((d) => d.text.includes(C.slice(0, 8)));
const noSpuriousInterrupt = pgTurns === null ? true : !pgTurns.includes(':interrupted');
console.log('--- 结果 ---');
console.log('user/message 顺序:', durable.map((d) => `${d.seq}:${d.text.slice(0, 6)}`).join(' → '));
console.log('turn 事件（mux）:', turns.map((t) => `${t.seq}:${t.kind.replace('turn/', '')}`).join(' '), '| PG:', pgTurns ?? '(未查)');
console.log('断言 · B、C 在 A 运行期间同时出现在排队投影:', sawBothQueued);
console.log('断言 · remove C 被接受且 C 从未落日志:', removeResult?.ok === true && !cDurable);
console.log('断言 · steer B 被接受且 B 在 A 这一轮内被处理（唯一一轮，seqA < seqB < turn/end）:', steerResult?.ok === true && bInsideATurn, steerResult?.ok ? '' : JSON.stringify(steerResult?.error ?? steerResult).slice(0, 160));
console.log('断言 · 日志里没有被 Host resume 补出来的 interrupted 闭合:', noSpuriousInterrupt);
console.log('断言 · 结束时投影为空、会话空闲:', lastItems.length === 0 && running === false);
console.log('信息 · Host 自身推的非空 session/queue 帧数:', hostQueueFrames, '| agent/error:', agentErrors.length ? agentErrors : '无', '| sticky:', process.env.NO_STICKY ? '关' : '开');
const ok = sawBothQueued && removeResult?.ok === true && !cDurable && steerResult?.ok === true && bInsideATurn && noSpuriousInterrupt && lastItems.length === 0 && running === false;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
