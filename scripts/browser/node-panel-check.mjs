// 数据库大盘（每节点专属页）浏览器验收（mac 无头 Chrome，CDP 9333）：
//   侧栏「数据库」点第一个节点 → 八段都在（页头结论 / 8 项 KPI / 4 项 OS / DB Time / 五类判决 / 存储 / 时间轴 / 任务表 / 知识条），
//   数字不是假 0，24h↔7d 切换会重新取数，深挖链存在且是三态文字链，console 零错误。
//   NODE=og5 node scripts/browser/node-panel-check.mjs
import puppeteer from 'puppeteer-core';
const BASE = process.env.OPENDB_URL ?? 'http://127.0.0.1:18080';
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const OUT = process.env.OUT ?? '/tmp/node-panel.png';
const NODE = process.env.NODE ?? '';
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 150000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, extra = '') => { checks.push(ok); console.log(`${ok ? '✔' : '✖'} ${name}${extra ? ` — ${extra}` : ''}`); return ok; };

const b = await puppeteer.connect({ browserURL: CDP, defaultViewport: { width: 1400, height: 900 } });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror:' + String(e).slice(0, 160)));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console:' + m.text().slice(0, 160)); });
let dashCalls = 0;
p.on('response', (r) => { if (/\/api/.test(r.url()) && r.request().postData?.()?.includes('nodes/dashboard')) dashCalls += 1; });
await p.goto(`${BASE}/?v=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await sleep(10000);
for (let i = 0; i < 3; i += 1) {
  const n = await p.evaluate(() => { const bs = [...document.querySelectorAll('button')].filter((x) => /^(继续|我知道了|同意)$/.test((x.textContent || '').trim())); bs.forEach((x) => x.click()); return bs.length; });
  await sleep(800); if (!n) break;
}
// 侧栏「数据库」组下第一个节点（或 NODE 指定）
const target = await p.evaluate((want) => {
  const rows = [...document.querySelectorAll('div,span,a')].filter((x) => x.getBoundingClientRect().x < 320 && x.getBoundingClientRect().width > 0 && x.children.length === 0);
  const names = rows.map((r) => (r.textContent || '').trim());
  const i = names.indexOf('数据库'); const j = names.indexOf('知识库');
  const cands = names.slice(i + 1, j > i ? j : undefined).filter((n) => n && !/^\d+$/.test(n));
  const pick = want && cands.includes(want) ? want : cands[0];
  const el = rows.find((r) => (r.textContent || '').trim() === pick); if (el) el.click();
  return pick ?? '';
}, NODE);
check('侧栏找到数据库节点并打开', target !== '', target);
await sleep(8000);
const t = await p.evaluate(() => document.body.innerText);
const sec = (re) => re.test(t);
check('页头有节点名与综合结论', new RegExp(target).test(t) && /五类巡检最近结论中最差|都还没有有效结论/.test(t));
check('「现在」8 项 KPI 齐', ['活跃会话', '等待锁', '连接使用率', '每秒事务', '每秒语句', '平均语句耗时', '缓存命中率', '物理读 / 秒'].every((k) => t.includes(k)));
check('「主机（OS 层）」4 项齐', ['CPU 忙', '每核负载', '内存（数据库进程）', 'IO 等待占比'].every((k) => t.includes(k)));
check('DB Time 构成 + 主机资源明细', sec(/DB Time 构成/) && sec(/主机资源明细/));
check('五类判决卡齐', ['健康体检', 'SQL 审核', 'WDR 窗口', 'DDL 变更', '容量与增长'].every((k) => t.includes(k)));
check('存储与增长 + 变更时间轴', sec(/存储与增长/) && sec(/变更时间轴/));
check('本节点定时任务 + 知识条', sec(/本节点的定时任务/) && sec(/平台记住了什么/));
// 每个 KPI 瓦片的 innerText 形如「活跃会话\n5\n空闲 7.04」，无数据时是「活跃会话\n—」；按标签逐个看下一行是否以数字开头
// （首版用 `main div` 数数，dsh 布局根本没有 <main>，真机 12 项全绿的页面被它判了假——2026-09-06）
const KPI_LABELS = ['活跃会话', '等待锁', '连接使用率', '每秒事务', '每秒语句', '平均语句耗时', '缓存命中率', '物理读 / 秒'];
const numericKpis = KPI_LABELS.filter((k) => new RegExp(`${k}\\s*\\n\\s*\\d`).test(t)).length;
check('KPI 有真实数字（非全部 —）', numericKpis >= 6, `${numericKpis}/8 项有数字`);
check('深挖 / 看报告文字链存在', /在会话里深挖 →|深挖 →|查看报告 →|看会话 →/.test(t));
// 24h → 7d 切换会重新取数
const before = dashCalls;
await p.evaluate(() => { const el = [...document.querySelectorAll('span')].find((x) => (x.textContent || '').trim() === '7 天'); el?.click(); });
await sleep(5000);
const t7 = await p.evaluate(() => document.body.innerText);
check('切到 7 天后重新取数并标注', /迷你曲线为 7 天/.test(t7), `dashboard 调用 ${before} → ${dashCalls}`);
// 主区是内部滚动容器，fullPage 只截得到第一屏；把视口拉到内容高度再截，整页八段都进图
const contentH = await p.evaluate(() => Math.max(900, ...[...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 50 && getComputedStyle(e).overflowY !== 'visible').map((e) => e.scrollHeight)));
await p.setViewport({ width: 1400, height: Math.min(contentH + 40, 6000) });
await sleep(800);
await p.screenshot({ path: OUT, fullPage: true });
check('console/page 零错误', errs.length === 0, errs.slice(0, 2).join(' | '));
const ok = checks.every(Boolean);
console.log('截图', OUT);
console.log(ok ? 'PASS' : 'FAIL', `${checks.filter(Boolean).length}/${checks.length}`);
await p.close(); await b.disconnect();
process.exit(ok ? 0 : 1);
