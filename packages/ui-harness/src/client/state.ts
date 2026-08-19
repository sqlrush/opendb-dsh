/** Tiny external store shared between HarnessSidebar and HarnessOverlay (same plugin). */

export type HarnessView = 'chat' | 'tasks' | 'databases' | 'resources';

export interface HarnessState {
  view: HarnessView;
  agentId: string;      // '' = not resolved yet
  agentName: string;
}

let state: HarnessState = { view: 'chat', agentId: '', agentName: '' };
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
