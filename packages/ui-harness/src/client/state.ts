/** Tiny external store shared between HarnessSidebar and HarnessMain (same plugin). */

export type HarnessView = 'chat' | 'tasks' | 'databases' | 'resources' | 'newAgent';

export interface HarnessState {
  view: HarnessView;
  agentId: string;      // '' = not resolved yet
  agentName: string;
  /** 侧栏树中选中的条目（user 定案：会话/任务/数据库分区下挂列表，点条目直达） */
  selectedTaskId: string;
  selectedNodeId: string;
  /**
   * 任务页要展示的那次运行（''=最新）。由「历史」tab 的「看报告 →」写入，
   * 任务面板据此定位到那一次的完整大盘——2026-08-24 user 报障：跑过多次后
   * 历史里只有一张表，点不进任何一次的详细大盘。
   */
  selectedRunId: string;
  /** 侧栏右缘 px —— 主区页面贴齐它渲染（侧栏收展实时跟随），不盖侧栏。 */
  sidebarRight: number;
}

let state: HarnessState = { view: 'chat', agentId: '', agentName: '', selectedTaskId: '', selectedNodeId: '', selectedRunId: '', sidebarRight: 260 };
const listeners = new Set<() => void>();

export function getState(): HarnessState {
  return state;
}

export function setState(patch: Partial<HarnessState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * 任务面板注册表（任务契约的前端半边：不同任务对应不同插件，插件自带 UI 面板，
 * 统一渲染在主区任务框架内，绝不单开页面）。
 */
// runId 是可选契约：面板可据它定位到指定那次运行的报告（''/缺省 = 最新）。
// 老面板不读这个字段也不受影响——多传一个 prop 而已。
export type TaskPanelComponent = (props: { task: any; runId?: string; call: (endpoint: string, payload?: unknown) => Promise<any> }) => any;
const taskPanels = new Map<string, TaskPanelComponent>();

export function registerTaskPanel(typeKey: string, component: TaskPanelComponent): () => void {
  taskPanels.set(typeKey, component);
  for (const fn of listeners) fn();
  return () => { taskPanels.delete(typeKey); };
}

export function getTaskPanel(typeKey: string): TaskPanelComponent | undefined {
  return taskPanels.get(typeKey);
}

/**
 * 跨 client 插件桥：任务类型插件的 client 半边经 window 注册面板。
 *
 * 真·与加载顺序无关（2026-08-24 user 报障根因）：各任务插件原先靠 250ms×40 轮询等这个
 * 桥出现，超过 10 秒就永久放弃 → 面板注册不上 → 任务页掉回 DefaultTaskPanel（只有一张
 * 4 列表，没有任何进大盘的入口）。ui-harness 与任务插件是并发加载的，谁先到不确定，
 * 慢机器上必然复现。改为双向排队：谁先到谁建桥，晚到的一方消费对方留下的 __pending。
 */
/** 排队项：三类面板共用一条队列，kind 决定兑现时调哪个 register。 */
export type PendingPanel = { kind: 'task' | 'resource' | 'node'; key?: string; comp: any };

declare global {
  interface Window {
    __opendbHarness__?: {
      registerTaskPanel?: typeof registerTaskPanel;
      __pending?: PendingPanel[];
      [k: string]: unknown;
    };
  }
}

/** 全局资源大盘面板（platform-status 插件的 client 半边注册，单一）。 */
export type ResourcePanelComponent = () => any;
let resourcePanel: ResourcePanelComponent | undefined;
export function registerResourcePanel(panel: ResourcePanelComponent): () => void {
  resourcePanel = panel;
  for (const fn of listeners) fn();
  return () => { resourcePanel = undefined; };
}
export function getResourcePanel(): ResourcePanelComponent | undefined { return resourcePanel; }

/** 节点监控详情面板（ui-node-monitor 插件注册；W6 拆包——ui-harness 内置实现降级备用）。 */
export type NodePanelComponent = (props: { nodeId: string }) => any;
let nodePanel: NodePanelComponent | undefined;
export function registerNodePanel(panel: NodePanelComponent): () => void {
  nodePanel = panel;
  for (const fn of listeners) fn();
  return () => { nodePanel = undefined; };
}
export function getNodePanel(): NodePanelComponent | undefined { return nodePanel; }

// ── 建桥 + 兑现排队（放在三个 register 都定义完之后）───────────────────────────
// 先到的插件可能已经建了个只有 __pending 的占位对象，这里合并它并把队列一次性兑现。
if (typeof window !== 'undefined') {
  const prior = window.__opendbHarness__;
  const queued: PendingPanel[] = Array.isArray(prior?.__pending) ? prior.__pending : [];
  window.__opendbHarness__ = {
    ...(prior ?? {}),
    registerTaskPanel, registerResourcePanel, registerNodePanel,
    __pending: [],
  };
  for (const p of queued) {
    if (p.kind === 'task' && typeof p.key === 'string') registerTaskPanel(p.key, p.comp);
    else if (p.kind === 'resource') registerResourcePanel(p.comp);
    else if (p.kind === 'node') registerNodePanel(p.comp);
  }
}
