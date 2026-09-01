// 任务页「平台规则目录」验收（mac 无头 Chrome，CDP 9333）。
// 断言目录本体 + 活数据两层：五个插件分组齐、级别阶梯是彩色档位块、可调阈值挂到了规则上、
// 「近 N 天命中」是 命中/运行 且轨道条真的按比例、搜索与筛选真的改变行数、点开有判据/阈值/最近命中。
//   OUT=/tmp/rules.png node scripts/browser/rules-check.mjs
import puppeteer from 'puppeteer-core';
const BASE = process.env.OPENDB_URL ?? 'http://127.0.0.1:18080';
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const TASK = process.env.TASK ?? '平台规则目录';
const OUT = process.env.OUT ?? '/tmp/rules.png';
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 180000);
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
await p.evaluate(() => { const el = [...document.querySelectorAll('button,div,span')].find((x) => x.children.length === 0 && /^(继续|我知道了|同意)$/.test((x.textContent || '').trim())); el?.click(); });
await sleep(1200);
check(`打开任务「${TASK}」`, await p.evaluate((n) => {
  const els = [...document.querySelectorAll('div,span,a')].filter((x) => x.getBoundingClientRect().x < 320 && x.getBoundingClientRect().width > 0);
  const el = els.find((x) => (x.textContent || '').trim() === n); if (!el) return false; el.click(); return true;
}, TASK));
check('面板出数（等活数据落地）', await p.waitForFunction(() => /可调阈值/.test(document.body.innerText) && document.querySelectorAll('table').length >= 3, { timeout: 40000 }).then(() => true).catch(() => false));
await sleep(800);

const dom = () => p.evaluate(() => {
  const secs = [...document.querySelectorAll('section')].map((s) => ({
    title: (s.querySelector('div')?.textContent ?? '').slice(0, 28),
    rows: s.querySelectorAll('tbody tr').length,
  }));
  const cells = [...document.querySelectorAll('tbody tr')].map((tr) => (tr.children[5]?.textContent ?? '').trim());
  return {
    secs,
    text: document.body.innerText,
    steps: document.querySelectorAll('tbody tr td:nth-child(3) span').length,
    tuneChips: [...document.querySelectorAll('tbody tr td:nth-child(5) span')].map((s) => s.textContent.trim()).filter((t) => t.startsWith('⚙')),
    hitCells: cells.filter((t) => /\d+\s*\/\s*\d+/.test(t)),
    // 轨道条宽度：命中率越高越长（0 命中应为 0 宽）
    tracks: [...document.querySelectorAll('tbody tr td:nth-child(6) i')].map((i) => i.style.width),
  };
});
const d1 = await dom();
check('五个插件分组齐', d1.secs.length === 5, d1.secs.map((s) => `${s.title}(${s.rows})`).join(' · '));
for (const kw of ['健康检查', 'SQL 审核', 'WDR 窗口', 'DDL 追溯', '容量与增长']) check(`分组「${kw}」`, d1.text.includes(kw));
check('容量规则真的在目录里（此前整组漏登记）', d1.text.includes('CAP_STATS_NEVER') && d1.text.includes('CAP_NONTABLE_SHARE'));
check('主机维度规则补上了（此前漏登记）', d1.text.includes('OS_LOAD_HIGH') && d1.text.includes('OS_IOWAIT_HIGH'));
check('级别阶梯是彩色档位块', d1.steps >= 40, `${d1.steps} 个档位块`);
check('可调阈值挂到了规则上', d1.tuneChips.length >= 15, `${d1.tuneChips.length} 行有 ⚙`);
check('有被改过的阈值标黄（activeSessions 08-25 改过）', d1.tuneChips.some((t) => t.includes('已改')), d1.tuneChips.filter((t) => t.includes('已改')).join(' '));
check('命中列是 命中/运行', d1.hitCells.length >= 20, `${d1.hitCells.length} 行有 N/M`);
check('轨道条按命中率给宽度（有 0% 也有高比例）', d1.tracks.includes('0%') && d1.tracks.some((w) => parseInt(w, 10) >= 60), `样本 ${d1.tracks.slice(0, 6).join(',')}`);
check('没有「目录缺登记」残留（存档里的码都登记了）', !d1.text.includes('目录缺登记'));

// 搜索 + 筛选
await p.evaluate(() => { const i = document.querySelector('input'); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(i, 'DDLR'); i.dispatchEvent(new Event('input', { bubbles: true })); });
await sleep(600);
const d2 = await dom();
check('搜索 DDLR 只剩 DDL 组', d2.secs.length === 1 && d2.text.includes('DDLR04') && !d2.text.includes('CAP_GROWTH'), `${d2.secs.length} 组`);
await p.evaluate(() => { const i = document.querySelector('input'); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); });
await sleep(500);
const clickPill = (label) => p.evaluate((l) => {
  const el = [...document.querySelectorAll('span')].find((x) => x.children.length === 0 && (x.textContent || '').trim() === l && getComputedStyle(x).cursor === 'pointer' && x.getBoundingClientRect().x > 300);
  if (!el) return false; el.click(); return true;
}, label);
check('点「容量与增长」筛选', await clickPill('容量与增长')); await sleep(500);
const d3 = await dom();
check('只剩容量组', d3.secs.length === 1 && d3.text.includes('CAP_WAL_SIZE'), `${d3.secs.length} 组`);
await clickPill('容量与增长'); await sleep(400);
check('点「⚙ 可调阈值」只看有阈值的', await clickPill('⚙ 可调阈值')); await sleep(500);
const d4 = await dom();
check('筛完每行都有 ⚙', d4.tuneChips.length > 0 && d4.tuneChips.length === d4.secs.reduce((a, s) => a + s.rows, 0), `${d4.tuneChips.length} 行 / ${d4.secs.reduce((a, s) => a + s.rows, 0)} 行`);
await clickPill('⚙ 可调阈值'); await sleep(400);

// 展开详情
check('点开一行出详情', await p.evaluate(() => {
  const tr = [...document.querySelectorAll('tbody tr')].find((t) => (t.children[0]?.textContent ?? '').trim() === 'SESS_ACTIVE_HIGH');
  if (!tr) return false; tr.click(); tr.scrollIntoView({ block: 'center' }); return true;
}));
await sleep(600);
const det = await p.evaluate(() => document.body.innerText);
check('详情有判据来源与阈值当前值', det.includes('判据来源') && det.includes('当前') && det.includes('activeSessions.notice'));
check('详情有改动理由（来自阈值服务，不是写死的）', /理由：/.test(det) && det.includes('收紧'));
check('常亮规则给出复议提示', det.includes('常亮的发现会淹没真问题'));
check('详情有最近一次命中原文', det.includes('最近一次命中长这样'));
check('改动来源显示成会话标题而不是 session id', /会话「/.test(det) && !/session-[0-9a-f]{8}/.test(det.split('理由：')[0].slice(-200)));
check('被改过的阈值在行上并排标出生效值', (await p.evaluate(() => document.body.innerText)).includes('当前 ≥ 5'));

await p.screenshot({ path: OUT });
check('console/page 零错误', errs.length === 0, errs.slice(0, 2).join(' | '));
const ok = checks.every(Boolean);
console.log('截图', OUT);
console.log(ok ? 'PASS' : 'FAIL', `${checks.filter(Boolean).length}/${checks.length}`);
await p.close(); await b.disconnect();
process.exit(ok ? 0 : 1);
