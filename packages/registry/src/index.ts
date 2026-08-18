import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';

export interface AgentRecord {
  id: string; tenantId: string; name: string; kind: 'domain' | 'assistant';
  runtimeClass: string; preset: string; modelProvider?: string; modelName?: string;
  instructionDoc: string; instructionVersion: number; status: 'active' | 'paused' | 'archived';
  workspaceId?: string;
}
export interface DbNodeRecord {
  id: string; tenantId: string; agentId?: string; groupId?: string; groupRole?: string;
  name: string; engine: 'opengauss' | 'postgresql'; host: string; port: number; dbname: string;
  username?: string; sshTarget?: string; status: string;
}
export interface DbGroupRecord { id: string; tenantId: string; name: string; kind: string }

declare module '@deepseek-ai/cordis' {
  interface Context { opendbRegistry: Registry }
}

function agentRow(r: any): AgentRecord {
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name, kind: r.kind, runtimeClass: r.runtime_class,
    preset: r.preset, modelProvider: r.model_provider ?? undefined, modelName: r.model_name ?? undefined,
    instructionDoc: r.instruction_doc, instructionVersion: r.instruction_version, status: r.status,
    workspaceId: r.workspace_id ?? undefined,
  };
}
function nodeRow(r: any): DbNodeRecord {
  return {
    id: r.id, tenantId: r.tenant_id, agentId: r.agent_id ?? undefined, groupId: r.group_id ?? undefined,
    groupRole: r.group_role ?? undefined, name: r.name, engine: r.engine, host: r.host, port: r.port,
    dbname: r.dbname, username: r.username ?? undefined, sshTarget: r.ssh_target ?? undefined, status: r.status,
  };
}

/**
 * ctx.registry — the platform registry (design §8.1): agents are logical identities in PG;
 * db nodes bind to agents; a dsh workspace is bound 1:1 to an agent (workspace == agent).
 * W2 scope: data layer + agent/node/group CRUD. RPC + slots pages arrive with the client half.
 */
export default class Registry extends Service {
  static Config = z.object({ connectionString: z.string().required(), defaultTenant: z.string().default('default') });
  readonly pool: pg.Pool;
  private readonly ready: Promise<void>;
  private readonly tenant: string;

  constructor(ctx: Context, config: { connectionString: string; defaultTenant?: string }) {
    super(ctx, 'opendbRegistry');
    this.pool = createPool(config.connectionString);
    this.tenant = config.defaultTenant ?? 'default';
    this.ready = runMigrations(this.pool);
    this.ready.catch(() => { /* surfaced on first call */ });
    ctx.effect(() => async () => { await this.ready.catch(() => {}); await this.pool.end(); }, 'registry.pool');
  }

  // ---------------- agents
  async createAgent(input: { name: string; kind?: 'domain' | 'assistant'; runtimeClass?: string; preset?: string; instructionDoc?: string }): Promise<AgentRecord> {
    await this.ready;
    const id = `agent-${randomUUID().slice(0, 8)}`;
    const r = await this.pool.query(
      `INSERT INTO dsh_agents (id, tenant_id, name, kind, runtime_class, preset, instruction_doc)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, this.tenant, input.name, input.kind ?? 'domain', input.runtimeClass ?? 'default', input.preset ?? 'standard', input.instructionDoc ?? ''],
    );
    return agentRow(r.rows[0]);
  }
  async listAgents(): Promise<AgentRecord[]> {
    await this.ready;
    const r = await this.pool.query(`SELECT * FROM dsh_agents WHERE tenant_id = $1 AND status <> 'archived' ORDER BY created_at`, [this.tenant]);
    return r.rows.map(agentRow);
  }
  async getAgent(id: string): Promise<AgentRecord | undefined> {
    await this.ready;
    const r = await this.pool.query('SELECT * FROM dsh_agents WHERE id = $1', [id]);
    return r.rows[0] ? agentRow(r.rows[0]) : undefined;
  }
  async getAgentByName(name: string): Promise<AgentRecord | undefined> {
    await this.ready;
    const r = await this.pool.query('SELECT * FROM dsh_agents WHERE tenant_id = $1 AND name = $2', [this.tenant, name]);
    return r.rows[0] ? agentRow(r.rows[0]) : undefined;
  }
  async getAgentByWorkspace(workspaceId: string): Promise<AgentRecord | undefined> {
    await this.ready;
    const r = await this.pool.query('SELECT * FROM dsh_agents WHERE workspace_id = $1', [workspaceId]);
    return r.rows[0] ? agentRow(r.rows[0]) : undefined;
  }
  async updateAgent(id: string, patch: Partial<Pick<AgentRecord, 'name' | 'runtimeClass' | 'preset' | 'modelProvider' | 'modelName' | 'status' | 'workspaceId'>>): Promise<AgentRecord | undefined> {
    await this.ready;
    const sets: string[] = []; const vals: unknown[] = [id];
    const map: Record<string, string> = { name: 'name', runtimeClass: 'runtime_class', preset: 'preset', modelProvider: 'model_provider', modelName: 'model_name', status: 'status', workspaceId: 'workspace_id' };
    for (const [k, col] of Object.entries(map)) {
      const v = (patch as Record<string, unknown>)[k];
      if (v !== undefined) { vals.push(v); sets.push(`${col} = $${vals.length}`); }
    }
    if (sets.length === 0) return this.getAgent(id);
    const r = await this.pool.query(`UPDATE dsh_agents SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, vals);
    return r.rows[0] ? agentRow(r.rows[0]) : undefined;
  }
  /** Replace the standing instruction document; bumps instruction_version. */
  async setInstructionDoc(id: string, doc: string): Promise<AgentRecord | undefined> {
    await this.ready;
    const r = await this.pool.query(
      `UPDATE dsh_agents SET instruction_doc = $2, instruction_version = instruction_version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, doc],
    );
    return r.rows[0] ? agentRow(r.rows[0]) : undefined;
  }

  // ---------------- db nodes / groups
  async createNode(input: { name: string; engine?: 'opengauss' | 'postgresql'; host: string; port?: number; dbname?: string; username?: string; sshTarget?: string; agentId?: string; groupId?: string; groupRole?: string }): Promise<DbNodeRecord> {
    await this.ready;
    const id = `node-${randomUUID().slice(0, 8)}`;
    const r = await this.pool.query(
      `INSERT INTO dsh_db_nodes (id, tenant_id, name, engine, host, port, dbname, username, ssh_target, agent_id, group_id, group_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [id, this.tenant, input.name, input.engine ?? 'opengauss', input.host, input.port ?? 5432, input.dbname ?? 'postgres', input.username ?? null, input.sshTarget ?? null, input.agentId ?? null, input.groupId ?? null, input.groupRole ?? null],
    );
    return nodeRow(r.rows[0]);
  }
  async listNodes(filter: { agentId?: string } = {}): Promise<DbNodeRecord[]> {
    await this.ready;
    const r = filter.agentId
      ? await this.pool.query('SELECT * FROM dsh_db_nodes WHERE tenant_id = $1 AND agent_id = $2 ORDER BY name', [this.tenant, filter.agentId])
      : await this.pool.query('SELECT * FROM dsh_db_nodes WHERE tenant_id = $1 ORDER BY name', [this.tenant]);
    return r.rows.map(nodeRow);
  }
  /** Collector heartbeat: online/offline/degraded as observed by the last scrape. */
  async updateNodeStatus(nodeId: string, status: 'unknown' | 'online' | 'offline' | 'degraded'): Promise<void> {
    await this.ready;
    await this.pool.query('UPDATE dsh_db_nodes SET status = $2, updated_at = now() WHERE id = $1', [nodeId, status]);
  }

  async assignNode(nodeId: string, agentId: string | null): Promise<void> {
    await this.ready;
    await this.pool.query('UPDATE dsh_db_nodes SET agent_id = $2, updated_at = now() WHERE id = $1', [nodeId, agentId]);
  }
  async createGroup(input: { name: string; kind?: string }): Promise<DbGroupRecord> {
    await this.ready;
    const id = `group-${randomUUID().slice(0, 8)}`;
    const r = await this.pool.query('INSERT INTO dsh_db_groups (id, tenant_id, name, kind) VALUES ($1,$2,$3,$4) RETURNING *', [id, this.tenant, input.name, input.kind ?? 'primary_standby']);
    const row = r.rows[0];
    return { id: row.id, tenantId: row.tenant_id, name: row.name, kind: row.kind };
  }
}
export { Registry };
