-- 任务归档（user 2026-08-24：侧栏列表右侧三点菜单「归档任务」）。
-- 只管任务：会话归档走 dsh 原生（workspace registry 的 archivedSessionIds +
-- workspace.archiveSession，客户端 ctx.workspaces 直接可用），不重复造。
-- 任务是 opendb 自己的概念，dsh 没有，所以这里补一张旁路表——不给 dsh_tasks 加字段，
-- 归档是侧栏展示状态而非任务领域模型；任务被删后留下的悬挂行不影响正确性（查询用 NOT EXISTS）。
CREATE TABLE IF NOT EXISTS opendb_archived_tasks (
  task_id     text        NOT NULL,
  tenant_id   text        NOT NULL DEFAULT 'default',
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, tenant_id)
);
