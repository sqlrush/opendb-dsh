// db_query「关系不存在 → 同名表所在 schema」提示的验收（2026-08-28 dbe_perf.snapshot 事故）：
//   让模型原样执行 SELECT * FROM dbe_perf.snapshot …，期望：① 工具返回里带「应写 snapshot.snapshot」；② 模型下一次改用 snapshot.snapshot 并成功。
//   OPENDB_HOST_PORT=18080 node scripts/e2e-db-query-schema-hint.mjs   （在 mac 上跑，需要 kubectl 读 PG 取证）
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

const BAD_SQL = 'SELECT * FROM dbe_perf.snapshot ORDER BY snapshot_id DESC LIMIT 5';
const PROMPT = `请用 db_query 在 og5 上原样执行这条 SQL（一个字都不要改）：${BAD_SQL}\n如果报错，按工具返回里的提示改写后再执行一次，然后把两次工具返回的原文各贴一段给我。不要向我提问。`;

const workspaceId = psql("SELECT global->'workspaceIds'->>0 FROM dsh_kv_units WHERE unit = 'workspace'");
const created = await rpc('session.create', workspaceId ? { workspaceId } : {});
if (!created.result?.ok) { console.log('FAIL session.create', JSON.stringify(created).slice(0, 200)); process.exit(1); }
const sessionId = created.result.value.sessionId;
console.log('session', sessionId, 'workspace', workspaceId);
const cleanup = () => { try {
  for (const t of ['dsh_questions', 'dsh_thread_queue', 'dsh_threads', 'dsh_session_events']) psql(`DELETE FROM ${t} WHERE session_id = '${sessionId}'`);
  psql(`DELETE FROM dsh_sessions WHERE id = '${sessionId}'`); console.log('测试会话已删除');
} catch (e) { console.log('清理失败:', String(e.message).slice(0, 100)); } };
process.on('exit', () => { if (!process.env.KEEP_SESSION) cleanup(); });
await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: PROMPT }] });
const t0 = Date.now();
while (Date.now() - t0 < 240_000) {
  await sleep(4000);
  const ended = psql(`SELECT count(*) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'turn/end'`);
  if (Number(ended) >= 1) break;
}
const results = psql(`SELECT string_agg(left(regexp_replace(data::text, chr(10), ' ', 'g'), 900), chr(10) || '=====' || chr(10) ORDER BY seq) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'tool/result'`);
const calls = psql(`SELECT string_agg(coalesce(data->>'arguments',''), chr(10) ORDER BY seq) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'tool/call' AND data->>'name' = 'db_query'`);
const hinted = /应写 snapshot\.snapshot/.test(results);
const corrected = /FROM snapshot\.snapshot/i.test(calls);
const secondOk = /snapshot_id/.test(results) && /\d+ rows/.test(results);
console.log('db_query 调用:', calls.split('\n').filter(Boolean).length, '次');
console.log('断言 · 报错返回指出同名表在 schema snapshot（应写 snapshot.snapshot）:', hinted);
console.log('断言 · 模型改用 snapshot.snapshot 重发:', corrected);
console.log('断言 · 第二次成功（返回行含 snapshot_id）:', secondOk);
console.log('工具返回摘录:', results.slice(0, 700).replace(/\s+/g, ' '));
const ok = hinted && corrected && secondOk;
console.log(ok ? 'PASS' : 'FAIL', sessionId);
process.exit(ok ? 0 : 1);
