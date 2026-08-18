/**
 * Resolve the platform agent record for the dsh agent a tool call runs under
 * (same convention as instructions-pg): workspace binding first, then the
 * `$DSH_HOME/agents/<name>` cwd pattern.
 */
export interface ResolvedAgent { id: string; name: string }

export async function resolvePlatformAgent(registry: any, dshAgent: any): Promise<ResolvedAgent | undefined> {
  const header = dshAgent?.session?.header;
  const workspaceId = header?.metadata?.workspaceId ?? header?.workspaceId;
  if (workspaceId) {
    const byWs = await registry.getAgentByWorkspace(String(workspaceId));
    if (byWs) return { id: byWs.id, name: byWs.name };
  }
  const cwd: string | undefined = header?.cwd;
  const m = cwd ? /\/agents\/([^/]+)\/?$/.exec(cwd) : null;
  if (m) {
    const byName = await registry.getAgentByName(decodeURIComponent(m[1]));
    if (byName) return { id: byName.id, name: byName.name };
  }
  return undefined;
}
