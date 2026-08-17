/**
 * Package-owned invariant companion for `@opendb-dsh/session-persistence-pg`
 * (same shape as dsh-session-persistence-jsonl/invariant).
 */
const PACKAGE_NAME = '@opendb-dsh/session-persistence-pg';
export const name = 'session-persistence-pg-invariant';
export const inject = ['invariants'];
export const apply = (ctx: { invariants: { register(name: string, install: () => void): unknown } }) =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, () => {}));
