// 数据库权限改由数据库控制（2026-08-27）的验收：
//   ① 原本 permission denied 的 WLM 实时视图（global_statement_complex_runtime）经 db_query 可读（og5 opendb_ro 已 SYSADMIN）；
//   ② 平台不再过滤语句：CREATE TABLE 原样送到数据库，由 og5 角色级 default_transaction_read_only 以 25006 拒绝，
//      工具返回里不再出现「只读门」字样。
//   OPENDB_HOST_PORT=18080 node scripts/e2e-db-perms.mjs   （在 mac 上跑，需要 kubectl 读 PG 取证）
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

const SQL_READ = 'SELECT count(*) AS running_complex FROM dbe_perf.global_statement_complex_runtime';
const SQL_WRITE = 'CREATE TABLE opendb_perm_probe_e2e(x int)';
const PROMPT = `这是平台权限验收，请严格照做、不要向我提问、不要改写 SQL：用 db_query 在 og5 上依次原样执行下面两条 SQL，各执行一次，然后把两次工具返回的原文各贴一段给我（成功贴结果，失败贴错误原文）。\n① ${SQL_READ}\n② ${SQL_WRITE}`;

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
const calls = psql(`SELECT string_agg(coalesce(data->>'arguments',''), chr(10) ORDER BY seq) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'tool/call' AND data->>'name' = 'db_query'`);
const results = psql(`SELECT string_agg(left(regexp_replace(data::text, chr(10), ' ', 'g'), 700), chr(10) || '=====' || chr(10) ORDER BY seq) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'tool/result'`);
const readCalled = /global_statement_complex_runtime/.test(calls);
const writeCalled = /CREATE TABLE opendb_perm_probe_e2e/i.test(calls);
const blocks = results.split('\n=====\n');
const readBlock = blocks.find((b) => /running_complex/.test(b)) ?? '';
const writeBlock = blocks.find((b) => /opendb_perm_probe_e2e|read-only|只读事务/i.test(b) && !/running_complex/.test(b)) ?? '';
const readOk = readCalled && readBlock !== '' && !/permission denied/i.test(readBlock);
const writeRejectedByDb = writeCalled && /read-only transaction|只读事务|25006/i.test(writeBlock);
const noPluginGate = !/只读门/.test(results);
const leftover = (() => { try { return sh(`docker exec og5 su - omm -c "gsql -d postgres -Atc \\"SELECT count(*) FROM pg_class WHERE relname='opendb_perm_probe_e2e'\\""`); } catch { return 'n/a'; } })();
console.log('db_query 调用:', calls.split('\n').filter(Boolean).length, '次');
console.log('断言 · WLM 实时视图可读（不再 permission denied）:', readOk);
console.log('断言 · CREATE TABLE 送达数据库并被只读事务拒绝:', writeRejectedByDb);
console.log('断言 · 工具返回不含「只读门」:', noPluginGate);
console.log('og5 上残留表数:', leftover);
console.log('工具返回摘录:', results.slice(0, 900).replace(/\s+/g, ' '));
const ok = readOk && writeRejectedByDb && noPluginGate && leftover === '0';
console.log(ok ? 'PASS' : 'FAIL', sessionId);
process.exit(ok ? 0 : 1);
