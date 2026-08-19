import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';

const PG_URL = process.env.PG_URL;
let admin: pg.Pool;

/** P3 越权用例：FORCE RLS 下跨租户读 0 行、跨租户写被 WITH CHECK 拒绝。 */
// ⚠ superuser（含表 owner 之外的 BYPASSRLS）无条件绕过 RLS——FORCE 也不拦。
// 因此校验必须用非特权角色；生产多租户部署要求平台以非超级角色连接（见 CLUSTER.md 部署检查单）。
const PROBE_ROLE = 'opendb_rls_probe';

before(async () => {
  if (!PG_URL) return;
  admin = createPool(PG_URL);
  await runMigrations(admin);
  await admin.query(`INSERT INTO dsh_agents (id, tenant_id, name) VALUES ('agent-rls-t', 'default', 'rls-probe')
                     ON CONFLICT (id) DO NOTHING`);
  await admin.query(`DO $$ BEGIN CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD 'probe-pw'; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await admin.query(`GRANT SELECT, INSERT ON dsh_agents TO ${PROBE_ROLE}`);
});
after(async () => {
  if (!PG_URL) return;
  await admin.query(`DELETE FROM dsh_agents WHERE id = 'agent-rls-t'`).catch(() => {});
  await admin.query(`REVOKE ALL ON dsh_agents FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`).catch(() => {});
  await admin.end();
});

function tenantPool(tenant?: string): pg.Pool {
  const u = new URL(PG_URL!);
  u.username = PROBE_ROLE;
  u.password = 'probe-pw';
  return new pg.Pool({ connectionString: u.toString(), max: 2, ...(tenant !== undefined ? { options: `-c app.tenant=${tenant}` } : {}) });
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
  const bare = tenantPool(undefined);
  try {
    const r = await bare.query(`SELECT count(*)::int AS n FROM dsh_agents`);
    assert.equal(r.rows[0].n, 0, 'connection without app.tenant must see zero rows');
  } finally { await bare.end(); }
});
