-- 020：模型用量页（资源 › 模型用量）的两条部分索引。
-- dsh_session_events 是 dsh 自己的事件表（2026-08-31 实测 630 万行 / 2.5 GB），只有
-- (session_id, seq) 主键。用量页要按时间窗扫「带 usage 的 assistant/message」，按会话取最新
-- session/title，两者原本都得全表扫，首屏 5s。两条部分索引各只有几千行（实测 96 KB），
-- 但把每条聚合从 ~100ms 降到 ~20ms、Top 会话那条从 2.4s 降到毫秒级。
-- 只读侧索引，不改 dsh 的写路径；IF NOT EXISTS 保证可重复执行。

CREATE INDEX IF NOT EXISTS dsh_session_events_usage
  ON dsh_session_events ("time")
  WHERE type = 'assistant/message' AND data ? 'usage';

CREATE INDEX IF NOT EXISTS dsh_session_events_title
  ON dsh_session_events (session_id, seq DESC)
  WHERE type = 'session/title';
