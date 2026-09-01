import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type pg from 'pg';
import { createPool } from '@opendb-dsh/session-persistence-pg';

export const name = 'platform-status';
export const inject = ['connection', 'webServer'];
export const Config = z.object({ connectionString: z.string().required() });

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

/** 集群内 k8s API GET（SA token + ca；集群外/无 RBAC 时返回 undefined，页面降级）。 */
async function k8sGet(path: string): Promise<any | undefined> {
  try {
    const token = readFileSync(`${SA}/token`, 'utf8');
    const ca = readFileSync(`${SA}/ca.crt`);
    const ns = readFileSync(`${SA}/namespace`, 'utf8').trim();
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpsRequest({
        host: 'kubernetes.default.svc',
        path: path.replace('{ns}', ns),
        ca,
        headers: { authorization: `Bearer ${token}` },
        timeout: 8000,
      }, (res) => {
        let out = '';
        res.on('data', (c) => { out += c; });
        res.on('end', () => (res.statusCode === 200 ? resolve(out) : reject(new Error(`k8s API ${res.statusCode}`))));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('k8s API timeout')));
      req.end();
    });
    return JSON.parse(body);
  } catch (cause) {
    process.stderr.write(`[platform-status] k8s API unavailable: ${String((cause as Error).message)}\n`);
    return undefined;
  }
}

// ── k8s 集群状态（2026-08-31，user 通过 docs/prototypes/cluster-r4.html）：cluster 端点的取数与整形
/** Pod 角色映射：k8s 真名含 ReplicaSet 哈希不可改，这里给出规范显示名与角色标签（设计稿 R3/R4 定） */
const ROLES: { match: RegExp; comp: string; role: string; kind: 'ctrl' | 'exec' | 'data'; hue: string }[] = [
  { match: /^opendb-dsh-host-/, comp: 'host', role: '网关 · 调度', kind: 'ctrl', hue: '#4176E6' },
  { match: /^opendb-dsh-runtime-default-/, comp: 'runtime', role: '智能体执行器', kind: 'exec', hue: '#8B6BE0' },
  { match: /^opendb-dsh-runtime-collector-/, comp: 'collector', role: '定时采集', kind: 'exec', hue: '#5C6BC0' },
  { match: /^opendb-dsh-postgres-/, comp: 'postgres', role: '状态库', kind: 'data', hue: '#2FA79A' },
  { match: /^opendb-dsh-redis-/, comp: 'redis', role: '缓存', kind: 'data', hue: '#3E9BC0' },
  { match: /^opendb-dsh-minio-init/, comp: 'minio-init', role: '一次性任务', kind: 'data', hue: '#9AA6B2' },
  { match: /^opendb-dsh-minio-/, comp: 'minio', role: '对象存储', kind: 'data', hue: '#6E8CA0' },
  { match: /^opendb-dsh-qdrant-/, comp: 'qdrant', role: '向量库', kind: 'data', hue: '#9A6BB8' },
  { match: /^opendb-dsh-ollama-/, comp: 'ollama', role: '嵌入模型', kind: 'data', hue: '#4B7BA8' },
];
const roleOf = (name: string) => ROLES.find((r) => r.match.test(name))
  ?? { comp: name.replace(/^opendb-dsh-/, '').replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, ''), role: '组件', kind: 'data' as const, hue: '#7A8AA6' };

/** CPU 量 → 毫核（"250m" / "2" / "1500000000n"） */
function cpuMilli(v: string | undefined): number {
  if (v === undefined || v === '') return 0;
  if (v.endsWith('n')) return Math.round(Number(v.slice(0, -1)) / 1e6);
  if (v.endsWith('u')) return Math.round(Number(v.slice(0, -1)) / 1e3);
  if (v.endsWith('m')) return Math.round(Number(v.slice(0, -1)));
  return Math.round(Number(v) * 1000);
}
/** 内存量 → MiB（"512Mi" / "2Gi" / "1024000Ki" / 裸字节） */
function memMiB(v: string | undefined): number {
  if (v === undefined || v === '') return 0;
  const m = /^(\d+(?:\.\d+)?)([A-Za-z]*)$/.exec(v);
  if (m === null) return 0;
  const n = Number(m[1]);
  const unit: Record<string, number> = { Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024, K: 1 / 1024, M: 1 / 1.048576, G: 1024 / 1.073741824, '': 1 / 1048576 };
  return Math.round(n * (unit[m[2]] ?? 1 / 1048576));
}
const ISO = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** 被管数据库：注册表 + 每个节点最近一次任务判定（几百台时只回汇总 + 分组计数 + 需关注清单，不整表下发前端渲染压力） */
async function fleet(pool: pg.Pool): Promise<unknown> {
  const r = await pool.query(
    `WITH latest AS (
       SELECT DISTINCT ON (node) node, worst, collected_at
         FROM (SELECT node, worst, collected_at FROM opendb_task_collects WHERE node IS NOT NULL
               UNION ALL
               SELECT scope AS node, worst, collected_at FROM opendb_health_collects WHERE scope IS NOT NULL) x
        ORDER BY node, collected_at DESC)
     SELECT n.id, n.name, n.engine, n.host, n.port, n.status,
            coalesce(l.worst, 'unknown') AS worst, l.collected_at
       FROM dsh_db_nodes n LEFT JOIN latest l ON l.node = n.name
      ORDER BY n.name`);
  const items = r.rows.map((row: any) => ({
    id: String(row.id), name: String(row.name),
    engine: String(row.engine) === 'opengauss' ? 'openGauss' : 'PostgreSQL',
    addr: `${String(row.host)}:${Number(row.port)}`,
    status: String(row.status),
    // 离线优先于判定：连不上时最近判定没有意义
    level: String(row.status) === 'offline' ? 'off'
      : ({ critical: 'crit', warn: 'warn', notice: 'notice', ok: 'ok' } as Record<string, string>)[String(row.worst)] ?? 'unknown',
    lastCollectedAt: ISO(row.collected_at) ?? (row.collected_at instanceof Date ? row.collected_at.toISOString() : null),
  }));
  const counts: Record<string, number> = { ok: 0, notice: 0, warn: 0, crit: 0, off: 0, unknown: 0 };
  for (const i of items) counts[i.level] = (counts[i.level] ?? 0) + 1;
  return { total: items.length, counts, items };
}

// ── 模型用量（2026-08-31 R2，user 通过 docs/prototypes/usage-r2.html）
/**
 * usage 的四个字段都由模型 API 原样返回（`@earendil-works/pi-ai` 的 parseChunkUsage）：
 *   cacheReadTokens = prompt_tokens_details.cached_tokens（OpenAI 系）/ prompt_cache_hit_tokens（DeepSeek）/ cache_read_input_tokens（Anthropic）
 *   inputTokens     = prompt_tokens − cacheRead − cacheWrite  ← 已扣掉缓存部分，所以「输入 + 输出 + 缓存读」不会双算
 *   reasoningTokens = completion_tokens_details.reasoning_tokens ← 已含在 outputTokens 里，不另计入总量
 * 提供方不返回缓存字段时就是 0（平台不估算、不推断）。
 */
const TOK = `(data->'usage'->>'inputTokens')::bigint`;
const TOK_O = `(data->'usage'->>'outputTokens')::bigint`;
const TOK_C = `coalesce((data->'usage'->>'cacheReadTokens')::bigint, 0)`;
const TOK_R = `coalesce((data->'usage'->>'reasoningTokens')::bigint, 0)`;
const TOTAL = `${TOK} + ${TOK_O} + ${TOK_C}`;
const USAGE_ROWS = `dsh_session_events WHERE type = 'assistant/message' AND data ? 'usage'`;
/**
 * 会话标题：先按 session 聚好，再对聚合后的少量会话做一次 LATERAL 取最新 session/title。
 * 不要写成逐行相关子查询——事件表 630 万行、单会话事件成千上万，标题事件又在会话最早期，
 * 逐行反向扫描实测把 Top 会话那条查询拖到 2.4s（本页首屏 5s 的主因）。
 */
const TITLE_LAT = `LEFT JOIN LATERAL (SELECT t.data->>'title' title FROM dsh_session_events t
                     WHERE t.session_id = a.session_id AND t.type = 'session/title' ORDER BY t.seq DESC LIMIT 1) ti ON true`;
/** 标题 → 来源：【任务运行】= 定时/手动任务；其余方括号开头 = 报告里的深挖会话；其余 = 人工会话 */
const KIND = `CASE WHEN ti.title LIKE '【任务运行】%' THEN 'task' WHEN ti.title LIKE '【%' THEN 'dig' ELSE 'manual' END`;
const n = (v: unknown): number => Number(v ?? 0);

async function usage(pool: pg.Pool, days: number): Promise<unknown> {
  const win = `to_timestamp(time / 1000.0) > now() - ($1 || ' days')::interval`;
  const [totals, today, daily, bySource, byModel, sizes, top] = await Promise.all([
    pool.query(`SELECT coalesce(sum(${TOK}),0) i, coalesce(sum(${TOK_O}),0) o, coalesce(sum(${TOK_C}),0) c, coalesce(sum(${TOK_R}),0) r, count(*) n,
                       count(DISTINCT session_id) sessions FROM ${USAGE_ROWS} AND ${win}`, [String(days)]),
    pool.query(`SELECT coalesce(sum(${TOK}),0) i, coalesce(sum(${TOK_O}),0) o, coalesce(sum(${TOK_C}),0) c, count(*) n
                  FROM ${USAGE_ROWS} AND to_timestamp(time / 1000.0) > date_trunc('day', now())`),
    // 按 min(time) 排序而不是按 'MM-DD' 字符串：跨年窗口下 01-05 会排到 12-30 前面
    pool.query(`SELECT to_char(date_trunc('day', to_timestamp(time / 1000.0)), 'MM-DD') d,
                       sum(${TOK}) i, sum(${TOK_O}) o, sum(${TOK_C}) c, count(*) n
                  FROM ${USAGE_ROWS} AND ${win} GROUP BY 1 ORDER BY min(time)`, [String(days)]),
    pool.query(`WITH agg AS (SELECT session_id, sum(${TOTAL}) tok, count(*) cnt
                               FROM ${USAGE_ROWS} AND ${win} GROUP BY session_id)
                SELECT kind, sum(tok) tok, sum(cnt) cnt, count(*) sessions
                  FROM (SELECT ${KIND} kind, a.tok, a.cnt FROM agg a ${TITLE_LAT}) s GROUP BY kind`, [String(days)]),
    pool.query(`SELECT coalesce(data->'message'->'source'->>'model', '(未知)') model, sum(${TOTAL}) tok, count(*) n
                  FROM ${USAGE_ROWS} AND ${win} GROUP BY 1 ORDER BY 2 DESC`, [String(days)]),
    pool.query(`SELECT bucket, count(*) n FROM (
                  SELECT CASE WHEN t < 10000 THEN '<10k' WHEN t < 30000 THEN '10-30k' WHEN t < 60000 THEN '30-60k'
                              WHEN t < 100000 THEN '60-100k' ELSE '>100k' END bucket
                    FROM (SELECT ${TOTAL} t FROM ${USAGE_ROWS} AND ${win}) x) y GROUP BY 1`, [String(days)]),
    pool.query(`WITH agg AS (SELECT session_id, sum(${TOTAL}) tokens, count(*) calls,
                                    max(data->'message'->'source'->>'model') model
                               FROM ${USAGE_ROWS} AND ${win} GROUP BY session_id ORDER BY 2 DESC LIMIT 8)
                SELECT a.session_id, coalesce(ti.title, '(未命名会话)') title, ${KIND} kind, a.tokens, a.calls, a.model
                  FROM agg a ${TITLE_LAT} ORDER BY a.tokens DESC`, [String(days)]),
  ]);
  const t = totals.rows[0]; const td = today.rows[0];
  const ORDER = ['<10k', '10-30k', '30-60k', '60-100k', '>100k'];
  const sizeMap = new Map(sizes.rows.map((r: any) => [String(r.bucket), n(r.n)]));
  return {
    windowDays: days,
    totals: { input: n(t.i), output: n(t.o), cacheRead: n(t.c), reasoning: n(t.r), calls: n(t.n), sessions: n(t.sessions) },
    today: { input: n(td.i), output: n(td.o), cacheRead: n(td.c), calls: n(td.n) },
    daily: daily.rows.map((r: any) => ({ day: String(r.d), input: n(r.i), output: n(r.o), cacheRead: n(r.c), calls: n(r.n) })),
    bySource: bySource.rows.map((r: any) => ({ kind: String(r.kind), tokens: n(r.tok), calls: n(r.cnt), sessions: n(r.sessions) }))
      .sort((a, b) => b.tokens - a.tokens),
    byModel: byModel.rows.map((r: any) => ({ model: String(r.model), tokens: n(r.tok), calls: n(r.n) })),
    sizes: ORDER.map((b) => ({ bucket: b, count: sizeMap.get(b) ?? 0 })),
    topSessions: top.rows.map((r: any) => ({
      sessionId: String(r.session_id), title: String(r.title), kind: String(r.kind),
      tokens: n(r.tokens), calls: n(r.calls), model: r.model === null ? '' : String(r.model),
    })),
  };
}

/** 全局资源大盘的 server 半边：/opendb-status 通道（pod 拓扑 + 模型 token 用量 + k8s 集群状态）。 */
export function apply(ctx: Context, config: { connectionString: string }): void {
  const anyCtx = ctx as any;
  const pool: pg.Pool = createPool(config.connectionString);
  ctx.effect(() => () => { void pool.end(); }, 'platform-status.pool');

  // P3 HPA-by-WS：裸 HTTP 指标路由（KEDA metrics-api scaler 集群内直拉，不经 ingress/认证）。
  // 连接数取 node server.getConnections（含 WS 长连接——负载近似信号，够 HPA 用）。
  ctx.effect(() => anyCtx.webServer.register({
    kind: 'exact',
    path: '/opendb/metrics.json',
    handler: async (_req: unknown, res: any) => {
      const connections = await new Promise<number>((resolve) => {
        anyCtx.webServer.server.getConnections((err: Error | null, n: number) => resolve(err ? 0 : n));
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ connections, pod: process.env.HOSTNAME ?? 'unknown' }));
    },
  }), 'platform-status.metricsRoute');

  ctx.effect(() => anyCtx.connection.rpc.handle('/opendb-status', async (endpoint: string, _payload: any): Promise<any> => {
    try {
      // ── k8s 集群状态（架构图 / 节点视图 / 事件 / 被管数据库舰队）
      if (endpoint === 'cluster') {
        const [nodesRaw, podsRaw, nodeMx, podMx, evRaw] = await Promise.all([
          k8sGet('/api/v1/nodes'),
          k8sGet('/api/v1/namespaces/{ns}/pods'),
          k8sGet('/apis/metrics.k8s.io/v1beta1/nodes'),
          k8sGet('/apis/metrics.k8s.io/v1beta1/namespaces/{ns}/pods'),
          k8sGet('/api/v1/namespaces/{ns}/events?limit=60'),
        ]);
        const nodeUse = new Map<string, { cpu: number; mem: number }>();
        for (const i of nodeMx?.items ?? []) nodeUse.set(i.metadata.name, { cpu: cpuMilli(i.usage?.cpu), mem: memMiB(i.usage?.memory) });
        const podUse = new Map<string, { cpu: number; mem: number }>();
        for (const i of podMx?.items ?? []) {
          const sum = (i.containers ?? []).reduce((a: { cpu: number; mem: number }, c: any) =>
            ({ cpu: a.cpu + cpuMilli(c.usage?.cpu), mem: a.mem + memMiB(c.usage?.memory) }), { cpu: 0, mem: 0 });
          podUse.set(i.metadata.name, sum);
        }
        const nodes = nodesRaw === null || nodesRaw === undefined ? null : nodesRaw.items.map((n: any) => ({
          name: n.metadata.name,
          role: n.metadata.labels?.['node-role.kubernetes.io/control-plane'] !== undefined ? 'control-plane' : 'worker',
          ready: (n.status?.conditions ?? []).some((c: any) => c.type === 'Ready' && c.status === 'True'),
          version: n.status?.nodeInfo?.kubeletVersion ?? '',
          cpuCapacity: cpuMilli(n.status?.capacity?.cpu), memCapacity: memMiB(n.status?.capacity?.memory),
          cpu: nodeUse.get(n.metadata.name)?.cpu ?? 0, mem: nodeUse.get(n.metadata.name)?.mem ?? 0,
        }));
        const pods = podsRaw === null || podsRaw === undefined ? null : podsRaw.items.map((p: any) => {
          const cs = p.status?.containerStatuses ?? [];
          const req = (p.spec?.containers ?? []).reduce((a: { cpu: number; mem: number }, c: any) =>
            ({ cpu: a.cpu + cpuMilli(c.resources?.requests?.cpu), mem: a.mem + memMiB(c.resources?.requests?.memory) }), { cpu: 0, mem: 0 });
          const lim = (p.spec?.containers ?? []).reduce((a: { cpu: number; mem: number }, c: any) =>
            ({ cpu: a.cpu + cpuMilli(c.resources?.limits?.cpu), mem: a.mem + memMiB(c.resources?.limits?.memory) }), { cpu: 0, mem: 0 });
          const r = roleOf(p.metadata.name);
          const use = podUse.get(p.metadata.name) ?? { cpu: 0, mem: 0 };
          return {
            name: p.metadata.name, comp: r.comp, role: r.role, kind: r.kind, hue: r.hue,
            owner: (p.metadata.ownerReferences ?? [])[0]?.kind ?? '',
            phase: p.status?.phase ?? '?', ready: cs.length > 0 && cs.every((c: any) => c.ready === true),
            restarts: cs.reduce((a: number, c: any) => a + (c.restartCount ?? 0), 0),
            node: p.spec?.nodeName ?? '-', podIP: p.status?.podIP ?? null,
            startedAt: ISO(p.status?.startTime),
            images: (p.spec?.containers ?? []).map((c: any) => c.image),
            cpu: use.cpu, mem: use.mem, cpuReq: req.cpu, memReq: req.mem, cpuLim: lim.cpu, memLim: lim.mem,
          };
        });
        const events = evRaw === null || evRaw === undefined ? null : (evRaw.items ?? [])
          .map((e: any) => ({
            time: ISO(e.lastTimestamp) ?? ISO(e.eventTime) ?? ISO(e.metadata?.creationTimestamp),
            type: e.type ?? 'Normal', reason: e.reason ?? '',
            object: `${String(e.involvedObject?.kind ?? '').toLowerCase()}/${e.involvedObject?.name ?? ''}`,
            message: String(e.message ?? '').slice(0, 200),
          }))
          .sort((a: any, b: any) => (a.type === b.type ? String(b.time).localeCompare(String(a.time)) : a.type === 'Warning' ? -1 : 1))
          .slice(0, 30);
        return { ok: true, value: { nodes, pods, events, fleet: await fleet(pool), collectedAt: new Date().toISOString() } };
      }
      // ── 模型用量（资源 › 模型用量）：默认近 7 日，payload.days 可切 30
      if (endpoint === 'usage') {
        const days = Math.max(1, Math.min(Number((_payload as { days?: unknown } | null)?.days ?? 7), 90));
        return { ok: true, value: await usage(pool, days) };
      }
      if (endpoint !== 'overview') return { ok: false, error: { code: 'bad-request', message: `unknown endpoint ${endpoint}`, details: {} } };

      // ── pod 拓扑（k8s 只读；RBAC 缺失时降级为 null）
      const podsRaw = await k8sGet('/api/v1/namespaces/{ns}/pods');
      const pods = podsRaw === undefined ? null : podsRaw.items.map((p: any) => {
        const cs = p.status?.containerStatuses?.[0];
        return {
          name: p.metadata.name,
          app: p.metadata.labels?.app ?? p.metadata.labels?.['opendb.runtimeClass'] ?? '-',
          phase: p.status?.phase ?? '?',
          ready: cs?.ready === true,
          restarts: cs?.restartCount ?? 0,
          startedAt: p.status?.startTime ?? null,
          node: p.spec?.nodeName ?? '-',
        };
      });

      // ── 模型用量（assistant/message 顶层 usage：inputTokens/outputTokens）
      const today = await pool.query(
        `SELECT coalesce(sum((data->'usage'->>'inputTokens')::bigint), 0) AS input,
                coalesce(sum((data->'usage'->>'outputTokens')::bigint), 0) AS output,
                count(*) AS calls
         FROM dsh_session_events
         WHERE type = 'assistant/message' AND data ? 'usage'
           AND to_timestamp(time / 1000.0) > date_trunc('day', now())`,
      );
      const daily = await pool.query(
        `SELECT to_char(to_timestamp(time / 1000.0), 'MM-DD') AS day,
                sum((data->'usage'->>'inputTokens')::bigint) AS input,
                sum((data->'usage'->>'outputTokens')::bigint) AS output
         FROM dsh_session_events
         WHERE type = 'assistant/message' AND data ? 'usage'
           AND to_timestamp(time / 1000.0) > now() - interval '7 days'
         GROUP BY 1 ORDER BY 1`,
      );
      const topSessions = await pool.query(
        `SELECT e.session_id,
                sum((e.data->'usage'->>'inputTokens')::bigint + (e.data->'usage'->>'outputTokens')::bigint) AS tokens,
                (SELECT t.data->>'title' FROM dsh_session_events t
                 WHERE t.session_id = e.session_id AND t.type = 'session/title' ORDER BY t.seq DESC LIMIT 1) AS title
         FROM dsh_session_events e
         WHERE e.type = 'assistant/message' AND e.data ? 'usage'
           AND to_timestamp(e.time / 1000.0) > now() - interval '7 days'
         GROUP BY e.session_id ORDER BY 2 DESC LIMIT 8`,
      );

      return {
        ok: true,
        value: {
          pods,
          tokens: {
            today: { input: Number(today.rows[0].input), output: Number(today.rows[0].output), calls: Number(today.rows[0].calls) },
            daily: daily.rows.map((r: any) => ({ day: r.day, input: Number(r.input), output: Number(r.output) })),
            topSessions: topSessions.rows.map((r: any) => ({ sessionId: r.session_id, title: r.title ?? '(未命名会话)', tokens: Number(r.tokens) })),
          },
        },
      };
    } catch (cause) {
      return { ok: false, error: { code: 'internal', message: String((cause as Error).message ?? cause), details: {} } };
    }
  }, { authority: 'trusted-host' }), 'platform-status.rpc');
}
