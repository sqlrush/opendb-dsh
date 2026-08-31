/** platform-status 的 cluster 端点回包形状（server 侧 packages/platform-status/src/index.ts） */
export interface Pod {
  name: string; comp: string; role: string; kind: 'ctrl' | 'exec' | 'data'; hue: string;
  owner: string; phase: string; ready: boolean; restarts: number;
  node: string; podIP: string | null; startedAt: string | null; images: string[];
  cpu: number; mem: number; cpuReq: number; memReq: number; cpuLim: number; memLim: number;
}
export interface Node {
  name: string; role: string; ready: boolean; version: string;
  cpuCapacity: number; memCapacity: number; cpu: number; mem: number;
}
export interface Ev { time: string | null; type: string; reason: string; object: string; message: string }
export interface Db {
  id: string; name: string; engine: string; addr: string; status: string;
  level: string; lastCollectedAt: string | null;
}
export interface Cluster {
  nodes: Node[] | null; pods: Pod[] | null; events: Ev[] | null;
  fleet: { total: number; counts: Record<string, number>; items: Db[] };
  collectedAt: string;
}
