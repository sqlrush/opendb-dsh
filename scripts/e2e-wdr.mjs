// WDR 窗口报告（R2）验收：立即运行既有 WDR 任务 → 采集存档是 R2 全景 → 报告只装解读且引用的 sqlId 来自存档 → 面板渲染。
//   ① tasks/runNow 触发一轮，等 turn 结束（≤ 12 分钟）；
//   ② runs/list 里该 run 的 collect：scope=wdr-window / version=2，trend ≥ 2 窗口、loadProfile ≥ 15 行、topSql 非空、
//      waits.top 非空、checks=7 条、insights 非空、summary 有 AAS；
//   ③ report.data：det.worst 与存档一致、topSql[].sqlId ⊆ 存档 sqlId、findings[].code ⊆ 存档 checks；
//   ④ 无头 Chrome 打开任务页：出现「负载趋势」「一眼结论」「Load Profile」「Top SQL」「等待事件 Top」「发现」，console 零错误，截图留档。
//   TASK_ID=task-bfbda2d1 TASK_NAME=og5-wdr-hourly OPENDB_HOST_PORT=18080 node scripts/e2e-wdr.mjs   （在 mac 上跑）
import { execSync } from 'node:child_process';
const PORT = process.env.OPENDB_HOST_PORT ?? '18080';
const BASE = `http://127.0.0.1:${PORT}`;
const TASK_ID = process.env.TASK_ID ?? 'task-bfbda2d1';
const TASK_NAME = process.env.TASK_NAME ?? 'og5-wdr-hourly';
const OUT = process.env.OUT ?? '/tmp/wdr-r2-e2e.png';
const envelope = (method, payload) => ({ type: 'client-request', rpcId: `q-${Math.random().toString(36).slice(2)}`, method, payload });
const post = async (url, method, payload) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify(envelope(method, payload)) });
  return r.json();
};
const opendb = (method, payload) => post(`${BASE}/opendb/${method}`, method, payload);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, extra = '') => { checks.push(ok); console.log(`${ok ? '✔' : '✖'} ${name}${extra ? ` — ${extra}` : ''}`); return ok; };

// ① 触发
const fired = await opendb('tasks/runNow', { id: TASK_ID });
const run = fired.result?.value?.run;
if (run === undefined) { console.log('FAIL runNow', JSON.stringify(fired).slice(0, 300)); process.exit(1); }
console.log('run', run.id, 'fired', run.firedAt);
const t0 = Date.now();
let cur;
for (; Date.now() - t0 < 12 * 60_000; await sleep(10_000)) {
  const list = await opendb('runs/list', { taskId: TASK_ID });
  cur = (list.result?.value?.runs ?? []).find((r) => r.id === run.id);
  if (cur !== undefined && (cur.report !== undefined || ['succeeded', 'failed', 'timeout'].includes(String(cur.status)))) break;
}
const secs = Math.round((Date.now() - t0) / 1000);
check('运行结束', cur !== undefined && cur.report !== undefined, `${secs}s · status=${cur?.status} · ${String(cur?.error ?? '').slice(0, 120)}`);

// ② 存档
const c = cur?.collect;
check('存档是 R2 全景（scope=wdr-window, version=2）', c?.scope === 'wdr-window' && Number(c?.version) === 2, c ? `id=${c.id} · 窗口 ${c.window?.beginSnap}→${c.window?.endSnap} · ${c.window?.minutes} 分钟` : '无存档');
if (c) {
  check('trend ≥ 2 窗口', (c.trend ?? []).length >= 2, `${(c.trend ?? []).length} 窗口 · AAS 末值 ${c.trend?.at(-1)?.aas}`);
  check('summary 有 AAS / DB Time', typeof c.summary?.aas === 'number' && typeof c.summary?.dbTimeS === 'number', `AAS ${c.summary?.aas}（上窗 ${c.summary?.prevAas}）· DB Time ${c.summary?.dbTimeS} s · 命中 ${c.summary?.hitRatio}`);
  check('loadProfile ≥ 15 行', (c.loadProfile ?? []).length >= 15, `${(c.loadProfile ?? []).length} 行`);
  check('topSql 非空且带多维指标', (c.topSql ?? []).length > 0 && c.topSql.every((s) => 'cpuMs' in s && 'blocks' in s && 'spillBytes' in s && 'probe' in s), `${(c.topSql ?? []).length} 条 · Top1 ${c.topSql?.[0]?.sqlId} attr=${c.topSql?.[0]?.attr} share=${c.topSql?.[0]?.share}`);
  check('waits.top 非空（STATUS 已剔除）', (c.waits?.top ?? []).length > 0 && c.waits.top.every((w) => w.type !== 'STATUS'), `${(c.waits?.top ?? []).length} 条 · 合计 ${Math.round(Number(c.waits?.totalUs ?? 0) / 1e6)} s · Top1 ${c.waits?.top?.[0]?.event}`);
  check('checks 7 条（含通过项）', (c.checks ?? []).length === 7, (c.checks ?? []).map((k) => `${k.code}=${k.level}`).join(' '));
  check('insights 非空', (c.insights ?? []).length > 0, (c.insights ?? []).map((i) => i.text).join(' ｜ ').slice(0, 300));
  check('host / io / ckpt 齐全', typeof c.host?.cores === 'number' && c.io !== undefined && c.ckpt !== undefined, `${c.host?.cores} 核 · load ${c.host?.load} · ckpt ${c.ckpt?.timed}/${c.ckpt?.req}`);
}

// ③ 报告只装解读
const d = cur?.report?.data;
if (d && c) {
  check('report.det.worst 与存档一致', String(d.det?.worst) === String(c.det?.worst), `${d.det?.worst} vs ${c.det?.worst}`);
  const ids = new Set((c.topSql ?? []).map((s) => String(s.sqlId)));
  const notes = d.topSql ?? [];
  check('report.topSql[].sqlId ⊆ 存档', notes.length > 0 && notes.every((n) => ids.has(String(n.sqlId))), `${notes.length} 条解读`);
  const codes = new Set((c.checks ?? []).map((k) => String(k.code)));
  check('report.findings[].code ⊆ 存档 checks', (d.findings ?? []).every((f) => codes.has(String(f.code))), `${(d.findings ?? []).length} 条`);
  check('report 有 rootCause / situation', String(d.rootCause ?? '') !== '' || String(d.situation ?? '') !== '', String(d.situation ?? d.rootCause ?? '').slice(0, 160));
}

// ④ 面板
try {
  const out = execSync(`TASK="${TASK_NAME}" OUT=${OUT} EXPECT="负载趋势,一眼结论,Load Profile,Top SQL,等待事件 Top,发现,检查历史" node scripts/browser/task-shot.mjs`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 150_000 });
  check('面板关键区块齐全', /EXPECT_OK/.test(out), out.split('\n').filter((l) => /EXPECT|errors/.test(l)).join(' · '));
  check('console 零错误', /errors 无/.test(out));
  console.log('截图', OUT);
} catch (e) { check('面板渲染', false, String(e.message).slice(0, 200)); }

const ok = checks.every(Boolean);
console.log(ok ? 'PASS' : 'FAIL', `${checks.filter(Boolean).length}/${checks.length}`);
process.exit(ok ? 0 : 1);
