-- opendb-dsh P0 schema: dsh session persistence + thread queue + questions bridge.
-- Idempotent (IF NOT EXISTS). Applied by runMigrations() at provider startup.
CREATE TABLE IF NOT EXISTS dsh_sessions (
  id           text PRIMARY KEY,
  header       jsonb NOT NULL,
  repair_gen   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dsh_session_events (
  session_id        text NOT NULL REFERENCES dsh_sessions(id),
  seq               integer NOT NULL,
  type              text NOT NULL,
  time              bigint NOT NULL,
  data              jsonb NOT NULL,
  ignorable         boolean,
  surface_op        text,
  source_event_seqs integer[],
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS dsh_threads (
  session_id    text PRIMARY KEY REFERENCES dsh_sessions(id),
  runtime_class text NOT NULL DEFAULT 'default',
  status        text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','running','interrupted')),
  running_pod   text,
  heartbeat_at  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dsh_thread_queue (
  id          bigserial PRIMARY KEY,
  session_id  text NOT NULL REFERENCES dsh_sessions(id),
  kind        text NOT NULL CHECK (kind IN ('queued','interrupt')),
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  admitted_at timestamptz,
  admitted_by text
);
CREATE INDEX IF NOT EXISTS dsh_thread_queue_pending ON dsh_thread_queue (id) WHERE admitted_at IS NULL;
CREATE TABLE IF NOT EXISTS dsh_questions (
  id          uuid PRIMARY KEY,
  session_id  text NOT NULL REFERENCES dsh_sessions(id),
  questions   jsonb NOT NULL,
  answer      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);
