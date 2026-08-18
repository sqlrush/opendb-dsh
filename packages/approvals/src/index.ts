import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';

export type ApprovalKind = 'report-ack' | 'action';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalRecord {
  id: string; tenantId: string; kind: ApprovalKind; subject: string; payload: unknown;
  refRunId?: string; status: ApprovalStatus; requestedAt: Date;
  decidedBy?: string; decidedAt?: Date; comment?: string; expiresAt?: Date;
}

/** Notification channel seam (G1 冻结): console = no-op (UI polls PG); P2 adds feishu/dingtalk. */
export interface ApprovalProvider { name: string; notify(request: ApprovalRecord): Promise<void> }

declare module '@deepseek-ai/cordis' {
  interface Context { opendbApprovals: ApprovalsService }
}

function row(r: any): ApprovalRecord {
  return {
    id: r.id, tenantId: r.tenant_id, kind: r.kind, subject: r.subject, payload: r.payload,
    refRunId: r.ref_run_id ?? undefined, status: r.status, requestedAt: r.requested_at,
    decidedBy: r.decided_by ?? undefined, decidedAt: r.decided_at ?? undefined,
    comment: r.comment ?? undefined, expiresAt: r.expires_at ?? undefined,
  };
}

/**
 * ctx.opendbApprovals — the platform's human-decision channel (design §8.5, distinct from
 * in-session ask_user: cross-session, audited, expirable, IM-attachable in P2). decide() is
 * the single write path for decisions; providers are notify-only.
 */
export default class ApprovalsService extends Service {
  static Config = z.object({
    connectionString: z.string().required(),
    defaultTenant: z.string().default('default'),
    defaultTtlHours: z.number().step(1).min(1).default(72),
    sweepMs: z.number().step(1).min(10_000).default(300_000),
  });

  readonly pool: pg.Pool;
  private readonly ready: Promise<void>;
  private readonly tenant: string;
  private readonly ttlHours: number;
  private readonly providers = new Map<string, ApprovalProvider>();

  constructor(ctx: Context, config: { connectionString: string; defaultTenant?: string; defaultTtlHours?: number; sweepMs?: number }) {
    super(ctx, 'opendbApprovals');
    this.pool = createPool(config.connectionString);
    this.tenant = config.defaultTenant ?? 'default';
    this.ttlHours = config.defaultTtlHours ?? 72;
    this.ready = runMigrations(this.pool);
    this.ready.catch(() => { /* surfaced on first call */ });
    const sweepMs = config.sweepMs ?? 300_000;
    ctx.effect(() => {
      const timer = setInterval(() => { void this.sweepExpired().catch(() => {}); }, sweepMs);
      return () => clearInterval(timer);
    }, 'opendbApprovals.sweep');
    ctx.effect(() => async () => { await this.ready.catch(() => {}); await this.pool.end(); }, 'opendbApprovals.pool');
  }

  /** Register a notification provider; returns the disposer for ctx.effect. */
  registerProvider(provider: ApprovalProvider): () => void {
    this.providers.set(provider.name, provider);
    return () => { this.providers.delete(provider.name); };
  }

  async request(input: { kind: ApprovalKind; subject: string; payload?: unknown; refRunId?: string; ttlHours?: number }): Promise<ApprovalRecord> {
    await this.ready;
    const id = `appr-${randomUUID().slice(0, 8)}`;
    const expires = new Date(Date.now() + (input.ttlHours ?? this.ttlHours) * 3600_000);
    const r = await this.pool.query(
      `INSERT INTO dsh_approvals (id, tenant_id, kind, subject, payload, ref_run_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, this.tenant, input.kind, input.subject, JSON.stringify(input.payload ?? {}), input.refRunId ?? null, expires],
    );
    const record = row(r.rows[0]);
    for (const p of this.providers.values()) {
      await p.notify(record).catch((cause) => process.stderr.write(`[approvals] provider ${p.name} notify failed: ${String(cause)}\n`));
    }
    return record;
  }

  /** The single decision write path (CAS on pending — a second decider loses cleanly). */
  async decide(id: string, input: { decision: 'approved' | 'rejected'; decidedBy: string; comment?: string }): Promise<ApprovalRecord> {
    await this.ready;
    const r = await this.pool.query(
      `UPDATE dsh_approvals SET status = $2, decided_by = $3, decided_at = now(), comment = $4
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, input.decision, input.decidedBy, input.comment ?? null],
    );
    if (r.rows[0] === undefined) {
      const cur = await this.pool.query('SELECT status FROM dsh_approvals WHERE id = $1', [id]);
      const status = cur.rows[0]?.status;
      throw new Error(status === undefined ? `审批单 ${id} 不存在` : `审批单 ${id} 已是 ${status}，不能重复决定`);
    }
    return row(r.rows[0]);
  }

  async get(id: string): Promise<ApprovalRecord | undefined> {
    await this.ready;
    const r = await this.pool.query('SELECT * FROM dsh_approvals WHERE id = $1', [id]);
    return r.rows[0] ? row(r.rows[0]) : undefined;
  }

  async list(filter: { status?: ApprovalStatus; kind?: ApprovalKind; limit?: number } = {}): Promise<ApprovalRecord[]> {
    await this.ready;
    const conds: string[] = ['tenant_id = $1'];
    const vals: unknown[] = [this.tenant];
    if (filter.status !== undefined) { vals.push(filter.status); conds.push(`status = $${vals.length}`); }
    if (filter.kind !== undefined) { vals.push(filter.kind); conds.push(`kind = $${vals.length}`); }
    vals.push(Math.min(filter.limit ?? 100, 500));
    const r = await this.pool.query(
      `SELECT * FROM dsh_approvals WHERE ${conds.join(' AND ')} ORDER BY requested_at DESC LIMIT $${vals.length}`, vals);
    return r.rows.map(row);
  }

  /** pending 超过 expires_at → expired（漏签在 UI 里持续可见）。 */
  async sweepExpired(): Promise<number> {
    await this.ready;
    const r = await this.pool.query(`UPDATE dsh_approvals SET status = 'expired' WHERE status = 'pending' AND expires_at < now()`);
    return r.rowCount ?? 0;
  }
}
export { ApprovalsService };
