/** Tiny external store shared between HarnessSidebar and HarnessMain (same plugin). */

export type HarnessView = 'chat' | 'tasks' | 'databases' | 'resources';

export interface HarnessState {
  view: HarnessView;
  agentId: string;      // '' = not resolved yet
  agentName: string;
  /** 侧栏右缘 px —— 主区页面贴齐它渲染（侧栏收展实时跟随），不盖侧栏。 */
  sidebarRight: number;
}

let state: HarnessState = { view: 'chat', agentId: '', agentName: '', sidebarRight: 260 };
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
 * 任务面板注册表（任务契约的前端半边，user 定案：不同任务对应不同插件，
 * 插件自带 UI 面板，统一渲染在主区任务框架内，绝不单开页面）。
 * 未来任务类型插件的 client 半边调用 registerTaskPanel(typeKey, Component)。
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
