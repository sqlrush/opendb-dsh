// 任务页整页截图（mac 无头 Chrome，CDP 9333）：TASK="og5慢SQL双榜报表" OUT=/tmp/shot.png node scripts/browser/task-shot.mjs
import puppeteer from 'puppeteer-core';
const BASE = process.env.OPENDB_URL ?? 'http://127.0.0.1:18080';
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const TASK = process.env.TASK ?? '';
const OUT = process.env.OUT ?? '/tmp/task-shot.png';
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 120000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.connect({ browserURL: CDP, defaultViewport: { width: 1500, height: 1000 } });
const p = await b.newPage();
await p.goto(`${BASE}/?v=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await sleep(9000);
await p.evaluate(() => { const el = [...document.querySelectorAll('button')].find((x) => /继续|同意|知道了/.test((x.textContent || '').trim())); if (el) el.click(); });
await sleep(1000);
const sidebar = await p.evaluate(() => [...document.querySelectorAll('div,span,a')].filter((x) => x.getBoundingClientRect().x < 320 && x.getBoundingClientRect().width > 0 && x.children.length === 0).map((x) => (x.textContent || '').trim()).filter((t) => t && t.length < 30));
console.log('sidebar:', sidebar.join(' | ').slice(0, 400));
const clicked = await p.evaluate((name) => {
  const els = [...document.querySelectorAll('div,span,a')].filter((x) => x.getBoundingClientRect().x < 320 && x.getBoundingClientRect().width > 0);
  const el = els.find((x) => (x.textContent || '').trim() === name) ?? els.find((x) => x.children.length === 0 && (x.textContent || '').includes(name));
  if (!el) return false; el.click(); return true;
}, TASK);
await sleep(5000);
const h = await p.evaluate(() => document.documentElement.scrollHeight);
console.log('clicked', clicked, 'pageHeight', h);
await p.screenshot({ path: OUT, fullPage: true });
await p.close();
await b.disconnect();
console.log('saved', OUT);
process.exit(0);
