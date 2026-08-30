import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import { createServer, type Server } from 'node:http';
import { rowsToPoints, rowsToDictObjects } from './scrape.ts';

export { rowsToPoints, rowsToDictObjects } from './scrape.ts';

interface RoundStats { at: string; nodes: number; ok: number; failed: number; points: number }

declare module '@deepseek-ai/cordis' {
  interface Context { opendbCollector: CollectorService }
}

/**
 * The collector runtime class (design §8): periodically scrapes every registry node
 * through the db seam's dialect metric/dictionary query sets, writes to
 * opendbMetrics/opendbDictionary, and reflects reachability into dsh_db_nodes.status.
 * Deployed as its own pod pool (profile `collector`, replicas 1 in MVP); dictionary
 * snapshots are already serialized per node by an advisory lock, and duplicated metric
 * points from a brief rollout overlap are tolerated.
 */
export default class CollectorService extends Service {
  static inject = ['opendbDb', 'opendbRegistry', 'opendbMetrics', 'opendbDictionary'];
  static Config = z.object({
    metricsIntervalMs: z.number().step(1).min(5000).default(60_000),
    dictionaryIntervalMs: z.number().step(1).min(60_000).default(600_000),
    pruneIntervalMs: z.number().step(1).min(60_000).default(6 * 3600_000),
    healthPort: z.number().step(1).default(9090),
  });

  private readonly db: any;
  private readonly registry: any;
  private readonly metrics: any;
  private readonly dictionary: any;
  private readonly cfg: { metricsIntervalMs: number; dictionaryIntervalMs: number; pruneIntervalMs: number; healthPort: number };
  private lastRound: RoundStats | undefined;
  private lastDictAt = 0;
  private lastPruneAt = 0;
  private stopped = false;
  private server: Server | undefined;

  constructor(ctx: Context, config: { metricsIntervalMs?: number; dictionaryIntervalMs?: number; pruneIntervalMs?: number; healthPort?: number } = {}) {
    super(ctx, 'opendbCollector');
    const anyCtx = ctx as any;
    this.db = anyCtx.opendbDb;
    this.registry = anyCtx.opendbRegistry;
    this.metrics = anyCtx.opendbMetrics;
    this.dictionary = anyCtx.opendbDictionary;
    this.cfg = {
      metricsIntervalMs: config.metricsIntervalMs ?? 60_000,
      dictionaryIntervalMs: config.dictionaryIntervalMs ?? 600_000,
      pruneIntervalMs: config.pruneIntervalMs ?? 6 * 3600_000,
      healthPort: config.healthPort ?? 9090,
    };
    ctx.effect(() => {
      this.startHealthServer();
      const timer = setInterval(() => { void this.round(); }, this.cfg.metricsIntervalMs);
      void this.round();   // first round immediately so fresh pods report data fast
      return () => {
        this.stopped = true;
        clearInterval(timer);
        this.server?.close();
      };
    }, 'opendbCollector.loop');
  }

  /** One scrape round over all registry nodes; per-node failures never abort the round. */
  async round(): Promise<RoundStats> {
    const at = new Date();
    const doDict = at.getTime() - this.lastDictAt >= this.cfg.dictionaryIntervalMs;
    if (doDict) this.lastDictAt = at.getTime();
    const stats: RoundStats = { at: at.toISOString(), nodes: 0, ok: 0, failed: 0, points: 0 };
    let nodes: any[] = [];
    try {
      nodes = await this.registry.listNodes();
    } catch (cause) {
      process.stderr.write(`[collector] listNodes failed: ${String(cause)}\n`);
      return stats;
    }
    for (const node of nodes) {
      if (this.stopped) break;
      stats.nodes += 1;
      try {
        stats.points += await this.scrapeMetrics(node, at);
        if (doDict) await this.scrapeDictionary(node);
        stats.ok += 1;
        if (node.status !== 'online') await this.registry.updateNodeStatus(node.id, 'online');
      } catch (cause) {
        stats.failed += 1;
        process.stderr.write(`[collector] scrape ${node.name} failed: ${String((cause as Error).message ?? cause)}\n`);
        if (node.status !== 'offline') {
          await this.registry.updateNodeStatus(node.id, 'offline').catch(() => {});
        }
      }
    }
    if (at.getTime() - this.lastPruneAt >= this.cfg.pruneIntervalMs) {
      this.lastPruneAt = at.getTime();
      await this.metrics.prune().catch((cause: unknown) => process.stderr.write(`[collector] prune failed: ${String(cause)}\n`));
    }
    this.lastRound = stats;
    return stats;
  }

  private async scrapeMetrics(node: any, at: Date): Promise<number> {
    const queries = this.db.dialect(node.engine).metrics ?? [];
    let written = 0;
    for (const q of queries) {
      const r = await this.db.query(node, q.sql, { maxRows: 2000 });
      const points = rowsToPoints(node.id, r.rows, at);
      await this.metrics.record(points);
      written += points.length;
    }
    return written;
  }

  private async scrapeDictionary(node: any): Promise<void> {
    const queries = this.db.dialect(node.engine).dictionary ?? [];
    const objects = [];
    for (const q of queries) {
      const r = await this.db.query(node, q.sql, { maxRows: 20000 });
      objects.push(...rowsToDictObjects(r.rows));
    }
    const result = await this.dictionary.snapshot(node.id, objects);
    if (result.added + result.removed + result.modified > 0) {
      process.stderr.write(`[collector] dict ${node.name}: +${result.added} -${result.removed} ~${result.modified} (total ${result.total})\n`);
    }
  }

  /** 立即做一次字典快照（全部节点或指定节点）；表结构变更追溯的验收脚本用它把 DDL 步骤立刻记进字典，不必等 10 分钟周期 */
  async snapshotDictionaryNow(nodeName?: string): Promise<{ nodes: number; ok: number; failed: number }> {
    const out = { nodes: 0, ok: 0, failed: 0 };
    let nodes: any[] = [];
    try { nodes = await this.registry.listNodes(); } catch { return out; }
    for (const node of nodes) {
      if (nodeName !== undefined && node.name !== nodeName) continue;
      out.nodes += 1;
      try { await this.scrapeDictionary(node); out.ok += 1; } catch (cause) { out.failed += 1; process.stderr.write(`[collector] dict-now ${node.name} failed: ${String((cause as Error).message ?? cause)}\n`); }
    }
    this.lastDictAt = Date.now();
    return out;
  }

  private startHealthServer(): void {
    this.server = createServer((req, res) => {
      // POST /dict-snapshot[?node=<name>]：立即快照（本地端口，仅集群内可达）
      if (req.method === 'POST' && (req.url ?? '').startsWith('/dict-snapshot')) {
        const node = new URL(req.url ?? '/', 'http://localhost').searchParams.get('node') ?? undefined;
        this.snapshotDictionaryNow(node).then((r) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r)); })
          .catch((cause) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String((cause as Error).message ?? cause) })); });
        return;
      }
      const body = JSON.stringify({ role: 'collector', lastRound: this.lastRound ?? null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
    this.server.on('error', (cause) => process.stderr.write(`[collector] health server error: ${String(cause)}\n`));
    this.server.listen(this.cfg.healthPort);
  }
}
export { CollectorService };
