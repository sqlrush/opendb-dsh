import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantInfo { tenantId: string }

declare module '@deepseek-ai/cordis' {
  interface Context { tenantContext: TenantContext }
}

/**
 * ctx.tenantContext — who is the current tenant. MVP: a single default tenant; the value is
 * already carried in every opendb table (tenant_id) and PG RLS policies exist (not forced), so
 * multi-tenancy is a data/config switch later, not a schema change.
 */
export default class TenantContext extends Service {
  static Config = z.object({ defaultTenant: z.string().default('default') });
  private readonly als = new AsyncLocalStorage<TenantInfo>();
  private readonly defaultTenant: string;
  constructor(ctx: Context, config: { defaultTenant?: string } = {}) {
    super(ctx, 'tenantContext');
    this.defaultTenant = config.defaultTenant ?? 'default';
  }
  /** Tenant of the current async context (falls back to the deployment default). */
  current(): TenantInfo { return this.als.getStore() ?? { tenantId: this.defaultTenant }; }
  /** Run `fn` with a specific tenant bound to the async context. */
  withTenant<T>(tenantId: string, fn: () => T): T { return this.als.run({ tenantId }, fn); }
  /** SQL to scope a PG session/transaction to the current tenant (used with RLS): SET LOCAL app.tenant_id. */
  sessionSetup(): { text: string; values: unknown[] } { return { text: `SELECT set_config('app.tenant_id', $1, true)`, values: [this.current().tenantId] }; }
}
export { TenantContext };
