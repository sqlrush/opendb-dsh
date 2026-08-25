// Runtime 不可用场景 e2e（2026-08-25 复盘 Q1/Q2）：Runtime 缩到 0 →
//   ① 提问必须仍然"已提交、排队中"可见（排队投影），而不是凭空消失；
//   ② 模拟死信（attempts 到上限、failed_at）→ Host 必须以 agent/error 报给用户，并从投影撤下；
//   ③ Runtime 恢复后排队中的提问被处理。
// 在 mac 上跑（需要 kubectl）：OPENDB_HOST_PORT=18080 node scripts/e2e-queue-outage.mjs
import { execSync } from 'node:child_process';

const PORT = process.env.OPENDB_HOST_PORT ?? '18080';
const BASE = `http://127.0.0.1:${PORT}`;
const NS = 'opendb-dsh';
const envelope = (method, payload) => ({ type: 'client-request', rpcId: `q-${Math.random().toString(36).slice(2)}`, method, payload });
// 与浏览器同款：带上 traefik 粘性 cookie（opendb-host），HTTP 与 WS 落在同一个 Host 副本
let cookie = '';
const hdrs = () => ({ 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) });
const post = async (url, method, payload) => {
  const r = await fetch(url, { method: 'POST', headers: hdrs(), body: JSON.stringify(envelope(method, payload)) });
  const set = r.headers.get('set-cookie');
  if (set && !cookie) cookie = set.split(';')[0];
  return r.json();
};
const rpc = (method, payload) => post(`${BASE}/api/${method}`, method, payload);
const opendb = async (endpoint, payload) => (await post(`${BASE}/opendb/${endpoint}`, endpoint, payload)).result;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (content) => (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
// k8s API 经 k8s-cp.orb.local（仅 IPv6）偶发 "no route to host" 几十秒：kubectl 调用一律重试
const sh = (cmd) => {
  let last;
  for (let i = 0; i < 4; i++) {
    try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
    catch (e) { last = e; execSync('sleep 8'); }
  }
  throw last;
};
const psql = (sql) => sh(`kubectl -n ${NS} exec pod/opendb-dsh-postgres-0 -- psql -U dsh -d dsh -Atc "${sql.replace(/"/g, '\\"')}"`);
const runtimePods = () => sh(`kubectl -n ${NS} get pods -l opendb.runtimeClass=default --no-headers 2>/dev/null | wc -l`).trim();

const D = '停机期间的提问D：这条会被模拟成死信。';
const E = '停机期间的提问E：Runtime 恢复后应被处理，只回复"收到E"。';

const results = {};
let agentErrors = [];
const durable = [];
let ws;
// Runtime 副本数归 KEDA 管（ScaledObject min=2）：直接 scale 会被立刻改回；用 KEDA 的 paused-replicas 注解钉在 0
const SO = 'scaledobject/opendb-dsh-runtime-default';
const pauseRuntimes = () => sh(`kubectl -n ${NS} annotate ${SO} autoscaling.keda.sh/paused-replicas=0 --overwrite`);
const resumeRuntimes = () => { sh(`kubectl -n ${NS} annotate ${SO} autoscaling.keda.sh/paused-replicas- --overwrite`); sh(`kubectl -n ${NS} scale deploy/opendb-dsh-runtime-default --replicas=2`); };
try {
  console.log('KEDA 暂停 runtime-default → 0 副本');
  pauseRuntimes();
  for (let i = 0; i < 90 && runtimePods() !== '0'; i++) await sleep(2000);
  console.log('runtime pods:', runtimePods());
  if (runtimePods() !== '0') throw new Error('Runtime 没能缩到 0，放弃本场景');

  const sessionId = (await rpc('session.create', {})).result.value.sessionId;
  console.log('session', sessionId);
  // events.host 带 host/agent-error（红条），events.mux 带会话事件——浏览器两条都连
  const sockets = ['events.mux', 'events.host'].map((s) => new WebSocket(`ws://127.0.0.1:${PORT}/api/${s}`, { headers: { origin: BASE, ...(cookie ? { cookie } : {}) } }));
  for (const s of sockets) s.addEventListener('message', (ev) => {
    const p = JSON.parse(String(ev.data)).payload ?? {};
    if (p.sessionId !== sessionId) return;
    if (p.type === 'host/agent-error') agentErrors.push(p.message);
    if (p.type === 'session/event' && p.event?.type === 'user/message') durable.push(textOf(p.event.data.content));
  });
  await Promise.all(sockets.map((s) => new Promise((r) => s.addEventListener('open', r))));
  ws = { close: () => sockets.forEach((s) => s.close()) };

  const prompt = (text) => rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] });
  await prompt(D);
  // ① 8 秒内每次都可见
  let visible = 0, polls = 0;
  for (let i = 0; i < 8; i++) {
    const items = (await opendb('queue/list', { sessionId }))?.value?.items ?? [];
    polls++; if (items.some((it) => textOf(it.message.content) === D && it.placement === 'queued')) visible++;
    await sleep(1000);
  }
  results.visibleWhileDown = visible === polls;
  console.log(`断言 · Runtime 全停时提问 D 持续可见（${visible}/${polls} 次轮询）:`, results.visibleWhileDown);

  // ② 模拟死信：像 Runtime 三次失败后那样标记
  const n = psql(`UPDATE dsh_thread_queue SET failed_at = now(), attempts = 3, last_error = 'simulated poison (e2e)' WHERE session_id = '${sessionId}' AND admitted_at IS NULL AND failed_at IS NULL`);
  console.log('标记死信:', n);
  let reported = false, gone = false;
  for (let i = 0; i < 15 && !(reported && gone); i++) {
    await sleep(1000);
    reported = agentErrors.some((m) => String(m).includes('消息处理失败'));
    const items = (await opendb('queue/list', { sessionId }))?.value?.items ?? [];
    gone = !items.some((it) => textOf(it.message.content) === D);
  }
  results.deadLetterReported = reported && gone;
  console.log('断言 · 死信被 Host 以 agent/error 报给用户且从投影撤下:', results.deadLetterReported, agentErrors[0] ? `| ${String(agentErrors[0]).slice(0, 100)}` : '');

  // ③ 再提问 E，恢复 Runtime，E 被处理
  await prompt(E);
  await sleep(1500);
  const itemsE = (await opendb('queue/list', { sessionId }))?.value?.items ?? [];
  console.log('E 排队可见:', itemsE.some((it) => textOf(it.message.content) === E));
  console.log('KEDA 恢复 runtime-default → 2 副本');
  resumeRuntimes();
  const t0 = Date.now();
  while (Date.now() - t0 < 240_000 && !durable.includes(E)) await sleep(1000);
  results.recoveredAfterScaleUp = durable.includes(E);
  console.log(`断言 · Runtime 恢复后 E 被处理（${((Date.now() - t0) / 1000).toFixed(0)}s）:`, results.recoveredAfterScaleUp);
  // D 是死信，绝不能被处理
  results.deadLetterNeverRuns = !durable.includes(D);
  console.log('断言 · 死信 D 从未被处理:', results.deadLetterNeverRuns);
} finally {
  try { resumeRuntimes(); } catch { /* 已恢复 */ }
  ws?.close();
}
const ok = Object.values(results).every(Boolean) && Object.keys(results).length === 4;
console.log(ok ? 'PASS' : 'FAIL', JSON.stringify(results));
process.exit(ok ? 0 : 1);
