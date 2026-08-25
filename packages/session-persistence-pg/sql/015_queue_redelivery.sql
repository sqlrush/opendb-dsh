-- 2026-08-25 队列重投 + 原生排队可见（中毒 Runtime 事故复盘）：
--   message_id  Host 生成的消息 id 原样透传，Runtime 用同一 id 落 user/message，Host 据此判断「已持久化」
--   attempts    运行失败次数；< 上限则 admitted 置空由任何 pod 重领，达到上限记 failed_at（死信）
--   failed_at   终判失败时间；reported_at = Host 已把失败以 agent/error 报给用户
--   last_error  最后一次失败原因（排障用）
--   kind=steer  运行中插队（原生 updateQueue 的 steer 动作 / composer steer 模式）
ALTER TABLE dsh_thread_queue ADD COLUMN IF NOT EXISTS message_id  text;
ALTER TABLE dsh_thread_queue ADD COLUMN IF NOT EXISTS attempts    int NOT NULL DEFAULT 0;
ALTER TABLE dsh_thread_queue ADD COLUMN IF NOT EXISTS failed_at   timestamptz;
ALTER TABLE dsh_thread_queue ADD COLUMN IF NOT EXISTS reported_at timestamptz;
ALTER TABLE dsh_thread_queue ADD COLUMN IF NOT EXISTS last_error  text;
ALTER TABLE dsh_thread_queue DROP CONSTRAINT IF EXISTS dsh_thread_queue_kind_check;
ALTER TABLE dsh_thread_queue ADD CONSTRAINT dsh_thread_queue_kind_check CHECK (kind IN ('queued','interrupt','steer'));
CREATE INDEX IF NOT EXISTS dsh_thread_queue_session_open ON dsh_thread_queue (session_id, id) WHERE failed_at IS NULL;
-- 排队投影的「已持久化」判定：按会话 + 消息 id 命中 user/message（客户端每秒查一次）
CREATE INDEX IF NOT EXISTS dsh_session_events_user_message_id
  ON dsh_session_events (session_id, (data->>'id')) WHERE type = 'user/message';
