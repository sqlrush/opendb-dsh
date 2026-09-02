/** Tiny external store shared between HarnessSidebar and HarnessMain (same plugin). */

export type HarnessView = 'chat' | 'tasks' | 'databases' | 'resources' | 'knowledge' | 'newAgent';

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
  /** 资源页当前子项（侧栏「资源」分组下选中的那一项）：cluster / usage。 */
  resourceKey: string;
  /** 知识库页当前子项（侧栏「知识库」分组下选中的那一项）：dashboard（P2 增 import）。 */
  knowledgeKey: string;
  /** 侧栏右缘 px —— 主区页面贴齐它渲染（侧栏收展实时跟随），不盖侧栏。 */
  sidebarRight: number;
}

let state: HarnessState = { view: 'chat', agentId: '', agentName: '', selectedTaskId: '', selectedNodeId: '', selectedRunId: '', resourceKey: 'cluster', knowledgeKey: 'dashboard', sidebarRight: 260 };
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
export type PendingPanel = { kind: 'task' | 'resource' | 'node' | 'knowledge'; key?: string; comp: any };

declare global {
  interface Window {
    __opendbHarness__?: {
      registerTaskPanel?: typeof registerTaskPanel;
      registerKnowledgePanel?: typeof registerKnowledgePanel;
      __pending?: PendingPanel[];
      [k: string]: unknown;
    };
  }
}

/**
 * 资源页面板（2026-08-31 起按 key 多面板）：侧栏「资源」是一级分组，下面每一项对应一个 key
 * （cluster = k8s 集群状态，usage = 模型用量…）。不带 key 注册的沿用旧语义 = 'usage'，
 * 这样 platform-status 老版本不改也能继续挂上。
 */
export type ResourcePanelComponent = () => any;
export const RESOURCE_ITEMS: { key: string; label: string }[] = [
  { key: 'cluster', label: 'k8s 集群状态' },
  { key: 'usage', label: '模型用量' },
];
const resourcePanels = new Map<string, ResourcePanelComponent>();
export function registerResourcePanel(panel: ResourcePanelComponent, key = 'usage'): () => void {
  resourcePanels.set(key, panel);
  for (const fn of listeners) fn();
  return () => { resourcePanels.delete(key); };
}
export function getResourcePanel(key = 'usage'): ResourcePanelComponent | undefined { return resourcePanels.get(key); }
/** 已注册的资源项（按 RESOURCE_ITEMS 顺序），侧栏据此渲染子项——没有插件注册的项不显示。 */
export function listResourcePanels(): { key: string; label: string }[] {
  return RESOURCE_ITEMS.filter((i) => resourcePanels.has(i.key));
}

/**
 * 知识库页面板（2026-09-01 起，与「资源」同款按 key 多面板）：侧栏「知识库」是与「工作区」「资源」
 * 同级的一级目录，下面每项一个 key（dashboard = 知识库大盘；P2 增 import = 导入知识）。
 * 独立于资源面板注册表——知识库是客户数据资产，比只读资源视图重，单列一级目录（设计 2026-09-01）。
 */
export type KnowledgePanelComponent = () => any;
export const KNOWLEDGE_ITEMS: { key: string; label: string }[] = [
  { key: 'dashboard', label: '知识库大盘' },
  { key: 'import', label: '导入知识' },
];
const knowledgePanels = new Map<string, KnowledgePanelComponent>();
export function registerKnowledgePanel(panel: KnowledgePanelComponent, key = 'dashboard'): () => void {
  knowledgePanels.set(key, panel);
  for (const fn of listeners) fn();
  return () => { knowledgePanels.delete(key); };
}
export function getKnowledgePanel(key = 'dashboard'): KnowledgePanelComponent | undefined { return knowledgePanels.get(key); }
export function listKnowledgePanels(): { key: string; label: string }[] {
  return KNOWLEDGE_ITEMS.filter((i) => knowledgePanels.has(i.key));
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

// ── 建桥 + 兑现排队（放在三个 register 都定义完之后）───────────────────────────
// 先到的插件可能已经建了个只有 __pending 的占位对象，这里合并它并把队列一次性兑现。
if (typeof window !== 'undefined') {
  const prior = window.__opendbHarness__;
  const queued: PendingPanel[] = Array.isArray(prior?.__pending) ? prior.__pending : [];
  window.__opendbHarness__ = {
    ...(prior ?? {}),
    registerTaskPanel, registerResourcePanel, registerKnowledgePanel, registerNodePanel,
    __pending: [],
  };
  for (const p of queued) {
    if (p.kind === 'task' && typeof p.key === 'string') registerTaskPanel(p.key, p.comp);
    else if (p.kind === 'resource') registerResourcePanel(p.comp, typeof p.key === 'string' ? p.key : undefined);
    else if (p.kind === 'knowledge') registerKnowledgePanel(p.comp, typeof p.key === 'string' ? p.key : undefined);
    else if (p.kind === 'node') registerNodePanel(p.comp);
  }
}
