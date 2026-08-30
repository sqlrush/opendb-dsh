// 字典门 · 系统列与类型/函数（2026-08-30 user："第 2 个之前在其他任务报告里也遇到过"）：
//   ① 目录连接 `JOIN pg_namespace n ON n.oid = c.relnamespace` 必须原样执行成功（不再因系统列 oid 被误拦）；
//   ② `'ddl_lab'::regnamespace` 必须在执行前被拦下，字典单里给出 openGauss 等价写法（JOIN pg_namespace），模型据此一次改对。
//   OPENDB_HOST_PORT=18080 node scripts/e2e-db-gate-types.mjs   （在 mac 上跑，需要 kubectl 读 PG 取证）
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
const sh = (cmd) => { let last; for (let i = 0; i < 4; i++) { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin` } }).trim(); } catch (e) { last = e; execSync('sleep 6'); } } throw last; };
const psql = (sql) => sh(`kubectl -n opendb-dsh exec pod/opendb-dsh-postgres-0 -- psql -U dsh -d dsh -Atc "${sql.replace(/"/g, '\\"')}"`);
const checks = [];
const check = (name, ok, extra = '') => { checks.push(ok); console.log(`${ok ? '✔' : '✖'} ${name}${extra ? ` — ${extra}` : ''}`); return ok; };

const SQL_A = "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ddl_lab' AND c.relkind = 'r' ORDER BY 1";
const SQL_B = "SELECT relname FROM pg_class WHERE relnamespace = 'ddl_lab'::regnamespace ORDER BY 1";
const PROMPT = `请在 og5 上按顺序用 db_query 原样执行两条 SQL（一个字都不要改）：\n第一条：${SQL_A}\n第二条：${SQL_B}\n第二条如果工具返回字典校验信息，按它给的等价写法改写后再执行一次。最后把每次工具返回的原文各贴一段给我。不要向我提问。`;

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
const t0 = Date.now();
while (Date.now() - t0 < 300_000) {
  await sleep(4000);
  const ended = psql(`SELECT count(*) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'turn/end'`);
  if (Number(ended) >= 1) break;
}
const results = psql(`SELECT string_agg(left(regexp_replace(data::text, chr(10), ' ', 'g'), 1400), chr(10) || '=====' || chr(10) ORDER BY seq) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'tool/result'`);
const parts = results.split('\n=====\n');
console.log('--- tool results (truncated) ---\n' + results.slice(0, 3000));
const first = parts[0] ?? '';
check('第一条（n.oid 目录连接）原样执行成功，未被字典门拦', /rows/.test(first) && !/字典校验未通过/.test(first) && !/does not exist/.test(first), first.slice(0, 160));
check('第一条返回了 ddl_lab 的表', /orders|customers|products|shipments/.test(first));
check('第二条（::regnamespace）在执行前被拦下', parts.some((p) => /字典校验未通过/.test(p) && /regnamespace/.test(p)));
check('字典单给出等价写法（JOIN pg_namespace）', parts.some((p) => /改为 JOIN pg_namespace n ON n\.oid = c\.relnamespace/.test(p)));
check('全程没有数据库原生的 type "regnamespace" does not exist', !/type "regnamespace" does not exist/.test(results));
const lastOk = parts.slice(1).some((p) => /\d+ rows/.test(p) && /"isError": false/.test(p));
check('相近类型候选只含 pg_catalog 类型且不重复', !/regions/.test(results));
check('模型据等价写法改写后成功返回结果', lastOk);
const ok = checks.every(Boolean);
console.log(ok ? 'PASS' : 'FAIL', `${checks.filter(Boolean).length}/${checks.length}`);
process.exit(ok ? 0 : 1);
