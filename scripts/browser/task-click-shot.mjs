// 任务页交互截图（mac 无头 Chrome，CDP 9333）：打开任务大盘，按选择器依次点击（每次点击后截一张首屏），验证 SVG 线段/节点等交互。
//   TASK="og5-ddl-lab" OUT=/tmp/ddl-click.png CLICKS="svg line[stroke-linecap]:nth-of-type(2)|svg circle" node scripts/browser/task-click-shot.mjs
//   选择器在主区内查找；点击用真实鼠标坐标（dsh 官方组件对 el.click() 不响应，2026-08-19 教训），SVG 元素同样走坐标点击。
import puppeteer from 'puppeteer-core';
const BASE = process.env.OPENDB_URL ?? 'http://127.0.0.1:18080';
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const TASK = process.env.TASK ?? '';
const OUT = process.env.OUT ?? '/tmp/task-click.png';
const CLICKS = (process.env.CLICKS ?? '').split('|').map((s) => s.trim()).filter(Boolean);
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 150000);
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
const clicked = await p.evaluate((name) => {
  const els = [...document.querySelectorAll('div,span,a')].filter((x) => x.getBoundingClientRect().x < 320 && x.getBoundingClientRect().width > 0);
  const el = els.find((x) => (x.textContent || '').trim() === name) ?? els.find((x) => x.children.length === 0 && (x.textContent || '').includes(name));
  if (!el) return false; el.click(); return true;
}, TASK);
await sleep(5000);
console.log('task clicked', clicked);
let k = 0;
for (const sel of CLICKS) {
  k += 1;
  const box = await p.evaluate((s) => { const el = document.querySelector(s); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; }, sel);
  if (!box) { console.log(`click ${k} ${sel}: NOT FOUND`); continue; }
  await sleep(300);
  await p.mouse.move(box.x, box.y); await sleep(150);
  await p.mouse.click(box.x, box.y); await sleep(500);
  await p.screenshot({ path: OUT.replace(/\.png$/, `-click-${k}.png`) });
  console.log(`click ${k} ${sel}: ok @${Math.round(box.x)},${Math.round(box.y)}`);
}
const text = await p.evaluate(() => document.body.textContent || '');
const expect = (process.env.EXPECT ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (expect.length > 0) { const missing = expect.filter((kw) => !text.includes(kw)); console.log(missing.length === 0 ? 'EXPECT_OK' : `EXPECT_MISSING ${missing.join(' | ')}`); }
console.log('errors', errs.length ? errs : '无');
await p.close(); await b.disconnect(); process.exit(0);
