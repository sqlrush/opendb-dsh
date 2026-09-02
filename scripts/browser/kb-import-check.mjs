// 知识库导入工具端到端（mac 无头 Chrome，CDP 9333）：
//   投喂一份样例规范 → 分析并导入（真实走会话让模型调 kb_import）→ 人审采纳 → 确认入库 →
//   回大盘断言强类型边 > 0、文档数增加。证明 P2 全链路。
//   node scripts/browser/kb-import-check.mjs
import puppeteer from 'puppeteer-core';
const BASE = process.env.OPENDB_URL ?? 'http://127.0.0.1:18080';
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const OUT = process.env.OUT ?? '/tmp/kb-import.png';
setTimeout(() => { console.log("WATCHDOG"); process.exit(2); }, 380000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, extra = '') => { checks.push(ok); console.log(`${ok ? '✔' : '✖'} ${name}${extra ? ` — ${extra}` : ''}`); return ok; };
const MATERIAL = [
  '工行 openGauss 变更管理规范（节选）',
  '1. DDL 变更必须在 23:00–06:00 低峰窗口执行，且须提交变更单、双人复核。',
  '2. 全量 SQL 追踪（statement_history）仅允许在诊断窗口开启；诊断结束后须关闭并重建，防止系统表膨胀。',
  '3. 核心库出现锁等待导致交易超时时，处置流程为：先定位并杀掉阻塞会话，再把批量作业迁移到低峰窗口执行。',
].join('\n');

const b = await puppeteer.connect({ browserURL: CDP, defaultViewport: { width: 1500, height: 1000 } });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror:' + String(e).slice(0, 200)));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console:' + m.text().slice(0, 200)); });
await p.goto(`${BASE}/?v=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await sleep(9000);
await p.evaluate(() => { const el = [...document.querySelectorAll('button,div,span')].find((x) => x.children.length === 0 && /^(继续|我知道了|同意)$/.test((x.textContent || '').trim())); el?.click(); });
await sleep(1200);

check('侧栏「导入知识」可进', await p.evaluate(() => {
  const el = [...document.querySelectorAll('div,span')].find((x) => x.children.length === 0 && (x.textContent || '').trim() === '导入知识' && x.getBoundingClientRect().x < 320);
  if (!el) return false; el.click(); return true;
}));
check('向导出现（分析并导入按钮）', await p.waitForFunction(() => /分析并导入/.test(document.body.innerText), { timeout: 30000 }).then(() => true).catch(() => false));
await sleep(500);

// 填标题 + 正文——必须真实键入，且要选中「向导自己的」输入框（页面还有聊天框 textarea，别填错）
const titleH = await p.evaluateHandle(() => [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes('材料标题')));
await titleH.asElement().click();
await p.keyboard.type('工行 openGauss 变更管理规范 v3');
const taH = await p.evaluateHandle(() => [...document.querySelectorAll('textarea')].find((t) => (t.placeholder || '').includes('粘贴材料正文')));
await taH.asElement().click();
await p.keyboard.type(MATERIAL);
await sleep(300);
check('已填标题与正文', await p.evaluate(() => [...document.querySelectorAll('textarea')].some((t) => (t.value ?? '').includes('锁等待'))));

// 分析并导入：向量线服务端确定性入库（秒级到人审），图线由模型 best-effort 抽候选
await p.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /分析并导入/.test(x.textContent || '')); b?.click(); });
console.log('已触发；向量线服务端入库应秒级进人审，图线等模型抽取（最多 ~130s）…');
const reviewed = await p.waitForFunction(() => /人审：图候选关系/.test(document.body.innerText), { timeout: 40000 }).then(() => true).catch(() => false);
check('进入人审阶段（向量线已确定性入库）', reviewed);
const headerOk = await p.waitForFunction(() => /向量\s*\d+\s*段已入库/.test(document.body.innerText), { timeout: 8000 }).then(() => true).catch(() => false);
check('显示向量段数已入库', headerOk, (await p.evaluate(() => (document.body.innerText.match(/向量\s*\d+\s*段已入库/) || [''])[0])));
// 图候选边由模型异步写入，轮询等它出现（模型延迟可达 ~3min）
let rowCount = 0;
for (let i = 0; i < 70; i += 1) {
  // 只数真实候选边行（≥3 个单元格）——排除「未抽出关系候选」占位行（单 colspan 格）
  rowCount = await p.evaluate(() => { const tb = [...document.querySelectorAll('table')].find((t) => /候选关系/.test(t.textContent ?? '')); return tb ? [...tb.querySelectorAll('tbody tr')].filter((r) => r.querySelectorAll('td').length >= 3).length : 0; });
  if (rowCount >= 1) break;
  await sleep(3000);
}
check('图候选关系已抽出（≥1 条）', rowCount >= 1, `${rowCount} 条`);

// 人审默认纳入——直接确认入库（把全部未否决的候选写进强类型图）
await sleep(2500);
console.log('DIAG:', await p.evaluate(() => JSON.stringify({
  buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim().slice(0, 20)),
  hasReview: /人审：图候选关系/.test(document.body.innerText),
  hasCommitText: /确认入库/.test(document.body.innerText),
  tables: document.querySelectorAll('table').length,
})));
await p.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /确认入库/.test(x.textContent || '')); b?.click(); });
const committed = await p.waitForFunction(() => /条关系进入确定性图/.test(document.body.innerText), { timeout: 45000 }).then(() => true).catch(() => false);
console.log('提交后 msg:', await p.evaluate(() => (document.body.innerText.match(/已入库：[^\n]*/) || ['(无)'])[0]));
check('确认入库成功（写入强类型图）', committed, (await p.evaluate(() => (document.body.innerText.match(/已入库：[^\n]*/) || [''])[0])));
await p.screenshot({ path: OUT, fullPage: true });

// 回大盘核对
await p.evaluate(() => { const el = [...document.querySelectorAll('div,span')].find((x) => x.children.length === 0 && (x.textContent || '').trim() === '知识库大盘' && x.getBoundingClientRect().x < 320); el?.click(); });
await p.waitForFunction(() => /三类知识/.test(document.body.innerText), { timeout: 40000 }).catch(() => {});
await sleep(1500);
const dash = await p.evaluate(() => document.body.innerText);
check('大盘：强类型边（已入图）> 0', /强类型边（已入图）\s*[1-9]\d*\s*条/.test(dash), (dash.match(/强类型边（已入图）[^\n]*/) || [''])[0]);
check('大盘：向量文档数增加（≥3）', /(\d+)\s*文档/.test(dash) && Number((dash.match(/(\d+)\s*文档/) || [0, 0])[1]) >= 3, (dash.match(/\d+\s*文档[^\n]*/) || [''])[0]);

check('console/page 零错误', errs.length === 0, errs.slice(0, 2).join(' | '));
const ok = checks.every(Boolean);
console.log('截图', OUT);
console.log(ok ? 'PASS' : 'FAIL', `${checks.filter(Boolean).length}/${checks.length}`);
await p.close(); await b.disconnect();
process.exit(ok ? 0 : 1);
