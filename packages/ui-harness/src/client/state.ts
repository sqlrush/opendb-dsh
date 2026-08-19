/** Tiny external store shared between HarnessSidebar and HarnessMain (same plugin). */

export type HarnessView = 'chat' | 'tasks' | 'databases' | 'resources' | 'newAgent';

export interface HarnessState {
  view: HarnessView;
  agentId: string;      // '' = not resolved yet
  agentName: string;
  /** 侧栏树中选中的条目（user 定案：会话/任务/数据库分区下挂列表，点条目直达） */
  selectedTaskId: string;
  selectedNodeId: string;
  /** 侧栏右缘 px —— 主区页面贴齐它渲染（侧栏收展实时跟随），不盖侧栏。 */
  sidebarRight: number;
}

let state: HarnessState = { view: 'chat', agentId: '', agentName: '', selectedTaskId: '', selectedNodeId: '', sidebarRight: 260 };
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
export type TaskPanelComponent = (props: { task: any; call: (endpoint: string, payload?: unknown) => Promise<any> }) => any;
const taskPanels = new Map<string, TaskPanelComponent>();

export function registerTaskPanel(typeKey: string, component: TaskPanelComponent): () => void {
  taskPanels.set(typeKey, component);
  for (const fn of listeners) fn();
  return () => { taskPanels.delete(typeKey); };
}

export function getTaskPanel(typeKey: string): TaskPanelComponent | undefined {
  return taskPanels.get(typeKey);
}

// ── 跨 client 插件桥：任务类型插件的 client 半边经 window 注册面板（与加载顺序无关）──
declare global { interface Window { __opendbHarness__?: { registerTaskPanel: typeof registerTaskPanel } } }
if (typeof window !== 'undefined') {
  window.__opendbHarness__ = { registerTaskPanel };
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
if (typeof window !== 'undefined' && window.__opendbHarness__ !== undefined) {
  (window.__opendbHarness__ as any).registerResourcePanel = registerResourcePanel;
}

/** 节点监控详情面板（ui-node-monitor 插件注册；W6 拆包——ui-harness 内置实现降级备用）。 */
export type NodePanelComponent = (props: { nodeId: string }) => any;
let nodePanel: NodePanelComponent | undefined;
export function registerNodePanel(panel: NodePanelComponent): () => void {
  nodePanel = panel;
  for (const fn of listeners) fn();
  return () => { nodePanel = undefined; };
}
export function getNodePanel(): NodePanelComponent | undefined { return nodePanel; }
if (typeof window !== 'undefined' && window.__opendbHarness__ !== undefined) {
  (window.__opendbHarness__ as any).registerNodePanel = registerNodePanel;
}
