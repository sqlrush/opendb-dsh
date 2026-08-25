import type { Context } from '@deepseek-ai/cordis';

export const name = 'ui-opendb';
export const inject = ['connection', 'webServer', 'opendbRegistry', 'opendbTasks', 'opendbMetrics', 'opendbDictionary', 'opendbThresholds'];

type RpcResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } };

function bad(message: string): RpcResult {
  return { ok: false, error: { code: 'bad-request', message, details: {} } };
}

/**
 * Host half of the OpenDB management UI: the `/opendb` RPC channel (design §research:
 * single-segment channel via connection.rpc.handle; POST /opendb/<endpoint> with the
 * client-request envelope). The browser half (lib/client.js) renders a settings section
 * that drives these endpoints.
 */
export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  const registry = anyCtx.opendbRegistry;
  const tasks = anyCtx.opendbTasks;
  const thresholds = anyCtx.opendbThresholds;

  // agent 工作区目录 reconcile（幂等，启动即跑 + 每 60s 周期）：initContainer 是第一道防线；
  // P3 多副本下运行期新建的 agent 只在处理请求的副本上 mkdir——周期 reconcile 把目录补齐到
  // 每个副本（目录缺失会让 dsh workspace 把 sessionIds 裁光，2026-08-19 事故复盘见 CLUSTER.md）。
  const reconcileDirs = async (): Promise<void> => {
    try {
      const { mkdir } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const agents = await registry.listAgents();
      for (const a of agents) {
        await mkdir(join(process.env.DSH_HOME ?? '/var/lib/dsh', 'agents', a.name), { recursive: true, mode: 0o700 });
      }
    } catch (cause) {
      process.stderr.write(`[ui-opendb] agent dir reconcile failed: ${String((cause as Error).message ?? cause)}\n`);
    }
  };
  ctx.effect(() => {
    void reconcileDirs();
    const timer = setInterval(() => void reconcileDirs(), 60_000);
    return () => clearInterval(timer);
  }, 'ui-opendb.agentDirs');

  ctx.effect(() => anyCtx.connection.rpc.handle('/opendb', async (endpoint: string, payload: any, _signal: AbortSignal): Promise<RpcResult> => {
    try {
      switch (endpoint) {
        case 'agents/list': {
          const agents = await registry.listAgents();
          const nodes = await registry.listNodes();
          const counts = new Map<string, number>();
          for (const n of nodes) if (n.agentId) counts.set(n.agentId, (counts.get(n.agentId) ?? 0) + 1);
          return { ok: true, value: { agents: agents.map((a: any) => ({ ...a, nodeCount: counts.get(a.id) ?? 0 })) } };
        }
        case 'agents/update': {
          if (typeof payload?.id !== 'string') return bad('id required');
          const updated = await registry.updateAgent(payload.id, payload.patch ?? {});
          return updated ? { ok: true, value: { agent: updated } } : bad(`agent ${payload.id} not found`);
        }
        case 'agents/setInstructions': {
          if (typeof payload?.id !== 'string' || typeof payload?.doc !== 'string') return bad('id and doc required');
          const updated = await registry.setInstructionDoc(payload.id, payload.doc);
          return updated ? { ok: true, value: { agent: updated } } : bad(`agent ${payload.id} not found`);
        }
        case 'nodes/list':
          return { ok: true, value: { nodes: await registry.listNodes(typeof payload?.agentId === 'string' ? { agentId: payload.agentId } : {}) } };
        case 'nodes/create': {
          if (typeof payload?.name !== 'string' || typeof payload?.host !== 'string') return bad('name and host required');
          const node = await registry.createNode({
            name: payload.name, host: payload.host,
            port: typeof payload.port === 'number' ? payload.port : undefined,
            engine: payload.engine === 'postgresql' ? 'postgresql' : 'opengauss',
            dbname: typeof payload.dbname === 'string' ? payload.dbname : undefined,
            username: typeof payload.username === 'string' ? payload.username : undefined,
            sshTarget: typeof payload.sshTarget === 'string' ? payload.sshTarget : undefined,
            agentId: typeof payload.agentId === 'string' ? payload.agentId : undefined,
          });
          return { ok: true, value: { node } };
        }
        case 'nodes/assign': {
          if (typeof payload?.nodeId !== 'string') return bad('nodeId required');
          await registry.assignNode(payload.nodeId, typeof payload.agentId === 'string' ? payload.agentId : null);
          return { ok: true, value: {} };
        }
        // ── W5.5：agent 创建与工作区定位（自研侧栏用）──────────────────
        case 'agents/create': {
          if (typeof payload?.name !== 'string' || payload.name.trim() === '') return bad('name required');
          const name = payload.name.trim();
          if (!/^[\w-]{1,40}$/.test(name)) return bad('名称只能包含字母/数字/下划线/连字符（≤40 字符）');
          const agent = await registry.createAgent({ name });
          const { mkdir } = await import('node:fs/promises');
          const { join } = await import('node:path');
          await mkdir(join(process.env.DSH_HOME ?? '/var/lib/dsh', 'agents', name), { recursive: true, mode: 0o700 });
          return { ok: true, value: { agent } };
        }
        case 'workspaces/find': {
          if (typeof payload?.agentName !== 'string') return bad('agentName required');
          const r = await tasks.pool.query(
            `SELECT key FROM dsh_kv_records
             WHERE unit = 'workspace' AND tbl = 'workspaces' AND value->>'path' ~ ('/agents/' || $1 || '/?$')
             LIMIT 1`,
            [payload.agentName],
          );
          return { ok: true, value: { workspaceId: r.rows[0]?.key } };
        }
        // ── W5.5：会话列表（自研侧栏用）。归属真相 = workspace kv 的 sessionIds
        //（持久化的 request/header 只含 tools，没有 cwd —— 不能用 cwd 过滤）。
        case 'sessions/list': {
          const limit = Math.min(Number(payload?.limit ?? 30), 100);
          const agentName = typeof payload?.agentName === 'string' ? payload.agentName : undefined;
          const scope = agentName !== undefined
            ? `JOIN (SELECT jsonb_array_elements_text(value->'sessionIds') AS sid
                     FROM dsh_kv_records
                     WHERE unit = 'workspace' AND tbl = 'workspaces'
                       AND value->>'path' ~ ('/agents/' || $2 || '/?$')) ws ON ws.sid = e.session_id`
            : '';
          const vals: unknown[] = agentName !== undefined ? [limit, agentName] : [limit];
          const r = await tasks.pool.query(
            `SELECT e.session_id,
                    max(e.time) AS last_time,
                    (SELECT t.data->>'title' FROM dsh_session_events t
                     WHERE t.session_id = e.session_id AND t.type = 'session/title'
                     ORDER BY t.seq DESC LIMIT 1) AS title
             FROM dsh_session_events e
             ${scope}
             GROUP BY e.session_id
             -- 任务运行会话不进侧栏（2026-08-23 user 报障：连点「立即运行」灌进 14 条同名会话）。
             -- 放 HAVING 而非 WHERE：每组只判一次，不对上百万事件行逐行反查。
             -- 双判据：run 行还在时靠外键认；run 被删（tasks/remove 会级联删）后会话成孤儿，
             -- 靠 engine 注入的固定前缀「【任务运行】」认——只认前缀不认标题，标题会被 LLM 改写。
             HAVING NOT EXISTS (SELECT 1 FROM dsh_task_runs tr WHERE tr.session_id = e.session_id)
                AND NOT EXISTS (SELECT 1 FROM dsh_session_events x
                                WHERE x.session_id = e.session_id
                                  AND x.type = 'user/message'
                                  AND coalesce(x.data->'source'->>'kind', 'user') = 'user'
                                  AND x.data->'content'->0->>'text' LIKE '【任务运行】%')
                -- 已归档会话（dsh 原生 registry-global 归档集）。在后端认而不在前端认：
                -- 原生把它暴露成组件内 useWorkspaces store，ctx.workspaces 上没有这个属性
                -- （2026-08-24 user 报「点归档没反馈」的根因——归档其实成功了，是列表不知道）。
                AND NOT EXISTS (
                      SELECT 1 FROM dsh_kv_units u
                      CROSS JOIN LATERAL jsonb_array_elements_text(
                        coalesce(u.global->'archivedSessionIds', '[]'::jsonb)) a(sid)
                      WHERE u.unit = 'workspace' AND a.sid = e.session_id)
                -- 空会话不进列表（对齐 dsh 原生的 blank 语义：新建即 blank，发出第一条消息
                -- 才转为非 blank；原生的显示规则是 !blank || id === current，那个例外是为了
                -- 让当前会话保持高亮，而我们的侧栏是纯 CSS hover、无持久选中态，所以不需要）。
                -- 判据 = 有没有真人消息：插件注入的上下文（instructions-pg/memory-context 等）
                -- 同样落成 user/message，必须按 source.kind 排除，否则空会话也会有 4~5 条事件。
                AND EXISTS (SELECT 1 FROM dsh_session_events x
                            WHERE x.session_id = e.session_id
                              AND x.type = 'user/message'
                              AND coalesce(x.data->'source'->>'kind', 'user') = 'user')
             ORDER BY max(e.time) DESC
             LIMIT $1`,
            vals,
          );
          const sessions = r.rows.map((row: any) => ({
            sessionId: row.session_id,
            title: row.title ?? '(未命名会话)',
            lastAt: Number(row.last_time),
          }));
          return { ok: true, value: { sessions } };
        }
        // ── W5.5：节点监控详情（最新指标 + 24h 降采样趋势 + 字典变更）────
        case 'nodes/detail': {
          if (typeof payload?.nodeId !== 'string') return bad('nodeId required');
          const nodes = await registry.listNodes();
          const node = nodes.find((n: any) => n.id === payload.nodeId);
          if (node === undefined) return bad(`node ${payload.nodeId} not found`);
          const latest = await anyCtx.opendbMetrics.latest(node.id);
          // 24h 趋势：15 分钟桶均值（通用 SQL，不依赖 time_bucket）
          const SERIES_METRICS = ['db.sessions.active', 'db.sessions.idle', 'db.waiting_locks', 'db.connections_used_ratio'];
          const sr = await tasks.pool.query(
            `SELECT metric,
                    floor(extract(epoch FROM time) / 900) * 900 AS bucket,
                    avg(value) AS v
             FROM opendb_metrics
             WHERE node_id = $1 AND metric = ANY($2) AND time > now() - interval '24 hours'
             GROUP BY metric, bucket ORDER BY bucket`,
            [node.id, SERIES_METRICS],
          );
          const series: Record<string, { t: number; v: number }[]> = {};
          for (const row of sr.rows) {
            (series[row.metric] ??= []).push({ t: Number(row.bucket) * 1000, v: Number(row.v) });
          }
          const changes = await anyCtx.opendbDictionary.changes({ nodeId: node.id, sinceHours: 24 * 7, limit: 30 });
          return {
            ok: true,
            value: {
              node,
              latest: latest.map((m: any) => ({ metric: m.metric, value: m.value, time: m.time })),
              series,
              dictChanges: changes.map((c: any) => ({ time: c.time, change: c.change, kind: c.kind, object: `${c.sch}.${c.name}` })),
            },
          };
        }
        // ── W4：任务与审批 ─────────────────────────────────────────────
        case 'tasks/types':
          return { ok: true, value: { types: tasks.listTypes() } };
        case 'tasks/list': {
          const list = await tasks.listTasks();
          const runs = await tasks.listRuns({ limit: 200 });
          const lastByTask = new Map<string, any>();
          for (const r of runs) if (!lastByTask.has(r.taskId)) lastByTask.set(r.taskId, r);
          // 归档集一次查全：侧栏据此隐藏，任务页仍可经 archived:true 看到（归档 ≠ 删除）
          const arch = await tasks.pool.query('SELECT task_id FROM opendb_archived_tasks');
          const archived = new Set<string>(arch.rows.map((r: any) => r.task_id));
          const enriched = [];
          for (const t of list) {
            const last = lastByTask.get(t.id);
            const report = last !== undefined ? await tasks.getReport(last.id) : undefined;
            enriched.push({
              ...t, lastRun: last, archived: archived.has(t.id),
              lastReport: report ? { severity: report.severity, summary: report.summary } : undefined,
            });
          }
          return { ok: true, value: { tasks: enriched } };
        }
        // 任务归档（user 2026-08-24：对齐 dsh 原生「归档会话」的三点菜单）。
        // 会话归档不走这里——那是 dsh 原生能力，客户端 ctx.workspaces.archiveSession 直连。
        case 'tasks/archive':
        case 'tasks/unarchive': {
          if (typeof payload?.id !== 'string' || payload.id === '') return bad('id required');
          if (endpoint === 'tasks/archive') {
            await tasks.pool.query(
              'INSERT INTO opendb_archived_tasks (task_id) VALUES ($1) ON CONFLICT DO NOTHING', [payload.id]);
          } else {
            await tasks.pool.query('DELETE FROM opendb_archived_tasks WHERE task_id = $1', [payload.id]);
          }
          return { ok: true, value: { id: payload.id, archived: endpoint === 'tasks/archive' } };
        }
        case 'tasks/create': {
          if (typeof payload?.agentId !== 'string' || typeof payload?.type !== 'string' || typeof payload?.name !== 'string') return bad('agentId, type, name required');
          const task = await tasks.createTask({
            agentId: payload.agentId, type: payload.type, name: payload.name,
            config: payload.config ?? {},
            cron: typeof payload.cron === 'string' && payload.cron !== '' ? payload.cron : undefined,
          });
          return { ok: true, value: { task } };
        }
        case 'tasks/update': {
          if (typeof payload?.id !== 'string') return bad('id required');
          const task = await tasks.updateTask(payload.id, payload.patch ?? {});
          return task ? { ok: true, value: { task } } : bad(`task ${payload.id} not found`);
        }
        case 'tasks/remove': {
          if (typeof payload?.id !== 'string') return bad('id required');
          await tasks.removeTask(payload.id);
          return { ok: true, value: {} };
        }
        case 'tasks/runNow': {
          if (typeof payload?.id !== 'string') return bad('id required');
          return { ok: true, value: { run: await tasks.runNow(payload.id) } };
        }
        case 'runs/list': {
          const list = await tasks.listRuns({ taskId: typeof payload?.taskId === 'string' ? payload.taskId : undefined, limit: 20 });
          const enriched = [];
          for (const r of list) {
            const report = await tasks.getReport(r.id);
            enriched.push({ ...r, report: report ? { severity: report.severity, summary: report.summary, data: report.data } : undefined });
          }
          return { ok: true, value: { runs: enriched } };
        }
        // ── 平台阈值（task-thresholds 大盘用，只读；修改走会话里的 threshold_set 确认流）──
        case 'thresholds/list': {
          const plugin = typeof payload?.plugin === 'string' && payload.plugin !== '' ? payload.plugin : undefined;
          return { ok: true, value: { items: await thresholds.list(plugin) } };
        }
        case 'thresholds/history': {
          const limit = Math.max(1, Math.min(Number(payload?.limit ?? 30), 200));
          return { ok: true, value: { changes: await thresholds.history(limit) } };
        }
        // approvals/* 端点已下线（2026-08-21：平台聚焦模型分析+只读展示，审批签收随之移除）
        default:
          return bad(`unknown endpoint ${endpoint}`);
      }
    } catch (cause) {
      return { ok: false, error: { code: 'internal', message: String(cause), details: {} } };
    }
  }, { authority: 'trusted-host' }), 'ui-opendb./opendb');
}
