// db_query 字典门验收（2026-08-29 user：让模型先确认字典再写 SQL）：
//   让模型原样执行一条引用了 pg_stat_activity.wait_event 的 SQL（openGauss 没有这一列），期望：
//   ① 第一次 db_query 返回「字典校验未通过，SQL 未执行」，并列出 pg_stat_activity 的真实列与 pg_thread_wait_status 等含 wait_event 的关系；
//   ② 模型据此改写，下一次 db_query 成功（返回 rows）；③ 全程没有出现数据库原生的 column does not exist。
//   OPENDB_HOST_PORT=18080 node scripts/e2e-db-dictionary-gate.mjs   （在 mac 上跑，需要 kubectl 读 PG 取证）
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

const BAD_SQL = "SELECT pid, state, wait_event, left(query, 60) FROM pg_stat_activity WHERE state <> 'idle' LIMIT 5";
const PROMPT = `请用 db_query 在 og5 上原样执行这条 SQL（一个字都不要改）：${BAD_SQL}\n如果工具返回字典校验信息，按它改写后再执行一次（要查"当前会话的等待事件"就用它指出的视图），然后把两次工具返回的原文各贴一段给我。不要向我提问。`;

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
while (Date.now() - t0 < 240_000) {
  await sleep(4000);
  const ended = psql(`SELECT count(*) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'turn/end'`);
  if (Number(ended) >= 1) break;
}
const results = psql(`SELECT string_agg(left(regexp_replace(data::text, chr(10), ' ', 'g'), 1500), chr(10) || '=====' || chr(10) ORDER BY seq) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'tool/result'`);
const calls = psql(`SELECT string_agg(coalesce(data->'input'->>'sql', data->>'name'), chr(10) ORDER BY seq) FROM dsh_session_events WHERE session_id = '${sessionId}' AND type = 'tool/call' AND data->>'name' IN ('db_query','db_describe','db_find_columns')`);
console.log('--- tool calls ---\n' + calls.slice(0, 800) + '\n--- tool results (truncated) ---\n' + results.slice(0, 2500));
check('第一次 db_query 被字典门拦下（未执行）', /字典校验未通过，SQL 未执行/.test(results));
check('字典单列出 pg_stat_activity 的真实列并指出 waiting', /pg_stat_activity 没有列 wait_event/.test(results) && /最接近的是 waiting/.test(results));
check('字典单反查到含 wait_event 的关系（pg_thread_wait_status）', /pg_thread_wait_status/.test(results));
check('全程没有数据库原生的 column does not exist', !/does not exist/.test(results));
const okAfter = /rows\b/.test(results) && /-- og5 \(/.test(results);
check('模型据字典改写后 db_query 成功返回结果', okAfter);
const ok = checks.every(Boolean);
console.log(ok ? 'PASS' : 'FAIL', `${checks.filter(Boolean).length}/${checks.length}`);
process.exit(ok ? 0 : 1);
