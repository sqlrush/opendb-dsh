import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';

export const name = 'agent-presets-pg';
export const Config = z.object({
  connectionString: z.string().required(),
  syncMs: z.number().default(60_000),
});

const MANAGED_MARK = '.managed-by-opendb';
const PRESET_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * 预设落库（P3 agent-presets-pg）：PG 表 opendb_agent_presets 是真相；本插件把每行物化成
 * `$DSH_HOME/.agent-presets/<id>/{preset.yml, agent.cordis.yml}`——那是 dsh 原生扫描的
 * user preset root，dsh 机制零改动。多副本各自物化（emptyDir 每 pod 自持）；
 * 删除对账只清带 .managed-by-opendb 标记的目录（不碰人工放置的预设）。
 * 管理面：Host 侧 /opendb-presets RPC（list/upsert/remove——upsert 后 ≤60s 全副本生效）。
 */
export function apply(ctx: Context, config: { connectionString: string; syncMs?: number }): void {
  const anyCtx = ctx as any;
  const pool: pg.Pool = createPool(config.connectionString);
  const root = join(process.env.DSH_HOME ?? '/var/lib/dsh', '.agent-presets');
  const ready = runMigrations(pool);
  ready.catch(() => { /* surfaced on sync */ });

  async function materialize(): Promise<void> {
    await ready;
    const rows = await pool.query(`SELECT id, preset_yml, agent_cordis_yml FROM opendb_agent_presets`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const want = new Set<string>();
    for (const r of rows.rows) {
      if (!PRESET_ID.test(r.id)) { process.stderr.write(`[presets-pg] skip invalid id ${r.id}\n`); continue; }
      want.add(r.id);
      const dir = join(root, r.id);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      for (const [file, content] of [['preset.yml', r.preset_yml], ['agent.cordis.yml', r.agent_cordis_yml], [MANAGED_MARK, '']] as const) {
        const path = join(dir, file);
        const existing = await readFile(path, 'utf8').catch(() => undefined);
        if (existing !== content) await writeFile(path, content, { mode: 0o600 });
      }
    }
    // 删除对账：只清我们管理的目录
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [] as any[])) {
      if (!entry.isDirectory() || want.has(entry.name)) continue;
      const managed = await readFile(join(root, entry.name, MANAGED_MARK), 'utf8').then(() => true).catch(() => false);
      if (managed) await rm(join(root, entry.name), { recursive: true, force: true });
    }
  }

  let timer: NodeJS.Timeout | undefined;
  ctx.effect(() => {
    const loop = async () => {
      try { await materialize(); } catch (cause) {
        process.stderr.write(`[presets-pg] materialize failed: ${String((cause as Error).message ?? cause)}\n`);
      }
      timer = setTimeout(loop, config.syncMs ?? 60_000);
    };
    void loop();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      void pool.end();
    };
  }, 'agent-presets-pg.sync');

  // 管理通道（Host 才有 connection；function inject——Runtime 侧只物化不开管理面）
  anyCtx.inject(['connection'], (c: any) => {
    c.effect(() => c.connection.rpc.handle('/opendb-presets', async (endpoint: string, payload: any): Promise<any> => {
      try {
        await ready;
        switch (endpoint) {
          case 'list': {
            const r = await pool.query(`SELECT id, preset_yml, updated_at FROM opendb_agent_presets ORDER BY id`);
            return { ok: true, value: { presets: r.rows } };
          }
          case 'upsert': {
            const id = String(payload.id ?? '');
            if (!PRESET_ID.test(id)) return { ok: false, error: { code: 'bad-request', message: `invalid preset id ${id}`, details: {} } };
            await pool.query(
              `INSERT INTO opendb_agent_presets (id, preset_yml, agent_cordis_yml) VALUES ($1, $2, $3)
               ON CONFLICT (id) DO UPDATE SET preset_yml = $2, agent_cordis_yml = $3, updated_at = now()`,
              [id, String(payload.presetYml ?? ''), String(payload.agentCordisYml ?? '')]);
            await materialize();
            return { ok: true, value: { id } };
          }
          case 'remove':
            await pool.query(`DELETE FROM opendb_agent_presets WHERE id = $1`, [String(payload.id ?? '')]);
            await materialize();
            return { ok: true, value: { removed: true } };
          default:
            return { ok: false, error: { code: 'bad-request', message: `unknown endpoint ${endpoint}`, details: {} } };
        }
      } catch (cause) {
        return { ok: false, error: { code: 'internal', message: String((cause as Error).message ?? cause), details: {} } };
      }
    }, { authority: 'trusted-host' }), 'agent-presets-pg.rpc');
  });
}
