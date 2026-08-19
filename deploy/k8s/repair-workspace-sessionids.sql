-- 修复 workspace kv 的 sessionIds 被裁事故（复盘见 CLUSTER.md 2026-08-19）。
-- 机理：host pod 无卷时 /var/lib/dsh/agents/<name> 重启即失 → dsh workspace 启动校验
-- header.cwd 目录失败 → 历史会话全部标 invalid → 首次 mutate 把裁剪结果持久化。
-- 本脚本从 dsh_sessions.header.cwd 反推归属，重建每个 workspace 的 sessionIds（新会话在前）。
-- ⚠ 执行完必须立刻重启 host（dsh 内存里还是旧记录，下一次 mutate 会覆盖回去）。
-- 用法：kubectl -n opendb-dsh exec -i opendb-dsh-postgres-0 -- psql -U dsh -d dsh < 本文件

WITH want AS (
  SELECT r.key,
         (SELECT jsonb_agg(s.id ORDER BY (s.header->>'createdAt')::bigint DESC)
            FROM dsh_sessions s
           WHERE s.header->>'cwd' = r.value->>'path') AS ids
    FROM dsh_kv_records r
   WHERE r.unit = 'workspace' AND r.tbl = 'workspaces'
)
UPDATE dsh_kv_records r
   SET value = jsonb_set(r.value, '{sessionIds}', w.ids, false), updated_at = now()
  FROM want w
 WHERE r.unit = 'workspace' AND r.tbl = 'workspaces' AND r.key = w.key
   AND w.ids IS NOT NULL AND w.ids <> r.value->'sessionIds';

SELECT key, value->>'path' AS path, jsonb_array_length(value->'sessionIds') AS sessions
  FROM dsh_kv_records WHERE unit = 'workspace' AND tbl = 'workspaces';
