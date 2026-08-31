// 资源 › k8s 集群状态 的浏览器级验收（mac 无头 Chrome，CDP 9333）：
//   ① 侧栏「资源」是与「工作区」同款的一级小节头，下挂「k8s 集群状态」；② 点进去出架构图（k8s 边界框 + Pod 全量 + 调用连线 + 框外舰队）；
//   ③ 点 Pod 出右侧详情（资源/运行信息/部署）；④ 节点视图与事件页可切；⑤ console 零错误。
//   OUT=/tmp/cluster.png node scripts/browser/cluster-check.mjs
import puppeteer from 'puppeteer-core';
const BASE = process.env.OPENDB_URL ?? 'http://127.0.0.1:18080';
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const OUT = process.env.OUT ?? '/tmp/cluster.png';
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

// ① 侧栏：资源一级小节头 + 子项
const side = await p.evaluate(() => {
  const inSidebar = (x) => x.getBoundingClientRect().x < 320;
  const titles = [...document.querySelectorAll('div,span')].filter((x) => x.children.length === 0 && inSidebar(x)).map((x) => (x.textContent || '').trim());
  return { hasGroup: titles.includes('资源'), hasWorkspace: titles.includes('工作区'), hasItem: titles.includes('k8s 集群状态') };
});
check('侧栏「资源」是一级小节头（与「工作区」同级）', side.hasGroup && side.hasWorkspace, JSON.stringify(side));
check('资源下挂「k8s 集群状态」子项', side.hasItem);

// ② 进页面
const clicked = await p.evaluate(() => {
  const el = [...document.querySelectorAll('div,span')].find((x) => x.children.length === 0 && (x.textContent || '').trim() === 'k8s 集群状态' && x.getBoundingClientRect().x < 320);
  if (!el) return false; el.click(); return true;
});
check('点子项进入页面', clicked);
await sleep(6000);
const txt = () => p.evaluate(() => document.body.innerText);
const t1 = await txt();
check('页头与顶栏正确', /资源\s*›\s*k8s 集群状态/.test(t1) || t1.includes('k8s 集群状态'), t1.split('\n').slice(0, 3).join(' / '));
for (const kw of ['k8s 节点', 'Pod', '集群 CPU', '集群内存', '被管数据库']) check(`摘要卡「${kw}」`, t1.includes(kw));

// ③ 架构图：k8s 边界框 + Pod 全量 + 连线 + 舰队
// 只在架构图自身的 DOM 范围内判定——用整页文本/全局选择器会被别的页面内容（图表刻度、Top SQL 文案）蒙混过关
const arch = await p.evaluate(() => {
  const box = document.querySelector('[data-pod]')?.closest('div[style*="C9D6F2"]')
    ?? document.querySelector('[data-pod]')?.parentElement?.parentElement?.parentElement;
  const svgs = box === null || box === undefined ? [] : [...box.querySelectorAll('svg')];
  return {
    pods: document.querySelectorAll('[data-pod]').length,
    wires: svgs.reduce((a, s) => a + s.querySelectorAll('path[marker-end]').length, 0),
    labels: svgs.flatMap((s) => [...s.querySelectorAll('text')]).map((t) => t.textContent ?? '').filter((s) => s.length > 1),
    fleetPicked: document.querySelectorAll('[data-picked]').length,
    lanes: box === null || box === undefined ? 0 : (box.textContent.match(/控制面|执行面|数据面/g) || []).length,
  };
});
check('k8s 框内 Pod 全量展示', arch.pods >= 8, `${arch.pods} 个 Pod 卡片`);
check('Pod 之间画出调用关系连线（带箭头）', arch.wires >= 8, `${arch.wires} 条`);
check('连线带关系标注', arch.labels.some((s) => /派发|采集|队列|存档/.test(s)), arch.labels.join(' | ').slice(0, 120));
check('三层泳道齐全', arch.lanes >= 3);
check('框外被管数据库有选中项（与集群连线）', arch.fleetPicked === 1);
check('架构图含被管数据库区块', t1.includes('被管数据库') && (t1.includes('只读连接') || t1.includes('一格 = 一个被管节点')));

// ④ 点 Pod 出详情
const podClicked = await p.evaluate(() => { const el = document.querySelector('[data-pod]'); if (!el) return false; el.click(); return true; });
await sleep(900);
const t2 = await txt();
check('点 Pod 出右侧详情（资源 / 运行信息 / 部署）', podClicked && t2.includes('运行信息') && t2.includes('部署') && /limit|无 limit/.test(t2));
await p.screenshot({ path: OUT });

// ⑤ 节点视图 / 事件
const tabTo = async (label) => p.evaluate((l) => { const el = [...document.querySelectorAll('span')].find((x) => x.children.length === 0 && (x.textContent || '').trim() === l && x.getBoundingClientRect().x > 300); if (!el) return false; el.click(); return true; }, label);
check('切到节点视图', await tabTo('节点视图')); await sleep(1200);
const t3 = await txt();
check('节点视图列出 k8s 节点与承载 Pod', /k8s-(cp|w1|w2|w3)/.test(t3) && t3.includes('承载'), (t3.match(/k8s-\w+/g) || []).slice(0, 4).join(' '));
await p.screenshot({ path: OUT.replace(/\.png$/, '-node.png') });
check('切到事件', await tabTo('事件')); await sleep(1200);
// 同样只看事件表本身：整页文本里 Top SQL 的正文也含 "Killing/Started" 之类词，会假阳性
const ev = await p.evaluate(() => {
  const table = [...document.querySelectorAll('table')].find((t) => /时间[\s\S]*原因/.test(t.textContent ?? ''));
  if (table === undefined) return { rows: 0, text: document.body.innerText.includes('没有集群事件') || document.body.innerText.includes('事件不可读') ? 'degraded' : '' };
  return { rows: table.querySelectorAll('tbody tr').length, text: (table.textContent ?? '').slice(0, 120) };
});
check('事件页是真的事件表或如实降级', ev.rows > 0 || ev.text === 'degraded', ev.rows > 0 ? `${ev.rows} 行 · ${ev.text.replace(/\s+/g, ' ').slice(0, 70)}` : ev.text);
await p.screenshot({ path: OUT.replace(/\.png$/, '-event.png') });

check('console/page 零错误', errs.length === 0, errs.slice(0, 2).join(' | '));
const ok = checks.every(Boolean);
console.log('截图', OUT);
console.log(ok ? 'PASS' : 'FAIL', `${checks.filter(Boolean).length}/${checks.length}`);
await p.close(); await b.disconnect();
process.exit(ok ? 0 : 1);
