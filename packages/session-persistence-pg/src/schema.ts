import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/** Directory holding the ordered, idempotent SQL migration files shipped with this package. */
export const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');

/** Advisory lock key serializing migrations across Host/Runtime processes starting concurrently. */
const MIGRATION_LOCK_KEY = 7_204_211_001;

/** 已应用文件的台账：有它之后稳态启动一条 DDL 都不跑 */
const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS opendb_schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

/**
 * 本进程内迁移失败计数（模块级，所有 PG 服务共享同一份 session-persistence-pg 模块实例）。
 *
 * 2026-08-25 事故：Runtime pod 启动 27s 时某服务的 runMigrations 被判为死锁牺牲方，
 * 该服务 `this.ready` 永久 rejected；pod 仍 Running、readiness 200，却**每次 resume 都在 9ms 内
 * 抛同一个 "deadlock detected"**——认领是它自己从 PG 拉的，摘掉 Service 端点也拦不住。
 * 两台 Runtime 随机认领 → 用户一半消息凭空消失。此计数给 runtime-worker：>0 则拒绝认领 + 健康 503，
 * 配合 livenessProbe 由 k8s 重启自愈。
 */
let failures = 0;
export function migrationFailures(): number { return failures; }

const RETRYABLE = new Set(['55P03', '40P01', '40001']);   // lock_not_available / deadlock_detected / serialization_failure
/** 建台账表这一步额外容忍 23505（并发 CREATE TABLE IF NOT EXISTS 的 duplicate key），重试时表已存在即成功 */
const LEDGER_RETRYABLE = new Set([...RETRYABLE, '23505']);

/**
 * Apply every sql/*.sql in name order that is not yet in the ledger. Files use IF NOT EXISTS so
 * re-running is still safe; the ledger just makes steady-state boots DDL-free（滚动时十几个服务 ×
 * 六个 pod 同时对 dsh_threads/dsh_thread_queue 做 ALTER … IF NOT EXISTS，即便无实际改动也要拿
 * AccessExclusiveLock，与 claimNext 的 FOR UPDATE 互等 → 死锁；PG 日志 04:37:41 实证）。
 *
 * Locking (W4 事故复盘后的形态): each file runs in its own transaction holding a
 * TRANSACTION-scoped advisory lock (pg_advisory_xact_lock) — a session-scoped lock once
 * outlived its zombie client for 32 minutes and stalled every service's startup, because a
 * killed pod's half-open TCP connection kept the session (and its lock) alive. With the
 * xact lock, COMMIT/ROLLBACK/connection death all release it, and the server-side
 * idle_in_transaction_session_timeout (set in the chart) can reap a stuck holder.
 * `SET lock_timeout` happens BEFORE the lock wait so waiting is also bounded.
 * 可重试错误（锁超时 55P03 / 死锁牺牲 40P01 / 串行化失败 40001）退避重试，绝不让一次
 * 瞬时冲突把整个进程的服务永久打死。
 */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  try {
    await runMigrationsInner(pool);
  } catch (err) {
    failures += 1;
    process.stderr.write(`[migrations] FAILED（本进程第 ${failures} 次）：${String((err as Error).message ?? err)}\n`);
    throw err;
  }
}

async function runMigrationsInner(pool: pg.Pool): Promise<void> {
  const files = (await readdir(SQL_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    // 台账表本身：也放进 advisory 事务锁里。IF NOT EXISTS 挡不住两个进程**同时**建表——
    // 第二个会撞 pg_type_typname_nsp_index 的 duplicate key（23505）。2026-08-25 首次上线时 collector
    // 的三个 PG 服务同时启动全撞上，registry.listNodes 随之失败、采集停摆；23505 在此步视为可重试。
    await withRetry(client, async () => {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      await client.query(LEDGER_DDL);
      await client.query('COMMIT');
    }, LEDGER_RETRYABLE);
    const applied = new Set<string>(
      (await client.query<{ name: string }>('SELECT name FROM opendb_schema_migrations')).rows.map((r) => r.name),
    );
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = await readFile(join(SQL_DIR, f), 'utf8');
      await withRetry(client, async () => {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
        // 拿到锁后再查一次：并发启动的另一个进程可能刚把这个文件应用完
        const again = await client.query('SELECT 1 FROM opendb_schema_migrations WHERE name = $1', [f]);
        if (again.rowCount === 0) {
          await client.query(sql);
          await client.query('INSERT INTO opendb_schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [f]);
        }
        await client.query('COMMIT');
      });
    }
  } finally {
    client.release();
  }
}

/** 可重试错误退避重试（最多 60 次、每次 1s），其它错误原样抛 */
async function withRetry(client: pg.PoolClient, step: () => Promise<void>, retryable: ReadonlySet<string> = RETRYABLE): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await step();
      return;
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => { /* 不在事务里或连接已断；下面照常处理 */ });
      const code = (err as { code?: string }).code ?? '';
      if (!retryable.has(code) || attempt >= 60) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
