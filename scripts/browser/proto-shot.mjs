// 设计稿截图（mac 无头 Chrome，CDP 9333）：打开本地 HTML 原型，整页分段截图，并可按 CSS 选择器依次点击后再截（验证交互）。
//   FILE=docs/prototypes/ddl-r2.html OUT=/tmp/ddl-r2.png CLICKS=".seg:nth-of-type(3)|.node" node scripts/browser/proto-shot.mjs
//   产出 OUT-1.png…（每段一个视口高度）；CLICKS 里每个选择器点击后额外截一张 OUT-click-N.png（首屏）。
import puppeteer from 'puppeteer-core';
import { resolve } from 'node:path';
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const FILE = resolve(process.env.FILE ?? 'docs/prototypes/index.html');
const OUT = process.env.OUT ?? '/tmp/proto.png';
const CLICKS = (process.env.CLICKS ?? '').split('|').map((s) => s.trim()).filter(Boolean);
const MAX = Number(process.env.MAX_SHOTS ?? 8);
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 120000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.connect({ browserURL: CDP, defaultViewport: { width: 1500, height: 1000 } });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror:' + String(e).slice(0, 300)));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console:' + m.text().slice(0, 300)); });
await p.goto(`file://${FILE}`, { waitUntil: 'load', timeout: 30000 });
await sleep(800);
const h = await p.evaluate(() => document.documentElement.scrollHeight);
let n = 0;
for (let y = 0; y < h && n < MAX; y += 960) { await p.evaluate((yy) => window.scrollTo(0, yy), y); await sleep(250); n += 1; await p.screenshot({ path: OUT.replace(/\.png$/, `-${n}.png`) }); }
let k = 0;
for (const sel of CLICKS) {
  k += 1;
  const ok = await p.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); el.scrollIntoView({ block: 'center' }); return true; }, sel);
  await sleep(300);
  await p.screenshot({ path: OUT.replace(/\.png$/, `-click-${k}.png`) });
  console.log(`click ${k} ${sel}: ${ok ? 'ok' : 'NOT FOUND'}`);
}
console.log('height', h, 'shots', n, 'errors', errs.length ? errs : '无');
await p.close(); await b.disconnect(); process.exit(0);
