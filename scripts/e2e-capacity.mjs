// 容量与增长报告 R1 验收：对 og5 跑一次 capacity 任务 →
//   ① 采集存档 scope=capacity：CAP_* 十条齐全、og5 实况命中 CAP_STMT_HISTORY_BLOAT / CAP_STATS_NEVER（warn）与非表占用 ≥30%；
//   ② 历史：首采从健康存档回填（样本 ≥ 10、含 08-29→08-31 空窗）、字典删除批次事件（08-31 三 schema 删除）；采样表落了 ≥ 50 行；
//   ③ 报告只装解读且 det/规则码 ⊆ 存档；④ 面板关键区块 + console 零错误 + 截图。
//   TASK_ID=task-xxx TASK_NAME=og5-capacity OPENDB_HOST_PORT=18080 node scripts/e2e-capacity.mjs   （mac 上跑；没有 TASK_ID 时自动建任务）
import { execSync } from 'node:child_process';
const PORT = process.env.OPENDB_HOST_PORT ?? '18080';
const BASE = `http://127.0.0.1:${PORT}`;
const TASK_NAME = process.env.TASK_NAME ?? 'og5-capacity';
const OUT = process.env.OUT ?? '/tmp/capacity-e2e.png';
const envelope = (method, payload) => ({ type: 'client-request', rpcId: `q-${Math.random().toString(36).slice(2)}`, method, payload });
const opendb = async (method, payload) => (await (await fetch(`${BASE}/opendb/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify(envelope(method, payload)) })).json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/tmp/kbin` } }).trim();
const psql = (sql) => sh(`kubectl -n opendb-dsh exec pod/opendb-dsh-postgres-0 -- psql -U dsh -d dsh -Atc "${sql.replace(/"/g, '\\"')}"`);
const checks = [];
const check = (name, ok, extra = '') => { checks.push(ok); console.log(`${ok ? '✔' : '✖'} ${name}${extra ? ` — ${extra}` : ''}`); return ok; };
const GB = (b) => `${(Number(b) / 1024 ** 3).toFixed(1)} GB`;

let taskId = process.env.TASK_ID ?? '';
if (taskId === '') {
  const list = await opendb('tasks/list', {});
  const existing = (list.result?.value?.tasks ?? []).find((t) => t.type === 'capacity' && t.name === TASK_NAME);
  if (existing) taskId = existing.id;
  else {
    const agent = (list.result?.value?.tasks ?? [])[0]?.agentId;
    const created = await opendb('tasks/create', { type: 'capacity', name: TASK_NAME, agentId: agent, cron: '0 2 * * *', config: { node: 'og5', topN: 20, growthWindowDays: 7, focus: '' } });
    taskId = created.result?.value?.task?.id ?? '';
    if (taskId === '') { console.log('FAIL tasks/create', JSON.stringify(created).slice(0, 300)); process.exit(1); }
    console.log('created task', taskId);
  }
}
const before = Number(psql("SELECT count(*) FROM opendb_capacity_samples WHERE node = 'og5'") || 0);
const fired = await opendb('tasks/runNow', { id: taskId });
const run = fired.result?.value?.run;
if (run === undefined) { console.log('FAIL runNow', JSON.stringify(fired).slice(0, 300)); process.exit(1); }
console.log('run', run.id);
const t0 = Date.now(); let cur;
for (; Date.now() - t0 < 12 * 60_000; await sleep(10_000)) {
  const list = await opendb('runs/list', { taskId });
  cur = (list.result?.value?.runs ?? []).find((r) => r.id === run.id);
  if (cur !== undefined && (cur.report !== undefined || ['succeeded', 'failed', 'timeout'].includes(String(cur.status)))) break;
}
check('运行结束并提交报告', cur !== undefined && cur.report !== undefined, `${Math.round((Date.now() - t0) / 1000)}s · status=${cur?.status} · ${String(cur?.error ?? '').slice(0, 120)}`);
const c = cur?.collect;
check('存档是容量报告（scope=capacity）', c?.scope === 'capacity' && Number(c?.version) === 1, c ? `id=${c.id} · 库 ${GB(c.summary?.dbBytes)} · 数据目录≈${GB(c.summary?.dataDirBytes)} · worst=${c.det?.worst}` : '');
if (c) {
  const rules = new Map((c.findings ?? []).map((f) => [f.rule, f.level]));
  check('CAP_* 十条判定齐全', ['CAP_DISK_FREE', 'CAP_GROWTH', 'CAP_NONTABLE_SHARE', 'CAP_STMT_HISTORY_BLOAT', 'CAP_STATS_NEVER', 'CAP_DEAD_TUPLES', 'CAP_WAL_SIZE', 'CAP_WDR_RETENTION', 'CAP_LOG_RETENTION', 'CAP_COLLECT_GAP'].every((r) => rules.has(r)), [...rules.entries()].map(([k, v]) => `${k}:${v}`).join(' '));
  check('og5 实况：statement_history 膨胀 warn', rules.get('CAP_STMT_HISTORY_BLOAT') === 'warn', String((c.findings ?? []).find((f) => f.rule === 'CAP_STMT_HISTORY_BLOAT')?.problem ?? '').slice(0, 120));
  check('og5 实况：gsbench 大表从未 analyze warn', rules.get('CAP_STATS_NEVER') === 'warn', `${c.statsNever?.count} 张 · ${JSON.stringify(c.statsNever?.bySchema ?? {})}`);
  check('非表占用 ≥ 30%（WAL + statement_history + WDR + 日志）', Number(c.summary?.nonTableShare) >= 0.3, `${Math.round(Number(c.summary?.nonTableShare) * 100)}% · ${GB(c.summary?.nonTableBytes)}`);
  const pts = c.history?.points ?? [];
  check('历史样本 ≥ 10（首采从健康存档回填或已有采样）', pts.length >= 10, `${pts.length} 点 · source=${c.history?.source} · 增速 ${(Number(c.summary?.growth?.bytesPerDay) / 1024 ** 3).toFixed(3)} GB/天 · 观测 ${c.summary?.growth?.windowHours} h`);
  check('识别到 08-29 → 08-31 采集空窗', (c.history?.gaps ?? []).length >= 1, (c.history?.gaps ?? []).map((g) => `${new Date(g.from).toISOString().slice(5, 16)}→${new Date(g.to).toISOString().slice(5, 16)}`).join(' '));
  check('字典删除批次进入趋势事件', (c.history?.events ?? []).some((e) => e.kind === 'removed' && Number(e.count) >= 5), (c.history?.events ?? []).map((e) => e.label).join(' | ').slice(0, 160));
  check('构成：表空间 ≥ 2 条，库内 statement_history 单列', (c.composition?.dir ?? []).length >= 2 && (c.composition?.db ?? []).some((d) => d.name === 'statement_history'), `dir ${(c.composition?.dir ?? []).map((d) => d.name).join('/')} · db ${(c.composition?.db ?? []).slice(0, 5).map((d) => d.name).join('/')}`);
  check('Top 表含 gsbench.fact_sales 且 lastAnalyze 为空', (c.topTables ?? []).some((t) => t.sch === 'gsbench' && t.name === 'fact_sales' && (t.lastAnalyze === undefined || t.lastAnalyze === null)), `${(c.topTables ?? []).length} 张`);
  const notes = (c.collectionNotes ?? []).join(' ');
  check('文件级：可读，或如实降级（openGauss 只允许初始账号 pg_ls_dir）且 WAL 给出参数上限估算', (c.sys?.wal?.available === true && c.sys?.log?.available === true) || (/初始账号/.test(notes) && c.summary?.dataDirSource === 'db-only' && Number(c.sys?.wal?.capBytes) > 0), c.sys?.wal?.available ? `WAL ${c.sys?.wal?.segments} 段 · pg_log ${c.sys?.log?.files} 文件 ${GB(c.sys?.log?.bytes)}` : `降级 · WAL 上限 ≤ ${GB(c.sys?.wal?.capBytes)} · source=${c.summary?.dataDirSource}`);
  // 增速按语义断言（窗口长度会随采样推进变化，不能钉死小时数）：
  //   post-reset = 悬崖后样本够了，用清理后的段（窗口 ≥1 h）；pre-reset = 悬崖刚发生，暂用清理前的段（窗口 ≥24 h）且必为 low；
  //   窗口不足 24 h 一律 low——不许拿几小时的观测报"高置信度"。
  const g = c.summary?.growth ?? {};
  const segOk = g.segment === 'post-reset' ? Number(g.windowHours) >= 1 && Number(g.points) >= 2
    : g.segment === 'pre-reset' ? Number(g.windowHours) >= 24 && g.confidence === 'low'
      : Number(g.points) >= 2;
  check('增速：分段语义正确（post-reset 用清理后段 / pre-reset 退回清理前段）', segOk, `segment=${g.segment} · ${g.windowHours} h · ${g.points} 点 · 置信度 ${g.confidence} · ${(Number(g.bytesPerDay) / 1024 ** 3).toFixed(3)} GB/天`);
  check('增速置信度诚实（窗口 < 24 h 必为 low）', Number(g.windowHours) >= 24 || g.confidence === 'low', `${g.windowHours} h → ${g.confidence}`);
  const ser = c.history?.series ?? {};
  check('趋势三序列齐备（db 有点、dir 有点、disk 无主机侧数据但带说明）', (ser.db?.points ?? []).length >= 2 && (ser.dir?.points ?? []).length >= 1 && ser.disk !== undefined && String(ser.disk?.note ?? '') !== '', `db ${(ser.db?.points ?? []).length} · dir ${(ser.dir?.points ?? []).length} · disk ${(ser.disk?.points ?? []).length}（${String(ser.disk?.note ?? '').slice(0, 40)}…）`);
  const after = Number(psql("SELECT count(*) FROM opendb_capacity_samples WHERE node = 'og5'") || 0);
  check('采样表新增 ≥ 50 行', after - before >= 50, `${before} → ${after}`);
  if (before > 0) check('第二次起：Top 表带上次采样的增量', (c.topTables ?? []).some((t) => t.delta !== undefined) && c.summary?.firstRun === false, `${(c.topTables ?? []).filter((t) => t.delta !== undefined).length} 张有增量 · 窗口 ${c.summary?.delta24?.hours} h`);
}
const d = cur?.report?.data;
if (d && c) {
  check('report.det.worst 与存档一致', String(d.det?.worst) === String(c.det?.worst), `${d.det?.worst} vs ${c.det?.worst}`);
  const rs = new Set((c.findings ?? []).map((f) => f.rule));
  check('report.findings[].rule ⊆ 存档规则码', (d.findings ?? []).length > 0 && (d.findings ?? []).every((f) => rs.has(String(f.rule))), `${(d.findings ?? []).length} 条`);
  check('report 有 situation / rootCause / priorities', String(d.situation ?? '') !== '' && String(d.rootCause ?? '') !== '' && (d.priorities ?? []).length > 0, String(d.situation ?? '').slice(0, 160));
}
try {
  const out = execSync(`TASK="${TASK_NAME}" OUT=${OUT} EXPECT="增长趋势,容量构成,Top 对象,非表占用与保留策略,Vacuum 与统计信息健康,发现,检查历史,CAP_STMT_HISTORY_BLOAT" node scripts/browser/task-shot.mjs`, { encoding: 'utf8', env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin` } });
  check('面板关键区块齐全', /EXPECT_OK/.test(out), out.split('\n').filter((l) => /EXPECT|errors/.test(l)).join(' · '));
  check('console 零错误', /errors 无/.test(out));
  console.log('截图', OUT);
} catch (e) { check('面板渲染', false, String(e.message).slice(0, 200)); }
const ok = checks.every(Boolean);
console.log(ok ? 'PASS' : 'FAIL', `${checks.filter(Boolean).length}/${checks.length}`);
process.exit(ok ? 0 : 1);
