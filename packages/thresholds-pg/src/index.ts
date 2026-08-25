/**
 * ctx.opendbThresholds — 平台阈值配置服务（user 2026-08-24：独立插件展示全部报警/判定阈值，
 * 支持会话修改，改完下次采集即生效）。
 *
 * 真相分两层：默认值 = 各插件代码常量（由插件启动时 register 进来，代码即真相）；
 * 覆盖值 = opendb_thresholds 表（只存改过的键）。resolve(plugin) 把两层合并成扁平表，
 * 采集工具用 applyOverrides 套回常量对象的形状后传给判定函数——判定逻辑本身一字不动。
 *
 * 只管数值：比较方向、级别阶梯、规则语义全在各插件里（借鉴成果不大改）。
 */
import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import type pg from 'pg';
import { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';
import { validateRange, validateMonotonic, type ThresholdSpec, type ThresholdValue, type ThresholdTier } from './spec.ts';

export { applyOverrides, flatten, specsFrom, validateRange, validateMonotonic } from './spec.ts';
export type { ThresholdSpec, ThresholdValue, ThresholdUnit, ThresholdTier, ThresholdCmp, Validation } from './spec.ts';

export interface ThresholdChange {
  id: number; plugin: string; key: string;
  oldValue: number | null; newValue: number | null;   // newValue null = 重置回默认
  reason: string; changedBy: string; changedAt: string;
}

export interface ChangeMeta { by?: string; reason?: string }

declare module '@deepseek-ai/cordis' {
  interface Context { opendbThresholds: ThresholdService }
}

const specKey = (plugin: string, key: string): string => `${plugin}/${key}`;

export default class ThresholdService extends Service {
  static Config = z.object({
    connectionString: z.string().required(),
    defaultTenant: z.string().default('default'),
  });

  readonly pool: pg.Pool;
  private readonly ready: Promise<void>;
  private readonly tenant: string;
  /** 已注册规格：插件启动时 register，进程内存，不落库（默认值以代码为准） */
  private specs: ReadonlyMap<string, ThresholdSpec> = new Map();

  constructor(ctx: Context, config: { connectionString: string; defaultTenant?: string }) {
    super(ctx, 'opendbThresholds');
    this.pool = createPool(config.connectionString);
    this.tenant = config.defaultTenant ?? 'default';
    this.ready = runMigrations(this.pool);
    this.ready.catch(() => { /* surfaced on first call */ });
    ctx.effect(() => async () => { await this.ready.catch(() => {}); await this.pool.end(); }, 'opendbThresholds.pool');
  }

  /** 插件注册自己的阈值规格（幂等：同 plugin/key 后注册者覆盖）。返回注销函数供 effect 用。 */
  register(specs: readonly ThresholdSpec[]): () => void {
    const next = new Map(this.specs);
    for (const s of specs) next.set(specKey(s.plugin, s.key), s);
    this.specs = next;
    return () => {
      const after = new Map(this.specs);
      for (const s of specs) after.delete(specKey(s.plugin, s.key));
      this.specs = after;
    };
  }

  /** 全部规格 + 当前值（含覆盖标记），供大盘与 threshold_list */
  async list(plugin?: string): Promise<ThresholdValue[]> {
    await this.ready;
    const r = await this.pool.query(
      'SELECT plugin, key, value, reason, updated_by, updated_at FROM opendb_thresholds WHERE tenant_id = $1', [this.tenant]);
    const over = new Map<string, any>(r.rows.map((row: any) => [specKey(row.plugin, row.key), row]));
    return [...this.specs.values()]
      .filter((s) => plugin === undefined || plugin === '' || s.plugin === plugin)
      .map((s) => {
        const o = over.get(specKey(s.plugin, s.key));
        return o === undefined
          ? { ...s, current: s.default, overridden: false }
          : { ...s, current: Number(o.value), overridden: true, updatedAt: new Date(o.updated_at).toISOString(), updatedBy: String(o.updated_by ?? ''), reason: String(o.reason ?? '') };
      });
  }

  /** 某插件的扁平当前值表（默认 + 覆盖），键 = 点路径。采集工具据此 applyOverrides。 */
  async resolve(plugin: string): Promise<Record<string, number>> {
    const vals = await this.list(plugin);
    return Object.fromEntries(vals.map((v) => [v.key, v.current]));
  }

  /** 修改一个阈值：校验规格存在、取值范围、阶梯单调；写覆盖 + 历史。 */
  async set(plugin: string, key: string, value: number, meta: ChangeMeta = {}): Promise<{ spec: ThresholdSpec; oldValue: number; newValue: number }> {
    await this.ready;
    const spec = this.specs.get(specKey(plugin, key));
    if (spec === undefined) throw new Error(`阈值 ${plugin}.${key} 不存在——用 threshold_list 查看可改的键`);
    const range = validateRange(spec, value);
    if (!range.ok) throw new Error(`${spec.label}：${range.reason}`);
    const all = await this.list(plugin);
    const siblings = spec.group === undefined ? [] : all
      .filter((v) => v.group === spec.group && v.key !== spec.key && v.tier !== undefined)
      .map((v) => ({ tier: v.tier as ThresholdTier, value: v.current }));
    const mono = validateMonotonic(spec, value, siblings);
    if (!mono.ok) throw new Error(`${spec.label}：${mono.reason}`);
    const oldValue = all.find((v) => v.key === key)?.current ?? spec.default;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO opendb_thresholds (plugin, key, value, tenant_id, reason, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (plugin, key, tenant_id) DO UPDATE SET value = EXCLUDED.value, reason = EXCLUDED.reason, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [plugin, key, value, this.tenant, meta.reason ?? '', meta.by ?? '']);
      await client.query(
        `INSERT INTO opendb_threshold_changes (plugin, key, old_value, new_value, reason, changed_by, tenant_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [plugin, key, oldValue, value, meta.reason ?? '', meta.by ?? '', this.tenant]);
      await client.query('COMMIT');
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => {});
      throw cause;
    } finally {
      client.release();
    }
    return { spec, oldValue, newValue: value };
  }

  /** 重置回代码默认值：删覆盖行 + 记历史（new_value NULL）。未覆盖过的键重置是 no-op。 */
  async reset(plugin: string, key: string, meta: ChangeMeta = {}): Promise<{ spec: ThresholdSpec; oldValue: number; newValue: number; changed: boolean }> {
    await this.ready;
    const spec = this.specs.get(specKey(plugin, key));
    if (spec === undefined) throw new Error(`阈值 ${plugin}.${key} 不存在`);
    const cur = (await this.list(plugin)).find((v) => v.key === key);
    if (cur === undefined || !cur.overridden) return { spec, oldValue: spec.default, newValue: spec.default, changed: false };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM opendb_thresholds WHERE plugin = $1 AND key = $2 AND tenant_id = $3', [plugin, key, this.tenant]);
      await client.query(
        `INSERT INTO opendb_threshold_changes (plugin, key, old_value, new_value, reason, changed_by, tenant_id) VALUES ($1,$2,$3,NULL,$4,$5,$6)`,
        [plugin, key, cur.current, meta.reason ?? '', meta.by ?? '', this.tenant]);
      await client.query('COMMIT');
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => {});
      throw cause;
    } finally {
      client.release();
    }
    return { spec, oldValue: cur.current, newValue: spec.default, changed: true };
  }

  async history(limit = 50): Promise<ThresholdChange[]> {
    await this.ready;
    const r = await this.pool.query(
      `SELECT id, plugin, key, old_value, new_value, reason, changed_by, changed_at
       FROM opendb_threshold_changes WHERE tenant_id = $1 ORDER BY changed_at DESC, id DESC LIMIT $2`,
      [this.tenant, Math.max(1, Math.min(limit, 500))]);
    return r.rows.map((row: any) => ({
      id: Number(row.id), plugin: row.plugin, key: row.key,
      oldValue: row.old_value === null ? null : Number(row.old_value),
      newValue: row.new_value === null ? null : Number(row.new_value),
      reason: String(row.reason ?? ''), changedBy: String(row.changed_by ?? ''),
      changedAt: new Date(row.changed_at).toISOString(),
    }));
  }
}
