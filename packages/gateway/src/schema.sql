-- M3a. Only what owner-scoping needs; pairings and key_changes arrive with M3b,
-- conversations and turns with M3d. openStore applies this file as-is, so every
-- statement is IF NOT EXISTS; a real migration runner arrives with the first
-- change that cannot be expressed that way.

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
--
-- `id` is the key on its own, and has to stay that way while it is also the
-- journal's filename, the relay's map key and the stream registry's. Scoping it
-- per endpoint here alone let two tenants hold rows that address ONE file, so
-- each could read and delete the other's frames. The caller-chosen id is the
-- real defect; fixing it means a server-assigned identity across all four, not
-- relaxing one of them.
CREATE TABLE IF NOT EXISTS sessions (
  id          text PRIMARY KEY,
  run_id      text NOT NULL,
  endpoint_id text NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  agent       text NOT NULL DEFAULT '',
  model       text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz
);

-- §2 pairing. The code is the whole credential the exchange presents, so it is
-- stored hashed like a token and spent once: `consumed_at` is decided under the
-- row's lock, so two redeems of one code cannot both win.
--
-- One row per member: minting supersedes, taking the spent row with it, so the
-- table is bounded by membership rather than by how often anyone re-pairs, and
-- the cascade retires it with the user.
--
-- No `attempts` column: §1's shape carried one to answer brute force, but a
-- wrong guess matches no row and so counts against nothing, and a right one is
-- spent on its first presentation and can never reach a cap. Guessing is
-- answered by the code's 80 bits and by per-IP throttling at the route.
CREATE TABLE IF NOT EXISTS pairings (
  code_hash   text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS sessions_run_idx ON sessions (run_id);
CREATE INDEX IF NOT EXISTS endpoints_user_idx ON endpoints (user_id);
CREATE INDEX IF NOT EXISTS pairings_user_idx ON pairings (user_id);
