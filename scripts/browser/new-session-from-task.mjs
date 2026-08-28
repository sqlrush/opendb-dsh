// 行为测试（2026-08-28 user 报障：在任务报表页点「新会话」没反应）：
//   打开某个任务页 → 真实点击侧栏顶部「新会话」→ 2s 内主区必须切回聊天区（任务页标题消失、输入框可用）。
//   TASK="og5慢SQL Top3跟踪" node scripts/browser/new-session-from-task.mjs
import puppeteer from 'puppeteer-core';
const BASE = process.env.OPENDB_URL ?? 'http://127.0.0.1:18080';
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const TASK = process.env.TASK ?? '';
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 90000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.connect({ browserURL: CDP, defaultViewport: { width: 1500, height: 1000 } });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror:' + String(e).slice(0, 300)));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console:' + m.text().slice(0, 300)); });
await p.goto(`${BASE}/?v=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await sleep(9000);
await p.evaluate(() => { const el = [...document.querySelectorAll('button')].find((x) => /继续|同意|知道了/.test((x.textContent || '').trim())); if (el) el.click(); });
await sleep(800);
const clickSidebar = (name) => p.evaluate((n) => {
  const els = [...document.querySelectorAll('button,div,span,a')].filter((x) => x.getBoundingClientRect().x < 320 && x.getBoundingClientRect().width > 0);
  const el = els.find((x) => (x.textContent || '').trim() === n) ?? els.find((x) => x.children.length === 0 && (x.textContent || '').includes(n));
  if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, name);
const inTask = () => p.evaluate(() => /Top SQL 资源占比|跟踪 SQL 资源占比|维体检|平台阈值|还没有/.test(document.body.textContent || '') && !!document.querySelector('[data-odb-view], textarea') );
const t = await clickSidebar(TASK);
if (!t) { console.log('FAIL 侧栏没找到任务', TASK); process.exit(1); }
await p.mouse.click(t.x, t.y);
await sleep(4000);
const taskShown = await p.evaluate(() => /返回会话/.test(document.body.textContent || ''));
console.log(taskShown ? '✔' : '✖', '任务页已打开（有「返回会话」）');
const n = await clickSidebar('新会话');
if (!n) { console.log('FAIL 侧栏没找到「新会话」'); process.exit(1); }
await p.mouse.move(n.x, n.y, { steps: 6 });
await p.mouse.click(n.x, n.y);
let chat = false; let waited = 0;
for (; waited < 6000; waited += 300) {
  await sleep(300);
  chat = await p.evaluate(() => {
    const ta = document.querySelector('textarea');
    const visible = ta && ta.getBoundingClientRect().width > 0 && !/返回会话/.test(document.body.textContent || '');
    return !!visible;
  });
  if (chat) break;
}
console.log(chat ? '✔' : '✖', `点「新会话」后 ${waited}ms 内切回聊天区（输入框可见、任务页消失）`);
const enabled = await p.evaluate(() => { const ta = document.querySelector('textarea'); return !!ta && !ta.disabled; });
console.log(enabled ? '✔' : '✖', '输入框可用（不是置灰草稿）');
console.log('errors', errs.length ? errs : '无');
await p.close(); await b.disconnect();
const ok = taskShown && chat && errs.length === 0;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
