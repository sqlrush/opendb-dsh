// Runtime 滚动/终止切断轮次的自愈 e2e（2026-08-25 第四轮复盘）：
//   长提问运行中 → kubectl delete 正在跑它的 Runtime pod（SIGTERM，dsh 会取消轮次）
//   → 期望：第一轮 turn/end interrupted；队列行换新消息 id 重投（attempts=1）；另一台 pod 重跑；最终 turn/end completed。
// 在 mac 上跑（需要 kubectl）：OPENDB_HOST_PORT=18080 node scripts/e2e-queue-shutdown.mjs
import { execSync } from 'node:child_process';

const PORT = process.env.OPENDB_HOST_PORT ?? '18080';
const BASE = `http://127.0.0.1:${PORT}`;
const NS = 'opendb-dsh';
const envelope = (method, payload) => ({ type: 'client-request', rpcId: `q-${Math.random().toString(36).slice(2)}`, method, payload });
let cookie = '';
const hdrs = () => ({ 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) });
const post = async (url, method, payload) => {
  const r = await fetch(url, { method: 'POST', headers: hdrs(), body: JSON.stringify(envelope(method, payload)) });
  const set = r.headers.get('set-cookie'); if (set && !cookie) cookie = set.split(';')[0];
  return r.json();
};
const rpc = (method, payload) => post(`${BASE}/api/${method}`, method, payload);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => { let last; for (let i = 0; i < 4; i++) { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { last = e; execSync('sleep 8'); } } throw last; };
const psql = (sql) => sh(`kubectl -n ${NS} exec pod/opendb-dsh-postgres-0 -- psql -U dsh -d dsh -Atc "${sql.replace(/"/g, '\\"')}"`);

const A = '请严格分五步做，每步都必须真实调用工具，每步完成后用一两句话说明再进入下一步，任何情况下都不要向我提问、不要用 ask_user_question：1) 用 metrics_chart 画 og5 最近 10 分钟的 TPS 曲线；2) 用 metrics_chart 画 og5 最近 30 分钟的连接数曲线；3) 用 metrics_recent 列出 og5 最近 5 分钟的 QPS；4) 用 metrics_chart 画 og5 最近 1 小时的 CPU 曲线；5) 用 metrics_chart 画 og5 最近 1 小时的缓存命中率曲线。最后给出总结。';

const sessionId = (await rpc('session.create', {})).result.value.sessionId;
console.log('session', sessionId);
await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: A }] });

// 等它被认领并跑起来（有 tool/call 之后再杀，确保是"运行中"被切断）
let pod = '';
for (let i = 0; i < 60 && !pod; i++) {
  await sleep(2000);
  const running = psql(`SELECT running_pod FROM dsh_threads WHERE session_id = '${sessionId}' AND status = 'running'`);
  const calls = psql(`SELECT count(*) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'tool/call'`);
  if (running && Number(calls) >= 1) pod = running;
}
if (!pod) { console.log('FAIL 60s 内没跑起来'); process.exit(1); }
const q0 = psql(`SELECT id || '|' || message_id || '|' || attempts FROM dsh_thread_queue WHERE session_id = '${sessionId}' ORDER BY id DESC LIMIT 1`);
console.log('运行中的 pod:', pod, '| 队列行:', q0);
console.log('kubectl delete pod（SIGTERM）...');
sh(`kubectl -n ${NS} delete pod ${pod} --wait=false`);

// 期望链：interrupted → 重投（新 id、attempts 1）→ 另一台认领 → completed
const t0 = Date.now();
let done = false, detail = {};
while (Date.now() - t0 < 300_000) {
  await sleep(3000);
  const ends = psql(`SELECT string_agg(seq || ':' || (data->'reason'->>'kind'), ' ' ORDER BY seq) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'turn/end'`);
  const users = psql(`SELECT count(*) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'user/message' AND data->'source'->>'kind' = 'user'`);
  const q = psql(`SELECT id || '|' || coalesce(message_id, '-') || '|' || attempts || '|' || coalesce(admitted_by, '-') || '|' || (failed_at IS NOT NULL) FROM dsh_thread_queue WHERE session_id = '${sessionId}' ORDER BY id DESC LIMIT 1`);
  detail = { ends, users: Number(users), queue: q };
  if (/completed/.test(ends)) { done = true; break; }
}
const [qid, mid, attempts, by] = (detail.queue || '').split('|');
const [, mid0, attempts0] = q0.split('|');
console.log('--- 结果 ---', JSON.stringify(detail));
const interruptedFirst = /^\d+:interrupted/.test(detail.ends || '');
const rotated = mid !== mid0 && Number(attempts) === Number(attempts0) + 1;
const rerunElsewhere = by && by !== pod;
console.log('断言 · 第一轮被终止标记 interrupted:', interruptedFirst);
console.log('断言 · 队列行换新消息 id 重投（attempts +1）:', rotated, `${mid0.slice(0, 8)} → ${String(mid).slice(0, 8)}, attempts ${attempts0} → ${attempts}`);
console.log('断言 · 由另一台 Runtime 重跑:', rerunElsewhere, `${pod} → ${by}`);
console.log('断言 · 用户消息在日志里出现两次（原轮 + 重发）:', detail.users === 2);
console.log('断言 · 最终 completed:', done, `${((Date.now() - t0) / 1000).toFixed(0)}s`);
const ok = interruptedFirst && rotated && rerunElsewhere && detail.users === 2 && done;
console.log(ok ? 'PASS' : 'FAIL', sessionId);
process.exit(ok ? 0 : 1);
