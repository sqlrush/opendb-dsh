// 知识库大盘验收（mac 无头 Chrome，CDP 9333）：
//   ① 侧栏「知识库」一级目录可进「知识库大盘」；② 顶栏「知识库 › 知识库大盘」；
//   ③ 概览 4 卡；④ 三库分区(记忆/向量/图)且数字与库对得上；⑤ 健康自检出向量缺失/图未定型；⑥ console 零错误。
//   OUT=/tmp/kb.png node scripts/browser/kb-check.mjs
import puppeteer from 'puppeteer-core';
const BASE = process.env.OPENDB_URL ?? 'http://127.0.0.1:18080';
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const OUT = process.env.OUT ?? '/tmp/kb.png';
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
await p.evaluate(() => { const el = [...document.querySelectorAll('button,div,span')].find((x) => x.children.length === 0 && /^(继续|我知道了|同意)$/.test((x.textContent || '').trim())); el?.click(); });
await sleep(1200);

// 侧栏「知识库」下的「知识库大盘」
const clicked = await p.evaluate(() => {
  const el = [...document.querySelectorAll('div,span')].find((x) => x.children.length === 0 && (x.textContent || '').trim() === '知识库大盘' && x.getBoundingClientRect().x < 320);
  if (!el) return false; el.click(); return true;
});
check('侧栏「知识库」下可进入「知识库大盘」', clicked);
const ready = await p.waitForFunction(() => /三类知识/.test(document.body.innerText), { timeout: 40000 }).then(() => true).catch(() => false);
check('面板出数（等聚合落地）', ready);
await sleep(800);
const t = await p.evaluate(() => document.body.innerText);
check('顶栏是「知识库 › 知识库大盘」', /知识库\s*›\s*知识库大盘/.test(t), t.split('\n').slice(0, 2).join(' / '));

for (const kw of ['知识总量', '向量覆盖率', '健康度', '最近更新']) check(`概览卡「${kw}」`, t.includes(kw));
for (const kw of ['记忆知识', '向量知识', '图知识']) check(`分区「${kw}」`, t.includes(kw));

// 三库真实数字对得上（记忆 849 · 向量 7 切块 · 图边 878）——从库拿的真数
check('记忆总量显示真实值(≈849)', /8\d\d\s*条/.test(t) || t.includes('849'), '');
check('图知识显示边数(≈878)', /8\d\d\s*条边/.test(t) || t.includes('878'), '');
check('向量覆盖率标出低值(14%)', t.includes('14%'), '');
check('健康自检出「向量缺失」', /向量缺失\s*\d+\s*块/.test(t));
check('健康自检出「图边尚未定型」或共现说明', /尚未定型|记忆实体共现/.test(t));

// 三库分区卡确实是 3 张：三条副标题都在 = 三张卡都渲染了
check('三库分区卡渲染(三张副标题齐)',
  t.includes('平台在这套环境里做过什么') && t.includes('导入的非结构化资料') && t.includes('客户专属关系'));

await p.screenshot({ path: OUT, fullPage: true });
check('console/page 零错误', errs.length === 0, errs.slice(0, 2).join(' | '));
const ok = checks.every(Boolean);
console.log('截图', OUT);
console.log(ok ? 'PASS' : 'FAIL', `${checks.filter(Boolean).length}/${checks.length}`);
await p.close(); await b.disconnect();
process.exit(ok ? 0 : 1);
