// 「在会话里深挖」行为测试（mac 无头 Chrome，CDP 9333）：真实点击任务页上的深挖链接 →
//   ① 视图切到会话、② PG 里出现新会话且首条用户消息以 PREFIX 开头（默认「【Top SQL 深挖】」）。
//   TASK="og5慢SQL Top5报表" node scripts/browser/dig-click-check.mjs   （跑完删掉它建的测试会话，KEEP=1 保留）
import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
const BASE = process.env.OPENDB_URL ?? 'http://127.0.0.1:18080';
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const TASK = process.env.TASK ?? '';
const LABEL = process.env.LABEL ?? '在会话里深挖';
const PREFIX = process.env.PREFIX ?? '【Top SQL 深挖】';
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 600000);   // 深挖那一轮模型要跑几分钟，清理前要等 turn/end
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin` } }).trim();
const psql = (sql) => sh(`kubectl -n opendb-dsh exec pod/opendb-dsh-postgres-0 -- psql -U dsh -d dsh -Atc "${sql.replace(/"/g, '\\"')}"`);
const before = new Set(psql('SELECT id FROM dsh_sessions').split('\n').filter(Boolean));

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
// 真实鼠标：把第一个深挖链接滚到视口内，取坐标点击
const box = await p.evaluate((label) => {
  const btn = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim().startsWith(label));
  if (!btn) return null;
  btn.scrollIntoView({ block: 'center' });
  const r = btn.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (btn.textContent || '').trim(), fontSize: getComputedStyle(btn).fontSize, color: getComputedStyle(btn).color, border: getComputedStyle(btn).borderStyle, bg: getComputedStyle(btn).backgroundColor };
}, LABEL);
console.log('task clicked', clicked, 'link', JSON.stringify(box));
if (!box) { console.log('FAIL 没找到深挖链接'); process.exit(1); }
await sleep(400);
await p.mouse.move(box.x, box.y, { steps: 8 });
await p.mouse.click(box.x, box.y);
let created = [];
for (let i = 0; i < 20; i += 1) {
  await sleep(1500);
  const now = psql('SELECT id FROM dsh_sessions').split('\n').filter(Boolean);
  created = now.filter((id) => !before.has(id));
  if (created.length > 0) break;
}
const inChat = await p.evaluate(() => !!document.querySelector('textarea'));
const linkAfter = await p.evaluate((label) => {
  const btn = [...document.querySelectorAll('button')].find((x) => /开会话中|失败，重试/.test(x.textContent || '') || (x.textContent || '').trim().startsWith(label));
  return btn ? (btn.textContent || '').trim() : '(链接已随任务页卸载)';
}, LABEL);
console.log(/失败/.test(linkAfter) ? '✖' : '✔', '点击后链接状态', linkAfter);
let firstUser = '';
if (created[0]) {
  for (let i = 0; i < 10 && firstUser === ''; i += 1) {
    firstUser = psql(`SELECT left(regexp_replace(coalesce(data->'content'->0->>'text', data::text), chr(10), ' ', 'g'), 160) FROM dsh_session_events WHERE session_id = '${created[0]}' AND type = 'user/message' ORDER BY seq LIMIT 1`);
    if (firstUser === '') await sleep(1500);
  }
}
const okStyle = box.fontSize === '12.5px' && box.border === 'none' && /rgba?\(0, 0, 0, 0\)|transparent/.test(box.bg) && /65, 118, 230/.test(box.color);
console.log(okStyle ? '✔' : '✖', '链接样式与监控面板一致（12.5px · 蓝 #4176E6 · 无边框 · 无底色）');
console.log(created.length === 1 ? '✔' : '✖', '点击后新建了 1 个会话', created.join(','));
console.log(inChat ? '✔' : '✖', '视图切到了会话（出现输入框）');
console.log(firstUser.includes(PREFIX) ? '✔' : '✖', `首条用户消息以「${PREFIX}」开头`, firstUser.slice(0, 120));
console.log('errors', errs.length ? errs : '无');
await p.close(); await b.disconnect();
const ok = okStyle && created.length === 1 && inChat && firstUser.includes(PREFIX) && errs.length === 0 && !/失败/.test(linkAfter);
if (!process.env.KEEP && created[0]) {
  // 等这一轮跑完再删（Runtime 还在写日志时删行会让它报错）
  for (let i = 0; i < 80; i += 1) {
    const ended = psql(`SELECT count(*) FROM dsh_session_events WHERE session_id = '${created[0]}' AND type = 'turn/end'`);
    if (Number(ended) >= 1) break;
    await sleep(3000);
  }
  try {
    for (const t of ['dsh_questions', 'dsh_thread_queue', 'dsh_threads', 'dsh_session_events']) psql(`DELETE FROM ${t} WHERE session_id = '${created[0]}'`);
    psql(`DELETE FROM dsh_sessions WHERE id = '${created[0]}'`); console.log('测试会话已删除');
  } catch (e) { console.log('清理失败:', String(e.message).slice(0, 100)); }
}
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
