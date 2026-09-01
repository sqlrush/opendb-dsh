// 资源 › 模型用量 的浏览器级验收（mac 无头 Chrome，CDP 9333）：
//   ① 侧栏「资源」下的「模型用量」可进；② 摘要 6 卡；③ 趋势图（堆叠柱 + 顶部数值 + 调用次数细带，无右轴折线）；
//   ④ 范围 7/30 与口径 tokens/次数 切换生效；⑤ 构成（来源/模型）+ 单次规模；⑥ Top 会话表；⑦ console 零错误。
//   OUT=/tmp/usage.png node scripts/browser/usage-check.mjs
import puppeteer from 'puppeteer-core';
const BASE = process.env.OPENDB_URL ?? 'http://127.0.0.1:18080';
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const OUT = process.env.OUT ?? '/tmp/usage.png';
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
await sleep(1200);

const clicked = await p.evaluate(() => {
  const el = [...document.querySelectorAll('div,span')].find((x) => x.children.length === 0 && (x.textContent || '').trim() === '模型用量' && x.getBoundingClientRect().x < 320);
  if (!el) return false; el.click(); return true;
});
check('侧栏「资源」下可进入「模型用量」', clicked);
// 等真数据落地再断言（usage 端点要跑 7 条聚合，首屏是「加载中…」）
const t0 = Date.now();
const loaded = await p.waitForFunction(() => /缓存读占比/.test(document.body.innerText), { timeout: 40000 }).then(() => true).catch(() => false);
check('面板在 40s 内出数（记录耗时）', loaded, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
const txt = () => p.evaluate(() => document.body.innerText);
const t1 = await txt();
check('顶栏是「资源 › 模型用量」', /资源\s*›\s*模型用量/.test(t1), t1.split('\n').slice(0, 2).join(' / '));
for (const kw of ['总量', '缓存读占比', '调用次数', '任务运行占比', '推理 tokens', '今日']) check(`摘要卡「${kw}」`, t1.includes(kw));

// 趋势图：只在图表自身的 DOM 范围内判定，避免被别处文本蒙混
const chart = await p.evaluate(() => {
  const svgs = [...document.querySelectorAll('svg')].filter((s) => s.getAttribute('viewBox') === '0 0 900 252');
  const strip = [...document.querySelectorAll('svg')].filter((s) => s.getAttribute('viewBox') === '0 0 900 44');
  return {
    bars: svgs.reduce((a, s) => a + s.querySelectorAll('path').length, 0),
    // 柱顶数值是 textAnchor=middle（y 轴刻度是 end），只认前者，别被刻度蒙混
    topLabels: svgs.flatMap((s) => [...s.querySelectorAll('text[text-anchor="middle"]')]).map((t) => t.textContent ?? '').filter((s) => /(M|k)$/.test(s)),
    stripBars: strip.reduce((a, s) => a + s.querySelectorAll('path').length, 0),
    stripText: strip.flatMap((s) => [...s.querySelectorAll('text')]).map((t) => t.textContent),
    polylines: svgs.reduce((a, s) => a + s.querySelectorAll('polyline').length, 0),
  };
});
check('趋势图有堆叠柱', chart.bars >= 3, `${chart.bars} 段`);
check('柱顶标数值', chart.topLabels.length >= 2, chart.topLabels.slice(0, 5).join(' '));
check('调用次数是独立细带（不是横穿柱子的折线）', chart.stripBars >= 1 && chart.polylines === 0, `细带 ${chart.stripBars} 根 · ${chart.stripText.join('/')}`);

// 切换：30 日 / 调用次数
// 药丸按钮：正文里也可能出现同样的字（如「合计 … tokens」），按 cursor:pointer + 圆角认准控件本身
const clickPill = async (label) => p.evaluate((l) => {
  const el = [...document.querySelectorAll('span')].find((x) => x.children.length === 0 && (x.textContent || '').trim() === l
    && getComputedStyle(x).cursor === 'pointer' && x.getBoundingClientRect().x > 300);
  if (!el) return false; el.click(); return true;
}, label);
check('切到近 30 日', await clickPill('近 30 日'));
// 窗口真的换了：小标题里的「近 N 日」跟着数据一起变（不是按钮自身的文字）
const w30 = await p.waitForFunction(() => /近 30 日 · 每次请求/.test(document.body.innerText), { timeout: 30000 }).then(() => true).catch(() => false);
check('30 日窗口生效（数据跟着重取）', w30);
check('切到调用次数口径', await clickPill('调用次数')); await sleep(1200);
const noStrip = await p.evaluate(() => [...document.querySelectorAll('svg')].filter((s) => s.getAttribute('viewBox') === '0 0 900 44').length);
check('调用次数口径下细带自动隐藏（避免重复表达）', noStrip === 0);
check('切回 tokens 口径', await clickPill('tokens')); await sleep(600);
check('切回 tokens 后细带回来', (await p.evaluate(() => [...document.querySelectorAll('svg')].filter((s) => s.getAttribute('viewBox') === '0 0 900 44').length)) === 1);
check('切回近 7 日', await clickPill('近 7 日'));
await p.waitForFunction(() => /近 7 日 · 每次请求/.test(document.body.innerText), { timeout: 30000 }).catch(() => {});
await sleep(800);

const t2 = await txt();
check('用量构成（按来源 / 按模型）', t2.includes('用量构成') && t2.includes('按来源') && t2.includes('按模型') && /任务运行|人工会话/.test(t2));
check('单次调用规模分布', t2.includes('单次调用规模') && /10-30k|10–30k/.test(t2));
const top = await p.evaluate(() => {
  const table = [...document.querySelectorAll('table')].find((t) => /会话[\s\S]*tokens/.test(t.textContent ?? ''));
  return { rows: table === undefined ? 0 : table.querySelectorAll('tbody tr').length, hasOpen: /打开会话/.test(table?.textContent ?? '') };
});
check('Top 会话表有行且可打开会话', top.rows > 0 && top.hasOpen, `${top.rows} 行`);
check('口径说明写明缓存读来自模型 API', /prompt_cache_hit_tokens|cached_tokens/.test(t2));
await p.screenshot({ path: OUT, fullPage: true });
check('console/page 零错误', errs.length === 0, errs.slice(0, 2).join(' | '));

const ok = checks.every(Boolean);
console.log('截图', OUT);
console.log(ok ? 'PASS' : 'FAIL', `${checks.filter(Boolean).length}/${checks.length}`);
await p.close(); await b.disconnect();
process.exit(ok ? 0 : 1);
