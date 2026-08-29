// 模型路由冒烟（2026-08-29 切 Kimi K3）：新会话一句话 → 模型必须调工具（db_nodes）并给出回答，turn/end 是 completed 且没有 llm 错误。
//   OPENDB_HOST_PORT=18080 node scripts/e2e-model-smoke.mjs   （mac 上跑，需要 kubectl 读 PG 取证）
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
const sh = (cmd) => { let last; for (let i = 0; i < 4; i++) { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin` } }).trim(); } catch (e) { last = e; execSync('sleep 6'); } } throw last; };
const psql = (sql) => sh(`kubectl -n opendb-dsh exec pod/opendb-dsh-postgres-0 -- psql -U dsh -d dsh -Atc "${sql.replace(/"/g, '\\"')}"`);

const PROMPT = '请用 db_nodes 工具列出当前绑定的数据库节点，然后用一句话告诉我节点名和引擎。不要向我提问。';
const workspaceId = psql("SELECT global->'workspaceIds'->>0 FROM dsh_kv_units WHERE unit = 'workspace'");
const created = await rpc('session.create', workspaceId ? { workspaceId } : {});
if (!created.result?.ok) { console.log('FAIL session.create', JSON.stringify(created).slice(0, 200)); process.exit(1); }
const sessionId = created.result.value.sessionId;
console.log('session', sessionId);
const cleanup = () => { try {
  for (const t of ['dsh_questions', 'dsh_thread_queue', 'dsh_threads', 'dsh_session_events']) psql(`DELETE FROM ${t} WHERE session_id = '${sessionId}'`);
  psql(`DELETE FROM dsh_sessions WHERE id = '${sessionId}'`); console.log('测试会话已删除');
} catch (e) { console.log('清理失败:', String(e.message).slice(0, 100)); } };
process.on('exit', () => { if (!process.env.KEEP_SESSION) cleanup(); });
const t0 = Date.now();
await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: PROMPT }] });
for (; Date.now() - t0 < 180_000; await sleep(3000)) {
  const ended = psql(`SELECT count(*) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'turn/end'`);
  if (Number(ended) >= 1) break;
}
const secs = Math.round((Date.now() - t0) / 1000);
const reason = psql(`SELECT coalesce(data->'reason'->>'kind','') || ' ' || coalesce(data->'reason'->'error'->>'code','') || ' ' || coalesce(data->'reason'->'error'->>'message','') FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'turn/end' ORDER BY seq DESC LIMIT 1`);
const tools = psql(`SELECT string_agg(data->>'name', ',' ORDER BY seq) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'tool/call'`);
// assistant/message 的结构：data.message.{content[], source:{provider, model}}（2026-08-29 实测）
const model = psql(`SELECT string_agg(DISTINCT coalesce(data->'message'->'source'->>'provider', '') || '/' || coalesce(data->'message'->'source'->>'model', ''), ',') FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'assistant/message'`);
const answer = psql(`SELECT left(regexp_replace(coalesce((SELECT string_agg(c->>'text', ' ') FROM jsonb_array_elements(data->'message'->'content') c WHERE c->>'type' = 'text'), ''), '\\s+', ' ', 'g'), 200) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'assistant/message' ORDER BY seq DESC LIMIT 1`);
const okEnd = /^completed/.test(reason);
const okTool = /db_nodes/.test(tools);
console.log(okEnd ? '✔' : '✖', `turn 正常结束（${secs}s）`, reason.trim());
console.log(okTool ? '✔' : '✖', '模型调用了 db_nodes 工具', tools || '(无工具调用)');
console.log(answer ? '✔' : '✖', '有回答', answer || '(空)');
console.log('模型:', model || '(日志未记录)');
const ok = okEnd && okTool && answer !== '';
console.log(ok ? 'PASS' : 'FAIL', sessionId);
process.exit(ok ? 0 : 1);
