// 任务页分段截图（主区是内滚容器，fullPage 截不到下面）：TASK="og5慢SQL Top5报表" OUT=/tmp/t.png node scripts/browser/task-scroll-shots.mjs
//   产出 OUT 去掉 .png + -1.png、-2.png…（每段一个视口高度），便于亲眼核对逐条分析卡等靠下的区块。
import puppeteer from 'puppeteer-core';
const BASE = process.env.OPENDB_URL ?? 'http://127.0.0.1:18080';
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const TASK = process.env.TASK ?? '';
const OUT = process.env.OUT ?? '/tmp/task-scroll.png';
const MAX = Number(process.env.MAX_SHOTS ?? 8);
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
await sleep(1000);
const clicked = await p.evaluate((name) => {
  const els = [...document.querySelectorAll('div,span,a')].filter((x) => x.getBoundingClientRect().x < 320 && x.getBoundingClientRect().width > 0);
  const el = els.find((x) => (x.textContent || '').trim() === name) ?? els.find((x) => x.children.length === 0 && (x.textContent || '').includes(name));
  if (!el) return false; el.click(); return true;
}, TASK);
await sleep(5000);
// 找主区的滚动容器：含「逐条分析」或「报告」文字的最深元素往上找第一个 overflow 可滚的祖先
const info = await p.evaluate(() => {
  // 锚点文字按面板各取一个（Top SQL 报表 / 健康报告 / WDR 窗口报告）；找不到锚点就只能截首屏
  const anchor = [...document.querySelectorAll('div,span')].find((x) => x.children.length === 0 && /逐条分析|Top SQL 资源占比|总体：|窗口态势：/.test(x.textContent || ''));
  let el = anchor;
  while (el && el !== document.body) {
    const cs = getComputedStyle(el);
    if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 10) break;
    el = el.parentElement;
  }
  if (!el || el === document.body) return null;
  el.setAttribute('data-shot-scroller', '1');
  return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
});
console.log('clicked', clicked, 'scroller', JSON.stringify(info));
let n = 0;
if (info) {
  for (let y = 0; y < info.scrollHeight && n < MAX; y += info.clientHeight - 40) {
    await p.evaluate((yy) => { document.querySelector('[data-shot-scroller]').scrollTop = yy; }, y);
    await sleep(500);
    n += 1;
    await p.screenshot({ path: OUT.replace(/\.png$/, `-${n}.png`) });
  }
} else {
  n = 1; await p.screenshot({ path: OUT.replace(/\.png$/, '-1.png') });
}
console.log('shots', n, 'errors', errs.length ? errs : '无');
await p.close(); await b.disconnect(); process.exit(0);
