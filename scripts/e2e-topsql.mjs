// Top SQL 报表（R5）验收：会话里一句话建任务 → 配置带维度 → 采集存档 → 报告 → 面板渲染。
//   ① 会话说「按执行次数和总耗时分别 Top5」→ 模型建 sqlreview 任务且 config.dimensions ⊇ {calls, elapsed}（不是 prompt 任务）；
//   ② 立即运行一次后：opendb_task_collects 有该会话的存档，boards 覆盖两个维度、items 去重、insights 非空；
//   ③ 报告 data.sqlItems 的 key 全部来自采集；
//   ④ 无头 Chrome 打开任务页：出现「Top SQL 资源占比」「按执行次数 Top」「按总耗时 Top」「在新会话中深挖」，console 零错误。
//   OPENDB_HOST_PORT=18080 node scripts/e2e-topsql.mjs   （在 mac 上跑；KEEP=1 保留任务与会话）
import { execSync } from 'node:child_process';
const PORT = process.env.OPENDB_HOST_PORT ?? '18080';
const BASE = `http://127.0.0.1:${PORT}`;
const TASK_NAME = 'e2e Top SQL 双榜';
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
const checks = [];
const check = (name, ok, extra = '') => { checks.push(ok); console.log(`${ok ? '✔' : '✖'} ${name}${extra ? ` — ${extra}` : ''}`); return ok; };

const PROMPT = `给 og5 建一个 Top SQL 报表任务，名字叫「${TASK_NAME}」：按执行次数和总耗时分别列出 Top 5 进行分析，不设定时（仅手动触发），建好后立即运行一次。不要向我提问，直接建。`;

const workspaceId = psql("SELECT global->'workspaceIds'->>0 FROM dsh_kv_units WHERE unit = 'workspace'");
const created = await rpc('session.create', workspaceId ? { workspaceId } : {});
if (!created.result?.ok) { console.log('FAIL session.create', JSON.stringify(created).slice(0, 200)); process.exit(1); }
const sessionId = created.result.value.sessionId;
console.log('session', sessionId);
let taskId = '';
const cleanup = () => {
  if (process.env.KEEP) return;
  try {
    if (taskId !== '') {
      for (const t of ['dsh_task_reports', 'dsh_task_runs']) psql(`DELETE FROM ${t} WHERE task_id = '${taskId}'`);
      psql(`DELETE FROM opendb_archived_tasks WHERE task_id = '${taskId}'`);
      psql(`DELETE FROM dsh_tasks WHERE id = '${taskId}'`);
      console.log('测试任务已删除', taskId);
    }
    for (const t of ['dsh_questions', 'dsh_thread_queue', 'dsh_threads', 'dsh_session_events']) psql(`DELETE FROM ${t} WHERE session_id = '${sessionId}'`);
    psql(`DELETE FROM dsh_sessions WHERE id = '${sessionId}'`);
    console.log('测试会话已删除');
  } catch (e) { console.log('清理失败:', String(e.message).slice(0, 120)); }
};
process.on('exit', cleanup);

await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: PROMPT }] });

// ① 任务建立
let task;
for (let t0 = Date.now(); Date.now() - t0 < 240_000; await sleep(5000)) {
  const row = psql(`SELECT row_to_json(t)::text FROM dsh_tasks t WHERE name = '${TASK_NAME}' ORDER BY created_at DESC LIMIT 1`);
  if (row) { task = JSON.parse(row); break; }
}
if (!task) { console.log('FAIL 240s 内没建出任务'); process.exit(1); }
taskId = task.id;
const dims = Array.isArray(task.config?.dimensions) ? task.config.dimensions : [];
check('① 类型是 sqlreview（不是 prompt 定时对话）', task.type === 'sqlreview', `type=${task.type}`);
check('① config.dimensions 含 calls 与 elapsed', dims.includes('calls') && dims.includes('elapsed'), JSON.stringify(task.config));
check('① topN = 5，无 cron', Number(task.config?.topN) === 5 && (task.cron === null || task.cron === ''), `cron=${task.cron}`);

// ② 运行 + 采集存档 + 报告
let run; let report;
for (let t0 = Date.now(); Date.now() - t0 < 600_000; await sleep(8000)) {
  const r = psql(`SELECT row_to_json(r)::text FROM dsh_task_runs r WHERE task_id = '${taskId}' ORDER BY fired_at DESC LIMIT 1`);
  if (r) run = JSON.parse(r);
  const rep = run ? psql(`SELECT row_to_json(x)::text FROM dsh_task_reports x WHERE run_id = '${run.id}' LIMIT 1`) : '';
  if (rep) { report = JSON.parse(rep); break; }
  if (run && /failed|timeout/.test(String(run.status))) break;
}
check('② 任务运行产生了报告', report !== undefined, `run=${run?.status ?? '无'} ${run?.error ?? ''}`);
const collectRaw = run?.session_id ? psql(`SELECT payload::text FROM opendb_task_collects WHERE task_type = 'sqlreview' AND session_id = '${run.session_id}' ORDER BY collected_at DESC LIMIT 1`) : '';
const collect = collectRaw ? JSON.parse(collectRaw) : undefined;
check('② 采集已存档 opendb_task_collects', collect !== undefined);
if (collect) {
  const boardDims = (collect.boards ?? []).map((b) => b.dim);
  check('② boards 覆盖 calls 与 elapsed', boardDims.includes('calls') && boardDims.includes('elapsed'), boardDims.join(','));
  const keys = (collect.items ?? []).map((i) => i.key);
  check('② items 去重（key 唯一）且非空', keys.length > 0 && new Set(keys).size === keys.length, `${keys.length} 条`);
  check('② 每条 item 带占比与榜位', (collect.items ?? []).every((i) => i.shares && i.ranks && Object.keys(i.ranks).length > 0));
  check('② insights 非空', Array.isArray(collect.insights) && collect.insights.length > 0, (collect.insights ?? []).map((i) => i.text).join(' | ').slice(0, 200));
  check('② 规则违规带归因（ruleRefs）', (collect.items ?? []).some((i) => Array.isArray(i.ruleRefs)));
  if (report) {
    const rk = (report.data?.sqlItems ?? []).map((s) => s.key);
    check('③ 报告 sqlItems 的 key 全部来自采集', rk.length > 0 && rk.every((k) => keys.includes(k)), `${rk.length}/${keys.length}`);
    check('③ 报告每条有 verify', (report.data?.sqlItems ?? []).every((s) => typeof s.verify === 'string' && s.verify !== ''));
  }
}

// ④ 面板渲染
try {
  const out = sh(`cd /Users/sqlrush/dsh-k8s && TASK="${TASK_NAME}" OUT=/tmp/e2e-topsql.png EXPECT="Top SQL 资源占比,按执行次数 Top,按总耗时 Top,在新会话中深挖,逐条分析" node scripts/browser/task-shot.mjs 2>&1`);
  console.log(out.split('\n').filter((l) => /clicked|expect|errors|missing/i.test(l)).join('\n'));
  check('④ 面板出现 R5 关键区块', /EXPECT_OK/.test(out), '截图 /tmp/e2e-topsql.png');
  check('④ console/page 零错误', /errors 无/.test(out));
} catch (e) { check('④ 面板截图', false, String(e.message).slice(0, 200)); }

const ok = checks.every(Boolean);
console.log(ok ? 'PASS' : 'FAIL', `${checks.filter(Boolean).length}/${checks.length}`, sessionId, taskId);
process.exit(ok ? 0 : 1);
