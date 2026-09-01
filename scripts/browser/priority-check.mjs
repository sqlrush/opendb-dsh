// 「处置优先级」渲染验收（mac 无头 Chrome，CDP 9333）。
// 起因：2026-08-31 user 报 DDL 报告的处置优先级显示有问题——模型把整句叙述填进了 p，
// 面板拿固定 34px 的徽章列去装，一个字一行撑成竖带。断言的是**几何**（徽章不许被撑高），
// 光比文本会被"字都在页面上"蒙混过去。
// 适用于徽章+正文两列的面板（ddl / wdr / sqlreview / capacity）；health 是卡片版式，不走这套断言。
//   TASK=og5-ddl-lab OUT=/tmp/pri.png node scripts/browser/priority-check.mjs
import puppeteer from 'puppeteer-core';
const BASE = process.env.OPENDB_URL ?? 'http://127.0.0.1:18080';
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const TASK = process.env.TASK ?? 'og5-ddl-lab';
const OUT = process.env.OUT ?? '/tmp/priority.png';
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 150000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, extra = '') => { checks.push(ok); console.log(`${ok ? '✔' : '✖'} ${name}${extra ? ` — ${extra}` : ''}`); return ok; };

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
check(`打开任务「${TASK}」`, clicked);
const ready = await p.waitForFunction(() => /处置优先级/.test(document.body.innerText), { timeout: 40000 }).then(() => true).catch(() => false);
check('报告里出现「处置优先级」区块', ready);

// 区块内每一项：第一列 = 徽章，第二列 = 内容
const items = await p.evaluate(() => {
  const label = [...document.querySelectorAll('div')].find((d) => d.children.length === 0 && (d.textContent || '').trim() === '处置优先级');
  const box = label?.parentElement;
  if (box === undefined || box === null) return null;
  const rows = [...box.querySelectorAll(':scope > div > div')].filter((r) => getComputedStyle(r).display === 'grid' && r.children.length >= 2);
  return rows.map((r) => {
    const badge = r.children[0]; const body = r.children[1];
    const bb = badge.getBoundingClientRect(); const yb = body.getBoundingClientRect();
    return {
      badge: (badge.textContent || '').trim(), badgeW: Math.round(bb.width), badgeH: Math.round(bb.height),
      bodyW: Math.round(yb.width), bodyH: Math.round(yb.height), body: (body.textContent || '').trim().slice(0, 40),
    };
  });
});
check('取到优先级条目', items !== null && items.length > 0, items === null ? '未找到区块' : `${items.length} 条`);
if (items !== null && items.length > 0) {
  for (const [i, it] of items.entries()) console.log(`   #${i + 1} 徽章「${it.badge}」${it.badgeW}×${it.badgeH}px · 正文 ${it.bodyW}×${it.bodyH}px · ${it.body}…`);
  check('徽章文字都很短（P0/#1/high 这类档位，不是整句话）', items.every((x) => x.badge.length <= 6), items.map((x) => x.badge).join(' '));
  check('徽章没有被文字撑成竖带（高度 ≤ 32px）', items.every((x) => x.badgeH <= 32), `最高 ${Math.max(...items.map((x) => x.badgeH))}px`);
  check('正文列比徽章列宽得多（长文本落在正文里）', items.every((x) => x.bodyW > x.badgeW * 3), `最窄正文 ${Math.min(...items.map((x) => x.bodyW))}px`);
}
// 主区是内层滚动容器，fullPage 截不到下方——把区块滚进视口再截
await p.evaluate(() => {
  const label = [...document.querySelectorAll('div')].find((d) => d.children.length === 0 && (d.textContent || '').trim() === '处置优先级');
  label?.scrollIntoView({ block: 'center' });
});
await sleep(600);
await p.screenshot({ path: OUT });
check('console/page 零错误', errs.length === 0, errs.slice(0, 2).join(' | '));
const ok = checks.every(Boolean);
console.log('截图', OUT);
console.log(ok ? 'PASS' : 'FAIL', `${checks.filter(Boolean).length}/${checks.length}`);
await p.close(); await b.disconnect();
process.exit(ok ? 0 : 1);
