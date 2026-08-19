import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type pg from 'pg';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';

export const name = 'memory-graph';
export const inject = ['opendbRegistry'];
export const Config = z.object({
  connectionString: z.string().required(),
  pollMs: z.number().default(120_000).description('增量抽取扫描周期'),
});

const GRAPH_LEADER_LOCK = 7_204_211_033;

/** 从记忆文本抽取实体：token 化后与平台对象名集合（节点/agent）求交——O(tokens)，2000 节点无压力。 */
export function extractEntities(content: string, known: Map<string, string>): { entity: string; kind: string }[] {
  const seen = new Map<string, string>();
  for (const m of content.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/g)) {
    const kind = known.get(m[0]);
    if (kind !== undefined) seen.set(m[0], kind);
  }
  return [...seen.entries()].map(([entity, kind]) => ({ entity, kind }));
}

/**
 * 记忆图谱（P3；G3 判定=PG 原生做图，不引图库）：
 * - 抽取器（Host，leader 单实例）：水位增量扫 opendb_memories，实体=内容中出现的节点/agent 名，
 *   写 opendb_memory_entities 边表；
 * - memory_graph 工具（Runtime）：实体两跳查询——直接记忆 + 经共现实体桥接的关联记忆链。
 */
export function apply(ctx: Context, config: { connectionString: string; pollMs: number }): void {
  const anyCtx = ctx as any;
  const registry = anyCtx.opendbRegistry;
  const pool: pg.Pool = createPool(config.connectionString);
  const ready = runMigrations(pool).then(() => pool.query(
    `INSERT INTO opendb_graph_state (key, watermark) VALUES ('memory-entities', 'epoch') ON CONFLICT DO NOTHING`));
  ready.catch((cause) => process.stderr.write(`[memory-graph] init failed: ${String(cause)}\n`));

  let leaderClient: pg.PoolClient | undefined;
  async function ensureLeader(): Promise<boolean> {
    if (leaderClient !== undefined) {
      try { await leaderClient.query('SELECT 1'); return true; }
      catch { try { leaderClient.release(true as any); } catch { /* gone */ } leaderClient = undefined; }
    }
    const c = await pool.connect();
    try {
      const r = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [GRAPH_LEADER_LOCK]);
      if (r.rows[0].ok === true) { leaderClient = c; return true; }
      c.release();
      return false;
    } catch (cause) { c.release(true as any); throw cause; }
  }

  async function sweep(): Promise<void> {
    await ready;
    if (!(await ensureLeader())) return;
    const wm = await pool.query(`SELECT watermark FROM opendb_graph_state WHERE key = 'memory-entities'`);
    const watermark: Date = wm.rows[0].watermark;
    const rows = await pool.query(
      `SELECT id, content, created_at FROM opendb_memories WHERE created_at > $1 ORDER BY created_at LIMIT 200`,
      [watermark],
    );
    if (rows.rowCount === 0) return;
    const [nodes, agents] = await Promise.all([registry.listNodes({}), registry.listAgents()]);
    const known = new Map<string, string>();
    for (const n of nodes) known.set(n.name, 'node');
    for (const a of agents) known.set(a.name, 'agent');
    let edges = 0;
    for (const m of rows.rows) {
      for (const e of extractEntities(String(m.content), known)) {
        await pool.query(
          `INSERT INTO opendb_memory_entities (memory_id, entity, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [m.id, e.entity, e.kind]);
        edges += 1;
      }
    }
    const maxTime = rows.rows[rows.rowCount! - 1].created_at;
    await pool.query(`UPDATE opendb_graph_state SET watermark = $1, updated_at = now() WHERE key = 'memory-entities'`, [maxTime]);
    if (edges > 0) process.stderr.write(`[memory-graph] extracted ${edges} edges from ${rows.rowCount} memories\n`);
  }

  let timer: NodeJS.Timeout | undefined;
  ctx.effect(() => {
    const loop = async () => {
      try { await sweep(); } catch (cause) {
        process.stderr.write(`[memory-graph] sweep failed: ${String((cause as Error).message ?? cause)}\n`);
      }
      timer = setTimeout(loop, config.pollMs);
    };
    void loop();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      if (leaderClient !== undefined) { try { leaderClient.release(); } catch { /* closing */ } }
      void pool.end();
    };
  }, 'memory-graph.loop');

  // memory_graph 工具（tools 注册表在 Runtime；Host 侧静默不激活）
  anyCtx.inject(['tools'], (c: any) => {
    c.effect(() => c.tools.register(defineTool({
      name: 'memory_graph',
      description: '记忆图谱关联查询：给定实体（节点名/agent 名），返回直接相关记忆 + 经共现实体桥接的两跳关联记忆链。适合"这个节点有哪些历史事件、和谁有关联"类推理。',
      parameters: {
        entity: { type: 'string', description: '实体名（节点名如 og-real-006，或 agent 名）。', required: true },
        limit: { type: 'integer', description: '每层返回条数（默认 8）。' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true } } },
        render: (_a: unknown, v: any) => [{ type: 'text', text: v.content }],
      },
      async execute(args: any) {
        const entity = String(args.entity ?? '');
        const limit = Math.min(Number(args.limit ?? 8), 20);
        const direct = await pool.query(
          `SELECT m.id, m.kind, m.content, m.created_at FROM opendb_memory_entities e
           JOIN opendb_memories m ON m.id = e.memory_id
           WHERE e.entity = $1 ORDER BY m.created_at DESC LIMIT $2`, [entity, limit]);
        if (direct.rowCount === 0) return { content: `图谱中没有与「${entity}」直接关联的记忆（实体抽取每 2 分钟增量运行）` };
        const bridge = await pool.query(
          `WITH direct_mem AS (SELECT memory_id FROM opendb_memory_entities WHERE entity = $1),
           co AS (SELECT DISTINCT e2.entity FROM opendb_memory_entities e2
                  WHERE e2.memory_id IN (SELECT memory_id FROM direct_mem) AND e2.entity <> $1)
           SELECT DISTINCT m.id, m.content, m.created_at, e3.entity AS via
           FROM co JOIN opendb_memory_entities e3 ON e3.entity = co.entity
           JOIN opendb_memories m ON m.id = e3.memory_id
           WHERE m.id NOT IN (SELECT memory_id FROM direct_mem)
           ORDER BY m.created_at DESC LIMIT $2`, [entity, limit]);
        const fmt = (r: any) => `- [${String(r.created_at).slice(0, 10)}]${r.via ? `（经 ${r.via}）` : ''} ${String(r.content).slice(0, 160)}`;
        return {
          content: [
            `== 「${entity}」直接相关记忆（${direct.rowCount}）==`,
            ...direct.rows.map(fmt),
            bridge.rowCount! > 0 ? `\n== 两跳关联（经共现实体桥接，${bridge.rowCount}）==` : '',
            ...bridge.rows.map(fmt),
          ].filter((s) => s !== '').join('\n'),
        };
      },
    } as any)), 'memory-graph.tool');
  });
}
