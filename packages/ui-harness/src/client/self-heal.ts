/**
 * 面板自愈（2026-09-06 立，user 两次报障「任务和资源的大盘报表又没了」后的根治）。
 *
 * 事实（scripts/browser/selfheal-check.mjs 可复现）：页面在后端抖动窗口里加载或重连时（滚动更新 / k8s 重启 /
 * Host 崩溃重启），个别插件 client.js 拉不到，dsh client-modules **不会重试**——注册表就永久缺项：
 * 任务页空白或退回默认视图、侧栏「资源」项消失，直到人工刷新。
 *
 * 做法：按本页启动清单（window.__DSH_BOOT__.entries，页面加载时 Host 下发的插件列表）算出"应有的面板提供方"，
 * 与注册表比对；缺了且后端已恢复（首页可达且含启动清单），就整页重载一次自愈。
 * 触发时机：加载后 20s / 60s / 150s，页签重新可见、网络恢复时；5 分钟内最多重载一次，防循环。
 */
import { getKnowledgePanel, getResourcePanel, listTaskPanels } from './state.ts';

const CHECK_DELAYS_MS: readonly number[] = [20_000, 60_000, 150_000];
const VISIBLE_CHECK_DELAY_MS = 3_000;
const MIN_PAGE_AGE_MS = 20_000;
const RELOAD_COOLDOWN_MS = 5 * 60_000;
const RELOAD_STAMP_KEY = 'opendb-harness.selfheal.reloadAt';
const TASK_PKG_PREFIX = '@opendb-dsh/task-';
const RESOURCE_PROVIDERS: Readonly<Record<string, string>> = {
  '@opendb-dsh/platform-status': 'usage',
  '@opendb-dsh/ui-cluster': 'cluster',
};
const KNOWLEDGE_PROVIDERS: Readonly<Record<string, string>> = { '@opendb-dsh/ui-kb': 'dashboard' };

export type Expected = { tasks: number; resourceKeys: readonly string[]; knowledgeKeys: readonly string[] };
export type SelfHealOutcome = 'ok' | 'reloading' | 'blocked' | 'host-down' | 'too-early';

/** 本页启动时 Host 下发的插件 id 列表（dsh 把清单内联在 HTML 里，没有独立的 plugins.json）。 */
function bootEntryIds(): readonly string[] {
  const boot = (window as unknown as { __DSH_BOOT__?: { entries?: unknown } }).__DSH_BOOT__;
  const entries = boot?.entries;
  if (!Array.isArray(entries)) return [];
  return entries
    .map((e) => (typeof (e as { id?: unknown })?.id === 'string' ? String((e as { id: string }).id) : ''))
    .filter((id) => id !== '');
}

export function expectedPanels(ids: readonly string[]): Expected {
  return {
    tasks: ids.filter((id) => id.startsWith(TASK_PKG_PREFIX)).length,
    resourceKeys: ids.map((id) => RESOURCE_PROVIDERS[id]).filter((k): k is string => k !== undefined),
    knowledgeKeys: ids.map((id) => KNOWLEDGE_PROVIDERS[id]).filter((k): k is string => k !== undefined),
  };
}

/** 应有但未注册的面板；空数组 = 齐全。 */
export function missingPanels(exp: Expected): string[] {
  const registered = listTaskPanels().length;
  return [
    ...(registered < exp.tasks ? [`task:${registered}/${exp.tasks}`] : []),
    ...exp.resourceKeys.filter((k) => getResourcePanel(k) === undefined).map((k) => `resource:${k}`),
    ...exp.knowledgeKeys.filter((k) => getKnowledgePanel(k) === undefined).map((k) => `knowledge:${k}`),
  ];
}

/** 后端是否已恢复：首页可达且带启动清单（Host 崩溃重启 / 滚动窗口里会 502 或空页）。 */
async function hostHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`/?selfheal=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return false;
    return (await res.text()).includes('__DSH_BOOT__');
  } catch { return false; }
}

function lastReloadAt(): number {
  try { const v = Number(sessionStorage.getItem(RELOAD_STAMP_KEY) ?? '0'); return Number.isFinite(v) ? v : 0; } catch { return 0; }
}
function stampReload(now: number): void {
  try { sessionStorage.setItem(RELOAD_STAMP_KEY, String(now)); } catch { /* 没有 sessionStorage 也照样重载 */ }
}

/** 核对一次；缺面板且后端已恢复 → 整页重载。返回结果便于诊断脚本断言。 */
export async function selfHealCheck(reason: string): Promise<SelfHealOutcome> {
  if (performance.now() < MIN_PAGE_AGE_MS) return 'too-early';   // 插件还在正常加载中，别误判
  const missing = missingPanels(expectedPanels(bootEntryIds()));
  if (missing.length === 0) return 'ok';
  if (!(await hostHealthy())) return 'host-down';   // 后端还没起来，重载也白搭，等下一次核对
  const now = Date.now();
  if (now - lastReloadAt() < RELOAD_COOLDOWN_MS) {
    console.warn(`[opendb-harness] 面板缺失 ${missing.join(', ')}（${reason}）：5 分钟内已自动重载过，不再重载，请手动刷新`);
    return 'blocked';
  }
  console.warn(`[opendb-harness] 面板缺失 ${missing.join(', ')}（${reason}），后端已恢复，整页重载自愈`);
  stampReload(now);
  window.location.reload();
  return 'reloading';
}

/** 启动自愈定时器与事件钩子；返回停止函数（模块热重载时由 ctx.effect 清理，避免重复挂钩）。 */
export function startSelfHeal(): () => void {
  const timers = CHECK_DELAYS_MS.map((ms) => window.setTimeout(() => { void selfHealCheck(`t+${ms / 1000}s`); }, ms));
  let visibleTimer: number | undefined;
  const onVisibility = (): void => {
    if (document.visibilityState !== 'visible') return;
    window.clearTimeout(visibleTimer);
    visibleTimer = window.setTimeout(() => { void selfHealCheck('页签重新可见'); }, VISIBLE_CHECK_DELAY_MS);
  };
  const onOnline = (): void => { void selfHealCheck('网络恢复'); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);
  // 诊断/验收脚本入口：window.__opendbHarness__.selfHealCheck('manual')
  const bridge = (window as unknown as { __opendbHarness__?: Record<string, unknown> });
  bridge.__opendbHarness__ = bridge.__opendbHarness__ ?? {};
  bridge.__opendbHarness__.selfHealCheck = selfHealCheck;
  return () => {
    timers.forEach((t) => window.clearTimeout(t));
    window.clearTimeout(visibleTimer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onOnline);
  };
}
