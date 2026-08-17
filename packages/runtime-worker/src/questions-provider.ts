import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/**
 * Runtime-side UserQuestionProvider: dsh's ask_user is an in-memory promise, so across
 * processes the question is written to PG and the answer polled back. The Host-side
 * ProxyAgent picks the row up and shows it through dsh's native question UI.
 */
export class PgUserQuestionProvider {
  private readonly pool: pg.Pool;
  private readonly pollMs: number;
  constructor(pool: pg.Pool, pollMs = 500) { this.pool = pool; this.pollMs = pollMs; }

  async ask(request: { questions: unknown[]; agent?: { id: string }; signal?: AbortSignal }): Promise<unknown> {
    const sessionId = request.agent?.id;
    if (!sessionId) throw new Error('ask_user requires an agent-owned session');
    const id = randomUUID();
    await this.pool.query('INSERT INTO dsh_questions (id, session_id, questions) VALUES ($1, $2, $3)', [
      id, sessionId, JSON.stringify(request.questions),
    ]);
    for (;;) {
      request.signal?.throwIfAborted();
      const r = await this.pool.query<{ answer: unknown }>('SELECT answer FROM dsh_questions WHERE id = $1 AND answer IS NOT NULL', [id]);
      if (r.rowCount) return r.rows[0].answer;
      await new Promise((res) => setTimeout(res, this.pollMs));
    }
  }
}
