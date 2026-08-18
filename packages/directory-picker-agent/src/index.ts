import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { DirectoryPicker, DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';

/**
 * "Pick a directory" becomes "pick an agent" (design §3.6 工作区 = agent), with ZERO client
 * changes: this Host provider serves the browse capability that dsh's stock
 * `dsh-client-ui-directory-picker-browse` UI consumes.
 *
 * - list() shows one entry per registry agent, at the real path `$DSH_HOME/agents/<name>`
 *   (created on the fly — dsh's workspace layer realpath()s and stat()s the directory).
 * - createDirectory(name) creates a registry agent of that name and returns its path, so the
 *   stock "Add workspace" flow doubles as "create agent".
 * - Browsing is rooted: crumbs never leave the agents root.
 */
export default class AgentDirectoryPicker extends DirectoryPicker {
  static inject = ['opendbRegistry'];
  static Config = z.object({ agentsRoot: z.string() });
  private readonly root: string;
  private readonly registry: any;
  private readonly browse: { kind: 'browse'; list: (path?: string, signal?: AbortSignal) => Promise<any>; createDirectory: (path: string, name: string) => Promise<string> };

  constructor(ctx: Context, config: { agentsRoot?: string } = {}) {
    super(ctx);
    this.root = resolve(config.agentsRoot ?? join(resolveDshHome(), 'agents'));
    this.registry = (ctx as any).opendbRegistry;
    // capability object must stay identity-stable for the service lifetime
    this.browse = {
      kind: 'browse',
      list: (path?: string, signal?: AbortSignal) => this.list(path, signal),
      createDirectory: (path: string, name: string) => this.createAgentDirectory(path, name),
    };
  }

  capability() { return this.browse; }

  /** Ensure the on-disk directory for an agent exists and return its absolute path. */
  async ensureAgentDir(agentName: string): Promise<string> {
    const dir = join(this.root, agentName);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private async list(_path?: string, _signal?: AbortSignal) {
    try {
      const agents = await this.registry.listAgents();
      const entries = [];
      for (const a of agents) entries.push({ name: a.name, path: await this.ensureAgentDir(a.name), hidden: false });
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      return {
        path: this.root,
        home: this.root,
        crumbs: [{ name: 'agents', path: this.root, hidden: false }],
        entries,
        truncated: false,
      };
    } catch (cause) {
      throw new DirectoryPickerError('directory-unreadable', this.root, `cannot list agents: ${String(cause)}`);
    }
  }

  private async createAgentDirectory(_path: string, name: string): Promise<string> {
    const existing = (await this.registry.listAgents()).find((a: any) => a.name === name);
    if (existing) throw new DirectoryPickerError('directory-exists', join(this.root, name), `agent "${name}" already exists`);
    try {
      await this.registry.createAgent({ name });
      return await this.ensureAgentDir(name);
    } catch (cause) {
      throw new DirectoryPickerError('directory-create-failed', join(this.root, name), `cannot create agent "${name}": ${String(cause)}`);
    }
  }
}
export { AgentDirectoryPicker };
