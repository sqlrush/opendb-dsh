import type pg from 'pg';

interface StoredEvent { seq: number; type: string; data: unknown; surfaceOp?: string; sourceEventSeqs?: number[] }
interface ReadFromLike { readFrom(id: any, fromSeq: number): Promise<{ events: StoredEvent[] }> }
interface SessionLike { id: any; seq: number; append(type: any, data: any, opts?: any): unknown }

/**
 * Mirror events that another process persisted into this process's live Session by
 * appending them one by one. The Host never writes its own session events, so local seq
 * (= log length) always lines up with the persisted seq; anything non-contiguous is
 * left for the next tick.
 */
export async function mirrorOnce(persistence: ReadFromLike, session: SessionLike): Promise<number> {
  const { events } = await persistence.readFrom(session.id, session.seq);
  let n = 0;
  for (const ev of events) {
    if (ev.seq !== session.seq) break;
    if (ev.surfaceOp !== undefined) {
      session.append(ev.type, ev.data, { surfaceOp: ev.surfaceOp, ...(ev.sourceEventSeqs ? { sourceEventSeqs: ev.sourceEventSeqs } : {}) });
    } else {
      session.append(ev.type, ev.data);
    }
    n++;
  }
  return n;
}

/**
 * Bridge Runtime-raised ask_user questions: for each unanswered dsh_questions row of this
 * session, call the Host's ctx.userQuestions.ask() (dsh's native web UI answers it) and
 * write the answer back for the Runtime provider that is polling.
 */
export async function bridgeQuestionsOnce(pool: pg.Pool, ctx: any, agent: { id: any }, inFlight: Set<string>): Promise<void> {
  const r = await pool.query<{ id: string; questions: unknown[] }>('SELECT id, questions FROM dsh_questions WHERE session_id = $1 AND answer IS NULL', [agent.id]);
  for (const row of r.rows) {
    if (inFlight.has(row.id)) continue;
    inFlight.add(row.id);
    void ctx.userQuestions
      .ask({ questions: row.questions, agent })
      .then((answer: unknown) => pool.query('UPDATE dsh_questions SET answer = $2, answered_at = now() WHERE id = $1', [row.id, JSON.stringify(answer)]))
      .catch(() => pool.query('UPDATE dsh_questions SET answer = $2, answered_at = now() WHERE id = $1', [row.id, JSON.stringify({ answers: [] })]))
      .finally(() => inFlight.delete(row.id));
  }
}
