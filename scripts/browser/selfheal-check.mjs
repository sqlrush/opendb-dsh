// 面板自愈验收（mac 无头 Chrome，CDP 9333）：模拟"页面在后端抖动窗口里加载"——
//   前 12 秒阻断 task-capacity / ui-cluster 的 client.js（dsh client-modules 不会重试，注册表永久缺项）
//   → 解除阻断 → 页面应在 ~20–60s 内自己整页重载一次 → 重载后注册表齐全、任务页/资源页正常、console 零错误。
//   node scripts/browser/selfheal-check.mjs
// 背景（2026-09-06）：user 两次报障「任务和资源的大盘报表又没了」——k8s 重启 / Host 崩溃重启窗口里加载或重连的页签
//   缺插件，直到人工刷新。自愈逻辑见 ui-harness self-heal.ts。
import puppeteer from 'puppeteer-core';
const BASE = process.env.OPENDB_URL ?? 'http://127.0.0.1:18080';
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const BLOCK_MS = 12000;
const RELOAD_WAIT_MS = 90000;
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 200000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, extra = '') => { checks.push(ok); console.log(`${ok ? '✔' : '✖'} ${name}${extra ? ` — ${extra}` : ''}`); return ok; };

const b = await puppeteer.connect({ browserURL: CDP, defaultViewport: { width: 1400, height: 900 } });
const p = await b.newPage();
let blocking = true; let blocked = 0; let loads = 0;
const errsAfterReload = [];
p.on('load', () => { loads += 1; });
p.on('pageerror', (e) => { if (loads >= 2) errsAfterReload.push('pageerror:' + String(e).slice(0, 160)); });
p.on('console', (m) => { if (m.type() === 'error' && loads >= 2) errsAfterReload.push('console:' + m.text().slice(0, 160)); });
await p.setRequestInterception(true);
p.on('request', (r) => {
  if (blocking && /plugins\/@opendb-dsh\/(task-capacity|ui-cluster)\/client\.js/.test(r.url())) { blocked += 1; r.abort('failed'); return; }
  r.continue();
});
await p.goto(`${BASE}/?v=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await sleep(BLOCK_MS);
blocking = false;
for (let i = 0; i < 3; i += 1) {
  const n = await p.evaluate(() => { const bs = [...document.querySelectorAll('button')].filter((x) => /^(继续|我知道了|同意)$/.test((x.textContent || '').trim())); bs.forEach((x) => x.click()); return bs.length; });
  await sleep(800); if (!n) break;
}
const reg = () => p.evaluate(() => { const h = window.__opendbHarness__; return h && h.__registries ? { task: h.__registries.task.size, resource: h.__registries.resource.size } : null; }).catch(() => null);
const expected = await p.evaluate(() => { const e = (window.__DSH_BOOT__ && window.__DSH_BOOT__.entries) || []; return { tasks: e.filter((x) => String(x.id).startsWith('@opendb-dsh/task-')).length, hasCluster: e.some((x) => x.id === '@opendb-dsh/ui-cluster') }; });
const before = await reg();
check('阻断成功制造了缺项（task 少于应有 / resource 缺 cluster）', blocked >= 1 && before !== null && (before.task < expected.tasks || before.resource < 2), `blocked=${blocked} reg=${JSON.stringify(before)} expected=${JSON.stringify(expected)}`);
console.log('已解除阻断，等页面自愈重载（最多 90s）…');
const t0 = Date.now(); let reloaded = false;
while (Date.now() - t0 < RELOAD_WAIT_MS) { await sleep(2000); if (loads >= 2) { reloaded = true; break; } }
check('页面自动整页重载了一次', reloaded, `耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
await sleep(12000);
for (let i = 0; i < 3; i += 1) {
  const n = await p.evaluate(() => { const bs = [...document.querySelectorAll('button')].filter((x) => /^(继续|我知道了|同意)$/.test((x.textContent || '').trim())); bs.forEach((x) => x.click()); return bs.length; });
  await sleep(800); if (!n) break;
}
const after = await reg();
check('重载后注册表齐全', after !== null && after.task >= expected.tasks && after.resource >= 2, JSON.stringify(after));
const stamped = await p.evaluate(() => { try { return Number(sessionStorage.getItem('opendb-harness.selfheal.reloadAt') || 0) > 0; } catch { return false; } });
check('重载已盖时间戳（5 分钟内不会再自动重载）', stamped);
const second = await p.evaluate(() => (window.__opendbHarness__ && window.__opendbHarness__.selfHealCheck) ? window.__opendbHarness__.selfHealCheck('manual') : 'no-fn').catch((e) => 'err:' + e);
check('齐全后再核对返回 ok（不会重复重载）', second === 'ok' || second === 'too-early', String(second));
await p.evaluate(() => { const el = [...document.querySelectorAll('div,span,a')].find((x) => (x.textContent || '').trim() === 'og5-capacity' && x.getBoundingClientRect().x < 320 && x.getBoundingClientRect().width > 0); el?.click(); });
await sleep(4000);
const t = await p.evaluate(() => document.body.innerText);
// 判据 = 容量面板专属标题「容量态势」+ 不是默认视图；不看字数（随数据变，2026-09-17 无存档那次只剩 811 字而误报）
check('重载后 og5-capacity 是专属面板', !/当前是默认视图|面板插件包没加载上|没有注册出/.test(t) && /容量态势/.test(t), `len=${t.length}`);
check('重载后侧栏有「k8s 集群状态」', await p.evaluate(() => [...document.querySelectorAll('span')].some((x) => (x.textContent || '').trim() === 'k8s 集群状态')));
check('重载后 console/page 零错误', errsAfterReload.length === 0, errsAfterReload.slice(0, 2).join(' | '));
const ok = checks.every(Boolean);
console.log(ok ? 'PASS' : 'FAIL', `${checks.filter(Boolean).length}/${checks.length}`);
await p.close(); await b.disconnect();
process.exit(ok ? 0 : 1);
