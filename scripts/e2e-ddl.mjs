// 表结构变更追溯 R2 验收：对 og5 的 ddl_lab 测试 schema 跑一次 ddl 任务 →
//   ① 采集存档是 R2 结构历史（scope=ddl-trace, version=2）：主干版本 ≥ 4、schema 泳道 ddl_lab 含表级子线、audit_log 子线封口、
//      orders 的定义时间线能还原 numeric(12,2)→(18,2)；② 报告只装解读且引用的版本号 ⊆ 存档；③ 面板关键区块 + console 零错误 + 截图。
//   TASK_ID=task-xxx TASK_NAME=og5-ddl-lab OPENDB_HOST_PORT=18080 node scripts/e2e-ddl.mjs   （mac 上跑；没有 TASK_ID 时自动建任务）
import { execSync } from 'node:child_process';
const PORT = process.env.OPENDB_HOST_PORT ?? '18080';
const BASE = `http://127.0.0.1:${PORT}`;
const TASK_NAME = process.env.TASK_NAME ?? 'og5-ddl-lab';
const OUT = process.env.OUT ?? '/tmp/ddl-r2-e2e.png';
const envelope = (method, payload) => ({ type: 'client-request', rpcId: `q-${Math.random().toString(36).slice(2)}`, method, payload });
const opendb = async (method, payload) => (await (await fetch(`${BASE}/opendb/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify(envelope(method, payload)) })).json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, extra = '') => { checks.push(ok); console.log(`${ok ? '✔' : '✖'} ${name}${extra ? ` — ${extra}` : ''}`); return ok; };

let taskId = process.env.TASK_ID ?? '';
if (taskId === '') {
  const list = await opendb('tasks/list', {});
  const existing = (list.result?.value?.tasks ?? []).find((t) => t.type === 'ddl' && t.name === TASK_NAME);
  if (existing) taskId = existing.id;
  else {
    const agent = (list.result?.value?.tasks ?? [])[0]?.agentId;
    const created = await opendb('tasks/create', { type: 'ddl', name: TASK_NAME, agentId: agent, cron: null, config: { node: 'og5', hours: Number(process.env.HOURS ?? 6), schemas: ['ddl_lab'], focus: '' } });
    taskId = created.result?.value?.task?.id ?? '';
    if (taskId === '') { console.log('FAIL tasks/create', JSON.stringify(created).slice(0, 300)); process.exit(1); }
    console.log('created task', taskId);
  }
}
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
check('存档是 R2 结构历史（scope=ddl-trace, version=2）', c?.scope === 'ddl-trace' && Number(c?.version) === 2, c ? `id=${c.id} · 事件 ${(c.events ?? []).length} · 版本 ${(c.versions ?? []).length}` : '无存档');
if (c) {
  check('主干版本 ≥ 4（v1 建表 … v5 视图）', (c.versions ?? []).length >= 4, (c.versions ?? []).map((v) => `${v.v}:${v.kind}:${v.objs}`).join(' '));
  const lane = (c.lanes ?? []).find((l) => l.id === 'ddl_lab');
  check('ddl_lab 泳道存在且从建立分出，含表级子线', lane !== undefined && lane.born !== null && lane.subs.length >= 4, lane ? `born=${lane.born} · 表 ${lane.tables} · 子线 ${lane.subs.map((s) => s.name).join(',')}` : '');
  const auditLog = lane?.subs.find((s) => s.name === 'audit_log');
  check('audit_log 子线在 v4 封口（died）', auditLog !== undefined && auditLog.died !== null, auditLog ? `died=${auditLog.died}` : '');
  const orders = c.objects?.['table ddl_lab.orders'];
  const defs = (orders?.defs ?? []).map((d) => d.def).filter((d) => typeof d === 'string');
  check('orders 定义时间线还原 amount numeric(12,2) → numeric(18,2)', defs.some((d) => d.includes('amount:numeric(12,2)')) && defs.some((d) => d.includes('amount:numeric(18,2)')), `${defs.length} 个定义点`);
  const shipments = lane?.subs.find((s) => s.name === 'shipments');
  check('中途新建的 shipments 子线从 v3 开始', shipments !== undefined && shipments.born !== null, shipments ? `born=${shipments.born}` : '');
  check('规范扫描命中 DDLR01（DROP TABLE audit_log）', (c.ruleFindings ?? []).some((f) => f.rule === 'DDLR01' && /audit_log/.test(String(f.object))), (c.ruleFindings ?? []).map((f) => `${f.rule}:${f.level}`).join(' '));
  check('操作者已归因', (c.summary?.users ?? []).length > 0 && Number(c.summary?.unattributed ?? 1) === 0, `users=${(c.summary?.users ?? []).join(',')} 未归因=${c.summary?.unattributed}`);
}
const d = cur?.report?.data;
if (d && c) {
  check('report.det.worst 与存档一致', String(d.det?.worst) === String(c.det?.worst), `${d.det?.worst} vs ${c.det?.worst}`);
  const vs = new Set((c.versions ?? []).map((v) => v.v));
  check('report.versionNotes[].v ⊆ 存档版本', (d.versionNotes ?? []).length > 0 && (d.versionNotes ?? []).every((n) => vs.has(String(n.v))), `${(d.versionNotes ?? []).length} 条`);
  check('report 有 rootCause / situation', String(d.rootCause ?? '') !== '' || String(d.situation ?? '') !== '', String(d.situation ?? d.rootCause ?? '').slice(0, 160));
}
try {
  const out = execSync(`TASK="${TASK_NAME}" OUT=${OUT} EXPECT="结构演进图,版本比较,变更时间轴,规范扫描,主干 · 库级结构版本,ddl_lab,检查历史" node scripts/browser/task-shot.mjs`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 150_000 });
  check('面板关键区块齐全', /EXPECT_OK/.test(out), out.split('\n').filter((l) => /EXPECT|errors/.test(l)).join(' · '));
  check('console 零错误', /errors 无/.test(out));
  console.log('截图', OUT);
} catch (e) { check('面板渲染', false, String(e.message).slice(0, 200)); }
const ok = checks.every(Boolean);
console.log(ok ? 'PASS' : 'FAIL', `${checks.filter(Boolean).length}/${checks.length}`);
process.exit(ok ? 0 : 1);
