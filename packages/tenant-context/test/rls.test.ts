import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';

const PG_URL = process.env.PG_URL;
let admin: pg.Pool;

/** P3 越权用例：FORCE RLS 下跨租户读 0 行、跨租户写被 WITH CHECK 拒绝。 */
before(async () => {
  if (!PG_URL) return;
  admin = createPool(PG_URL);                       // app.tenant=default（env 未设）
  await runMigrations(admin);
  await admin.query(`INSERT INTO dsh_agents (id, tenant_id, name) VALUES ('agent-rls-t', 'default', 'rls-probe')
                     ON CONFLICT (id) DO NOTHING`);
});
after(async () => {
  if (!PG_URL) return;
  await admin.query(`DELETE FROM dsh_agents WHERE id = 'agent-rls-t'`).catch(() => {});
  await admin.end();
});

function tenantPool(tenant: string): pg.Pool {
  return new pg.Pool({ connectionString: PG_URL, max: 2, options: `-c app.tenant=${tenant}` });
}

test('same tenant sees rows; foreign tenant sees zero', { skip: !PG_URL }, async () => {
  const own = tenantPool('default');
  const foreign = tenantPool('mallory');
  try {
    const mine = await own.query(`SELECT count(*)::int AS n FROM dsh_agents WHERE id = 'agent-rls-t'`);
    assert.equal(mine.rows[0].n, 1);
    const theirs = await foreign.query(`SELECT count(*)::int AS n FROM dsh_agents WHERE id = 'agent-rls-t'`);
    assert.equal(theirs.rows[0].n, 0, 'FORCE RLS must hide foreign tenant rows');
  } finally { await own.end(); await foreign.end(); }
});

test('cross-tenant insert rejected by WITH CHECK', { skip: !PG_URL }, async () => {
  const foreign = tenantPool('mallory');
  try {
    await assert.rejects(
      foreign.query(`INSERT INTO dsh_agents (id, tenant_id, name) VALUES ('agent-rls-x', 'default', 'smuggle')`),
      /row-level security|violates/i,
    );
  } finally { await foreign.end(); }
});

test('no tenant GUC sees nothing (fail closed)', { skip: !PG_URL }, async () => {
  const bare = new pg.Pool({ connectionString: PG_URL, max: 2 });
  try {
    const r = await bare.query(`SELECT count(*)::int AS n FROM dsh_agents`);
    assert.equal(r.rows[0].n, 0, 'connection without app.tenant must see zero rows');
  } finally { await bare.end(); }
});
