// db_query 语句超时改造的验收（2026-08-28 user：15s 撞上 3,355 万行整表聚合 → 默认 60s + timeout_ms + 说明性报错）：
//   ① 模型原样执行 SELECT count(*) … FROM fact_sales（约 27s）：60s 默认线下成功；
//   ② 再让它对同一条传 timeout_ms=2000：工具返回必须是「平台语句超时（2s）…pg_class.reltuples…timeout_ms」的说明，而不是裸的 canceling statement。
//   OPENDB_HOST_PORT=18080 node scripts/e2e-db-query-timeout.mjs   （mac 上跑）
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

const SQL = 'SELECT min(sale_date) AS mn, max(sale_date) AS mx, count(*) AS cnt FROM gsbench_e2e_20260801_100g.fact_sales';
const PROMPT = `这是平台验收，请严格照做、不要向我提问、不要改写 SQL：\n① 用 db_query 在 og5 上原样执行：${SQL}\n② 再用 db_query 原样执行同一条，但参数 timeout_ms 传 2000。\n然后把两次工具返回的原文各贴一段给我。`;

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
await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: PROMPT }] });
for (let t0 = Date.now(); Date.now() - t0 < 300_000; await sleep(5000)) {
  const ended = psql(`SELECT count(*) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'turn/end'`);
  if (Number(ended) >= 1) break;
}
const calls = psql(`SELECT string_agg(coalesce(data->>'arguments',''), chr(10) ORDER BY seq) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'tool/call' AND data->>'name' = 'db_query'`);
const results = psql(`SELECT string_agg(left(regexp_replace(data::text, chr(10), ' ', 'g'), 700), chr(10) || '=====' || chr(10) ORDER BY seq) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'tool/result'`);
const blocks = results.split('\n=====\n');
const okBlock = blocks.find((b) => /\bcnt\b/.test(b) && /\d+ rows/.test(b) && !/"isError": true/.test(b));   // 别用 /Error/：JSON 里有 "isError": false
const toBlock = blocks.find((b) => /平台语句超时（2s）/.test(b));
console.log('db_query 调用:', calls.split('\n').filter(Boolean).length, '次');
blocks.forEach((b, i) => console.log(`  结果 ${i + 1}:`, b.replace(/\s+/g, ' ').replace(/^.*"content": \[\{"text": "/, '').slice(0, 260)));
console.log('断言 · 60s 默认线下整表聚合成功（返回 mn/mx/cnt）:', okBlock !== undefined, okBlock ? okBlock.replace(/\s+/g, ' ').slice(0, 220) : '');
console.log('断言 · timeout_ms=2000 时返回说明性超时提示（含 reltuples/TABLESAMPLE/timeout_ms 上限）:', toBlock !== undefined && /reltuples/.test(toBlock) && /TABLESAMPLE/.test(toBlock) && /上限 120000/.test(toBlock), toBlock ? toBlock.replace(/\s+/g, ' ').slice(0, 260) : '');
const ok = okBlock !== undefined && toBlock !== undefined && /reltuples/.test(toBlock);
console.log(ok ? 'PASS' : 'FAIL', sessionId);
process.exit(ok ? 0 : 1);
