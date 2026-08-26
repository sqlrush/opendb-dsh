// 发布后浏览器级验收（mac 无头 Chrome，CDP 9333）：任务页必须是专属大盘而不是默认历史列表，console 零错误。
//   node scripts/browser/task-panel-check.mjs            # 默认检查侧栏里第一个 health 类型任务 + 平台阈值配置
//   TASKS="og5过载监控,平台阈值配置" node scripts/browser/task-panel-check.mjs
// 背景：同一症状（报告变成历史列表）出过三次（注册竞态 ×2、滚动窗口 ×1），从此每次滚动后自动跑这个。
import puppeteer from 'puppeteer-core';

const BASE = process.env.OPENDB_URL ?? 'http://127.0.0.1:18080';
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const TASKS = (process.env.TASKS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 150000);

const b = await puppeteer.connect({ browserURL: CDP, defaultViewport: { width: 1500, height: 1000 } });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror:' + String(e).slice(0, 300)));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console:' + m.text().slice(0, 300)); });
p.on('response', (r) => { if (r.status() >= 400 && /plugins|client\.js/.test(r.url())) errs.push(`http${r.status()}:` + r.url().slice(0, 120)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await p.goto(`${BASE}/?v=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await sleep(8000);
await p.evaluate(() => { const el = [...document.querySelectorAll('button')].find((x) => /继续|同意|知道了/.test((x.textContent || '').trim())); if (el) el.click(); });
await sleep(800);

// 侧栏「任务」组下的条目
const listed = await p.evaluate(() => {
  const rows = [...document.querySelectorAll('div,span,a')].filter((x) => x.getBoundingClientRect().x < 320 && x.getBoundingClientRect().width > 0 && x.children.length === 0);
  const names = rows.map((x) => (x.textContent || '').trim()).filter((t) => t && t.length < 30);
  const i = names.indexOf('任务'); const j = names.indexOf('数据库');
  return i >= 0 ? names.slice(i + 1, j > i ? j : undefined).filter((t) => !/^\d+$/.test(t) && t !== '运行中') : [];
});
const targets = TASKS.length > 0 ? TASKS : listed;
console.log('检查任务:', targets.join(', ') || '(侧栏没有任务)');
let ok = targets.length > 0;
for (const name of targets) {
  const clicked = await p.evaluate((name) => { const el = [...document.querySelectorAll('div,span,a')].find((x) => (x.textContent || '').trim() === name && x.getBoundingClientRect().x < 320 && x.getBoundingClientRect().width > 0); if (!el) return false; el.click(); return true; }, name);
  await sleep(4500);
  const st = await p.evaluate(() => {
    const t = document.body.textContent || '';
    return { defaultView: /当前是默认视图|面板插件包没加载上|没有注册出/.test(t), panel: /维体检|阈值|平台阈值/.test(t) };
  });
  const pass = clicked && !st.defaultView;
  console.log(`  ${pass ? '✔' : '✖'} ${name}：${clicked ? (st.defaultView ? '落到默认视图/兜底红条' : '专属面板') : '侧栏没找到'}`);
  ok = ok && pass;
}
console.log('console/page 错误:', errs.length ? errs : '无');
await p.close();
console.log(ok && errs.length === 0 ? 'PASS' : 'FAIL');
process.exit(ok && errs.length === 0 ? 0 : 1);
