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

/** 全局资源大盘的 server 半边：/opendb-status 通道（pod 拓扑 + 模型 token 用量）。 */
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
