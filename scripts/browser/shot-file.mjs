// 本地 HTML 截图（mac 无头 Chrome，CDP 9333）：FILE=/abs/path.html OUT=/tmp/x.png [CLIPS=".boards,#S3"] node scripts/browser/shot-file.mjs
//   整页图存 OUT；CLIPS 里每个选择器另存 OUT 去掉 .png 后缀 + -<n>.png（1:1 局部图，便于看细节）
import puppeteer from 'puppeteer-core';
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const FILE = process.env.FILE; const OUT = process.env.OUT ?? '/tmp/shot-file.png';
const W = Number(process.env.WIDTH ?? 1220);
const CLIPS = (process.env.CLIPS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 60000);
const b = await puppeteer.connect({ browserURL: CDP, defaultViewport: { width: W, height: 900 } });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await p.goto(`file://${FILE}`, { waitUntil: 'load', timeout: 20000 });
await new Promise((r) => setTimeout(r, 800));
const h = await p.evaluate(() => document.documentElement.scrollHeight);
const overflow = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
await p.screenshot({ path: OUT, fullPage: true });
let i = 0;
for (const sel of CLIPS) {
  i += 1;
  const el = await p.$(sel);
  if (!el) { console.log('clip not found', sel); continue; }
  const box = await el.boundingBox();
  const clip = { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.min(W, box.width + 16), height: Math.min(1400, box.height + 16) };
  await p.screenshot({ path: OUT.replace(/\.png$/, `-${i}.png`), clip, captureBeyondViewport: true });
}
console.log('height', h, 'horizontalOverflow', overflow, 'errors', errs.length ? errs : '无');
await p.close(); await b.disconnect(); process.exit(0);
