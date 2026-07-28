-- M3a. Only what owner-scoping needs; pairings and key_changes arrive with M3b,
-- conversations and turns with M3d.
CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY);

CREATE TABLE IF NOT EXISTS workspaces (
  id            text PRIMARY KEY,
  slack_team_id text UNIQUE NOT NULL,
  installed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id             text PRIMARY KEY,
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slack_user_id  text NOT NULL,
  deactivated_at timestamptz,
  UNIQUE (workspace_id, slack_user_id)
);

CREATE TABLE IF NOT EXISTS endpoints (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name  text NOT NULL DEFAULT '',
  max_sessions int NOT NULL DEFAULT 2,
  public_key   text,
  last_seen_at timestamptz
);

-- subject_kind tells you which of the two a token speaks for; a client token
-- carries an owner, an endpoint token carries the endpoint whose owner it is.
CREATE TABLE IF NOT EXISTS tokens (
  id           text PRIMARY KEY,
  subject_kind text NOT NULL CHECK (subject_kind IN ('client', 'endpoint')),
  subject_id   text NOT NULL,
  hash         text UNIQUE NOT NULL,
  expires_at   timestamptz,
  revoked_at   timestamptz
);

-- Journal frames stay on disk; this row is what makes a read authorizable,
-- since a runId and sessionId alone say nothing about who owns them.
CREATE TABLE IF NOT EXISTS sessions (
  id          text PRIMARY KEY,
  run_id      text NOT NULL,
  endpoint_id text NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  agent       text NOT NULL DEFAULT '',
  model       text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz
);

CREATE INDEX IF NOT EXISTS sessions_run_idx ON sessions (run_id);
CREATE INDEX IF NOT EXISTS endpoints_user_idx ON endpoints (user_id);
