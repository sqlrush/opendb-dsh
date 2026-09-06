// 开着的页签必须扛住 ui-harness 热更（mac 无头 Chrome，CDP 9333）：
//   打开页面 → 任务页/资源页是专属面板 → 往 host pod 热更一份内容有变的 ui-harness/client.js（追加注释）
//   → dsh 客户端重新执行 ui-harness 模块 → 再看同一页签：任务页仍是专属面板、资源页仍有内容。
//   node scripts/browser/hmr-survive-check.mjs        # 需要 kubectl 上下文 opendb-dsh
// 背景（2026-09-05）："报告变成历史列表"第四种成因——ui-harness 模块被热重载后模块级注册表清空，
//   各任务插件不会重新注册；新开页面正常、开着的页签坏。修法见 ui-harness state.ts 的 registries()。
import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
const BASE = process.env.OPENDB_URL ?? 'http://127.0.0.1:18080';
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const TASK = process.env.TASK ?? 'og5-capacity';
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 200000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, extra = '') => { checks.push(ok); console.log(`${ok ? '✔' : '✖'} ${name}${extra ? ` — ${extra}` : ''}`); return ok; };

const b = await puppeteer.connect({ browserURL: CDP, defaultViewport: { width: 1400, height: 900 } });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror:' + String(e).slice(0, 160)));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console:' + m.text().slice(0, 160)); });
const reloads = [];
p.on('response', (r) => { if (/plugins\/@opendb-dsh\/ui-harness\/client\.js/.test(r.url())) reloads.push(r.url().slice(-16)); });
await p.goto(`${BASE}/?v=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await sleep(10000);
for (let i = 0; i < 3; i += 1) {
  const n = await p.evaluate(() => { const bs = [...document.querySelectorAll('button')].filter((x) => /^(继续|我知道了|同意)$/.test((x.textContent || '').trim())); bs.forEach((x) => x.click()); return bs.length; });
  await sleep(800); if (!n) break;
}
const clickSide = (name) => p.evaluate((n) => { const el = [...document.querySelectorAll('div,span,a')].find((x) => (x.textContent || '').trim() === n && x.getBoundingClientRect().x < 320 && x.getBoundingClientRect().width > 0); if (!el) return false; el.click(); return true; }, name);
const taskState = async () => { await clickSide(TASK); await sleep(4000); return p.evaluate(() => { const t = document.body.innerText; return { defaultView: /当前是默认视图|面板插件包没加载上|没有注册出/.test(t), len: t.length }; }); };
const usageState = async () => { await clickSide('模型用量'); await sleep(4000); return p.evaluate(() => ({ len: document.body.innerText.length })); };
const home = async () => { await p.evaluate(() => { const el = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '新会话'); el?.click(); }); await sleep(1500); };

const t0 = await taskState();
check(`热更前 ${TASK} 是专属面板`, !t0.defaultView && t0.len > 1000, `len=${t0.len}`);
const u0 = await usageState();
check('热更前「模型用量」有内容', u0.len > 1200, `len=${u0.len}`);
await home();

// 热更：内容有变（追加注释）才会触发客户端重载。变体文件要在 pod 里**留到检查结束**——
// 立刻恢复的话一秒内又变回原 rev，客户端根本不重载，检查就白跑（首版脚本踩过）。
const HOST_POD = 'HP=$(kubectl -n opendb-dsh get pod -l app=opendb-dsh-host -o name | head -1 | sed "s#pod/##")';
const CP = 'kubectl -n opendb-dsh cp packages/ui-harness/lib/client.js $HP:/app/packages/ui-harness/lib/client.js -c host';
const before = reloads.length;
execSync([
  'cp packages/ui-harness/lib/client.js /tmp/ui-harness.client.js.bak',
  `printf '\\n// hmr-survive-check %s\\n' "$(date +%s)" >> packages/ui-harness/lib/client.js`,
  HOST_POD, CP,
  'cp /tmp/ui-harness.client.js.bak packages/ui-harness/lib/client.js',
].join(' && '), { stdio: 'ignore', shell: '/bin/bash' });
console.log('已热更 ui-harness（变体留在 pod 里），等 30s 让客户端重载模块…');
await sleep(30000);
check('客户端确实重新加载了 ui-harness 模块', reloads.length > before, `reloads=${reloads.length - before}`);

const t1 = await taskState();
check(`热更后同一页签 ${TASK} 仍是专属面板`, !t1.defaultView && t1.len > 1000, `len=${t1.len} defaultView=${t1.defaultView}`);
const u1 = await usageState();
check('热更后同一页签「模型用量」仍有内容', u1.len > 1200, `len=${u1.len}`);
check('console/page 零错误', errs.length === 0, errs.slice(0, 2).join(' | '));
// 恢复 pod 里的构建产物
execSync([HOST_POD, CP].join(' && '), { stdio: 'ignore', shell: '/bin/bash' });
console.log('pod 里的 ui-harness/client.js 已恢复为构建产物');
const ok = checks.every(Boolean);
console.log(ok ? 'PASS' : 'FAIL', `${checks.filter(Boolean).length}/${checks.length}`);
await p.close(); await b.disconnect();
process.exit(ok ? 0 : 1);
