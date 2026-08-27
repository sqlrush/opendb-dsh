// 所有权栅栏验收（2026-08-27 同一轮被两台 Runtime 同时执行的事故）：
//   一轮正在某个 Runtime 上跑时，模拟 Host 把线程回收/重派（running_pod 改成别的 pod）——
//   期望：① 原 pod 在一次心跳内（≤ heartbeatMs+2s）取消本地轮次，日志出现 "ownership lost"；
//        ② 线程行不被原 pod 改回（running_pod 仍是 ghost）；③ 队列行不被原 pod 重投（admitted 保持、attempts 不涨）；
//        ④ 会话日志 turn/end reason=interrupted，且之后没有新的 user/message（没有第三遍）。
//   OPENDB_HOST_PORT=18080 node scripts/e2e-queue-fence.mjs   （mac 上跑，需要 kubectl）
import { execSync } from 'node:child_process';
const PORT = process.env.OPENDB_HOST_PORT ?? '18080';
const BASE = `http://127.0.0.1:${PORT}`;
const envelope = (method, payload) => ({ type: 'client-request', rpcId: `q-${Math.random().toString(36).slice(2)}`, method, payload });
let cookie = '';
const post = async (url, method, payload) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(envelope(method, payload)) });
  const set = r.headers.get('set-cookie'); if (set && !cookie) cookie = set.split(';')[0];
  return r.json();
};
const rpc = (method, payload) => post(`${BASE}/api/${method}`, method, payload);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => { let last; for (let i = 0; i < 4; i++) { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin` } }).trim(); } catch (e) { last = e; execSync('sleep 4'); } } throw last; };
const psql = (sql) => sh(`kubectl -n opendb-dsh exec pod/opendb-dsh-postgres-0 -- psql -U dsh -d dsh -Atc "${sql.replace(/"/g, '\\"')}"`);
const checks = [];
const check = (name, ok, extra = '') => { checks.push(ok); console.log(`${ok ? '✔' : '✖'} ${name}${extra ? ` — ${extra}` : ''}`); return ok; };

// 一个会跑一会儿的提问（只读工具，不向用户提问）
const PROMPT = '请用 db_overview 看一下 og5 的概况，然后用 db_query 分别查 dbe_perf.statement 按 total_elapse_time 降序前 5 条、按 n_calls 降序前 5 条，最后用 metrics_recent 看最近 10 分钟指标，把三段结果各贴一段给我。不要向我提问。';
const workspaceId = psql("SELECT global->'workspaceIds'->>0 FROM dsh_kv_units WHERE unit = 'workspace'");
const created = await rpc('session.create', workspaceId ? { workspaceId } : {});
if (!created.result?.ok) { console.log('FAIL session.create', JSON.stringify(created).slice(0, 200)); process.exit(1); }
const sessionId = created.result.value.sessionId;
console.log('session', sessionId);
const cleanup = () => { if (process.env.KEEP) return; try {
  psql(`UPDATE dsh_threads SET status = 'idle', running_pod = NULL WHERE session_id = '${sessionId}'`);
  for (const t of ['dsh_questions', 'dsh_thread_queue', 'dsh_threads', 'dsh_session_events']) psql(`DELETE FROM ${t} WHERE session_id = '${sessionId}'`);
  psql(`DELETE FROM dsh_sessions WHERE id = '${sessionId}'`); console.log('测试会话已删除');
} catch (e) { console.log('清理失败:', String(e.message).slice(0, 100)); } };
process.on('exit', cleanup);

await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: PROMPT }] });
// 等某个 Runtime 领走并开始跑（至少一次 tool/call 说明真在跑）
let pod = '';
for (let t0 = Date.now(); Date.now() - t0 < 120_000; await sleep(2000)) {
  pod = psql(`SELECT coalesce(running_pod, '') FROM dsh_threads WHERE session_id = '${sessionId}' AND status = 'running'`);
  const calls = Number(psql(`SELECT count(*) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'tool/call'`));
  if (pod !== '' && calls >= 1) break;
}
check('轮次已在 Runtime 上运行', pod !== '', `pod=${pod}`);
if (pod === '') process.exit(1);
const before = psql(`SELECT id || '|' || attempts || '|' || coalesce(admitted_by, '') FROM dsh_thread_queue WHERE session_id = '${sessionId}' ORDER BY id DESC LIMIT 1`);
const userMsgsBefore = Number(psql(`SELECT count(*) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'user/message'`));

// 模拟 Host 回收 + 别的 pod 接管：线程改归 ghost
psql(`UPDATE dsh_threads SET running_pod = 'ghost-pod', heartbeat_at = now() WHERE session_id = '${sessionId}'`);
const t1 = Date.now();
let ended = ''; let elapsed = 0;
for (; Date.now() - t1 < 40_000; await sleep(1000)) {
  ended = psql(`SELECT coalesce(data->'reason'->>'kind', '') FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'turn/end' ORDER BY seq DESC LIMIT 1`);
  if (ended !== '') { elapsed = Math.round((Date.now() - t1) / 1000); break; }
}
// dsh 对 cancel 的落日志 reason 视时机而定：模型流式中 = interrupted，工具执行中 = aborted，两者都算取消成功
check('① 原 pod 取消了本地轮次（turn/end interrupted|aborted）', ended === 'interrupted' || ended === 'aborted', `reason=${ended || '未结束'} · ${elapsed}s`);
const logHit = sh(`kubectl -n opendb-dsh logs pod/${pod} --since=3m 2>/dev/null | grep -c "ownership lost" || true`);
check('① 日志出现 ownership lost', Number(logHit) >= 1, `${logHit} 行`);
await sleep(4000);
const thread = psql(`SELECT status || '|' || coalesce(running_pod, '') FROM dsh_threads WHERE session_id = '${sessionId}'`);
check('② 线程行没被原 pod 改回', /\|ghost-pod$/.test(thread), thread);
const after = psql(`SELECT id || '|' || attempts || '|' || coalesce(admitted_by, '') FROM dsh_thread_queue WHERE session_id = '${sessionId}' ORDER BY id DESC LIMIT 1`);
check('③ 队列行没被原 pod 重投（attempts/admitted 不变）', after === before, `${before} → ${after}`);
const userMsgsAfter = Number(psql(`SELECT count(*) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'user/message'`));
check('④ 没有出现第三遍 user/message', userMsgsAfter === userMsgsBefore, `${userMsgsBefore} → ${userMsgsAfter}`);
const ok = checks.every(Boolean);
console.log(ok ? 'PASS' : 'FAIL', `${checks.filter(Boolean).length}/${checks.length}`, sessionId);
process.exit(ok ? 0 : 1);
