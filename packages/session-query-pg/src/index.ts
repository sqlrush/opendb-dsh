import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type pg from 'pg';
import { createPool } from '@opendb-dsh/session-persistence-pg';

export const name = 'session-query-pg';
export const inject = ['connection', 'webServer'];
export const Config = z.object({ connectionString: z.string().required() });

interface RpcResult { ok: boolean; value?: unknown; error?: { code: string; message: string; details: object } }

/**
 * 会话全文检索（P2 W3）：/opendb-sessions 通道——按内容 ILIKE 扫 user/assistant 消息文本，
 * 按会话聚合（命中数/最近时间/标题/首条命中摘录）。侧栏搜索框消费（标题过滤之外的内容检索）。
 * MVP 用 ILIKE（中文无分词负担，事件量万级全扫毫秒级；P3 数据量大时再上 pg_trgm/分区）。
 */
export function apply(ctx: Context, config: { connectionString: string }): void {
  const anyCtx = ctx as any;
  const pool: pg.Pool = createPool(config.connectionString);
  ctx.effect(() => () => { void pool.end(); }, 'session-query.pool');

  ctx.effect(() => anyCtx.connection.rpc.handle('/opendb-sessions', async (endpoint: string, payload: any): Promise<RpcResult> => {
    try {
      if (endpoint !== 'search') return { ok: false, error: { code: 'bad-request', message: `unknown endpoint ${endpoint}`, details: {} } };
      const q = String(payload.query ?? '').trim();
      if (q.length < 2) return { ok: true, value: { sessions: [] } };
      const limit = Math.min(Number(payload.limit ?? 12), 30);
      const r = await pool.query(
        `WITH hits AS (
           SELECT session_id, count(*) AS n, max(time) AS last_time
           FROM dsh_session_events
           WHERE type IN ('user/message', 'assistant/message')
             AND data->'message'->'content'->0->>'text' ILIKE $1
           GROUP BY session_id ORDER BY max(time) DESC LIMIT $2)
         SELECT h.session_id, h.n, h.last_time,
           (SELECT t.data->>'title' FROM dsh_session_events t
             WHERE t.session_id = h.session_id AND t.type = 'session/title' ORDER BY t.seq DESC LIMIT 1) AS title,
           (SELECT e2.data->'message'->'content'->0->>'text' FROM dsh_session_events e2
             WHERE e2.session_id = h.session_id AND e2.type IN ('user/message', 'assistant/message')
               AND e2.data->'message'->'content'->0->>'text' ILIKE $1 ORDER BY e2.seq LIMIT 1) AS first_hit
         FROM hits h`,
        [`%${q.slice(0, 80)}%`, limit],
      );
      const sessions = r.rows.map((row) => {
        const text: string = row.first_hit ?? '';
        const at = text.toLowerCase().indexOf(q.toLowerCase());
        const start = Math.max(0, at - 30);
        return {
          sessionId: row.session_id,
          title: row.title ?? '(未命名会话)',
          hits: Number(row.n),
          lastTime: row.last_time,
          excerpt: (start > 0 ? '…' : '') + text.slice(start, start + 140) + (text.length > start + 140 ? '…' : ''),
        };
      });
      return { ok: true, value: { sessions } };
    } catch (cause) {
      return { ok: false, error: { code: 'internal', message: String((cause as Error).message ?? cause), details: {} } };
    }
  }, { authority: 'trusted-host' }), 'session-query.rpc');
}
