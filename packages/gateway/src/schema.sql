-- M3a's owner-scoping tables, plus pairings (M3b) and conversations (M3d);
-- `key_changes` is what remains. openStore applies this file as-is, so every
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

-- The target of conversations_endpoint_is_owned. An index rather than a table
-- constraint because ALTER TABLE ADD CONSTRAINT has no IF NOT EXISTS, and this
-- file has to stay re-appliable.
CREATE UNIQUE INDEX IF NOT EXISTS endpoints_owner_key ON endpoints (user_id, id);

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
-- stored hashed like a token and spent once.
--
-- One row per member, and `user_id` is unique so that holds through two mints
-- racing: minting upserts, replacing the spent row rather than landing beside
-- it, so the table is bounded by membership and the cascade retires it.
--
-- No `attempts` column — §1 records why it cannot answer brute force.
CREATE TABLE IF NOT EXISTS pairings (
  code_hash   text PRIMARY KEY,
  user_id     text UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);

-- §4. One DM thread is one conversation, identified by the thread and never by
-- the ACP session underneath, which every resume replaces.
--
-- `user_id` is part of that identity rather than merely its owner: several
-- members can each tag one channel thread, and each must get a private
-- conversation instead of joining one.
CREATE TABLE IF NOT EXISTS conversations (
  id                text PRIMARY KEY,
  user_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dm_channel_id     text NOT NULL,
  root_thread_ts    text NOT NULL,
  -- Captured at invocation so a later share-back has a destination that cannot
  -- be redirected. Null when the conversation began in the DM, with no source.
  source_channel_id text,
  source_thread_ts  text,
  endpoint_id       text,
  agent             text NOT NULL DEFAULT '',
  model             text,
  -- The workspace id this conversation last ran in, so a thread keeps answering
  -- about the same project (§4). An opaque id the companion advertised, never a
  -- path — and only a preference: it is dropped if that endpoint stops offering
  -- it, rather than refusing the turn.
  workspace_id      text,
  -- How far up the source thread the agent has been shown. A repeat mention
  -- pulls the delta past this rather than the thread again, which is what keeps
  -- later messages from joining a running turn without being asked for (§4).
  seen_through_ts   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Retention forgets a conversation by when it was last used, not when it
  -- opened: a thread a member is still replying in is not stale at 30 days.
  last_activity_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_identity UNIQUE (user_id, dm_channel_id, root_thread_ts),
  -- Paired with `user_id` so the reference proves ownership and not merely that
  -- the row exists: a conversation cannot point at another member's machine.
  -- Nulled rather than cascaded — deactivation drops endpoints, and the record
  -- of what was asked outlives the machine it was asked of.
  CONSTRAINT conversations_endpoint_is_owned FOREIGN KEY (user_id, endpoint_id)
    REFERENCES endpoints (user_id, id) ON DELETE SET NULL (endpoint_id)
);

-- §5. `slack_event_id` is unique across the table rather than per conversation
-- because the id is Slack's and the Events API retries: a redelivery has to
-- collide with the turn it already made, wherever that turn was.
CREATE TABLE IF NOT EXISTS turns (
  id                text PRIMARY KEY,
  conversation_id   text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  slack_event_id    text NOT NULL CONSTRAINT turns_one_per_slack_event UNIQUE,
  delivery_mode     text NOT NULL DEFAULT 'private' CHECK (
                      delivery_mode IN ('private', 'post_when_ready', 'posted', 'cancelled')),
  status            text NOT NULL DEFAULT 'running' CHECK (
                      status IN ('running', 'awaiting_approval', 'completed', 'failed', 'cancelled')),
  result_ref        text,
  published_channel text,
  published_ts      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Publishing and having published are one fact, so "posted once" is
  -- answerable from the row rather than from whatever the bot remembers.
  CONSTRAINT turns_posted_has_destination CHECK (
    (delivery_mode = 'posted' AND published_channel IS NOT NULL AND published_ts IS NOT NULL)
    OR (delivery_mode <> 'posted' AND published_channel IS NULL AND published_ts IS NULL))
);

-- §4 resuming. A conversation outlives its sessions, and `resume_kind` makes
-- "recovered, not a true resume" a stored fact rather than a UI guess.
CREATE TABLE IF NOT EXISTS conversation_sessions (
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- Cascaded, so retention deleting a session leaves the conversation and its
  -- turns standing. Unique: a session belongs to the conversation that started it.
  session_id      text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
                    CONSTRAINT conversation_sessions_one_conversation UNIQUE,
  ordinal         int NOT NULL,
  resume_kind     text NOT NULL CHECK (resume_kind IN ('new', 'exact', 'recovered')),
  PRIMARY KEY (conversation_id, ordinal)
);

-- §4's second rung. Held apart from `conversations` because it is only valid
-- against the machine, agent and directory it was minted under, and those are
-- written on that table once at insert — they say where a conversation began,
-- not where its last turn ran. The endpoint cascade is the point: unpair a
-- laptop and every session id that only means anything on it goes with it.
--
-- Not `conversation_sessions`: that one's `session_id` references the relay's
-- sessions, and an agent's own id is not one of those.
-- `status` was never written before this, so every turn a database already
-- holds is `running` and any conversation with two of them would refuse the
-- index below — which is every database that has run at all. All but the newest
-- are retired first; a second run finds nothing to do.
UPDATE turns SET status = 'cancelled'
 WHERE status = 'running'
   AND id NOT IN (SELECT DISTINCT ON (conversation_id) id
                    FROM turns WHERE status = 'running'
                   ORDER BY conversation_id, created_at DESC, id DESC);

-- One running turn per conversation, enforced here because a check-and-insert
-- is not: under READ COMMITTED two concurrent events both see no running turn
-- and both insert. Partial, so the finished ones are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS turns_one_running_per_conversation
  ON turns (conversation_id) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS conversation_resume (
  conversation_id text PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  session_id      text NOT NULL,
  endpoint_id     text NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  agent           text NOT NULL,
  -- Null is the no-workspace mode, which is a match for another turn that also
  -- has none — the comparison is on sameness, not on presence.
  workspace_id    text
);
-- Postgres indexes the primary key and not the foreign one, so unpairing a
-- machine would scan every resume any member holds to find its rows.
CREATE INDEX IF NOT EXISTS conversation_resume_endpoint ON conversation_resume (endpoint_id);

-- #27 shipped `conversations`, so CREATE TABLE IF NOT EXISTS skips it on any
-- database that already ran that release and these columns would never arrive.
-- Declared above for a fresh database and added here for an upgraded one —
-- ADD COLUMN IF NOT EXISTS is idempotent, which is what keeps this file
-- re-appliable and the migration runner still unbuilt.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS seen_through_ts text;
-- Added nullable and backfilled, because `DEFAULT now()` would stamp every
-- existing row with the moment of the migration and hand each of them a fresh
-- 30 days — retention holding what it promised to forget. `created_at` is the
-- honest floor: it errs toward forgetting sooner. Each statement is a no-op on
-- second run, which is what keeps this file re-appliable.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;
UPDATE conversations SET last_activity_at = created_at WHERE last_activity_at IS NULL;
ALTER TABLE conversations ALTER COLUMN last_activity_at SET DEFAULT now();
ALTER TABLE conversations ALTER COLUMN last_activity_at SET NOT NULL;

-- Added with §4's workspace picker; null on every conversation that predates it,
-- which reads as "no preference yet" and takes the endpoint's first.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS workspace_id text;

CREATE INDEX IF NOT EXISTS sessions_run_idx ON sessions (run_id);
CREATE INDEX IF NOT EXISTS endpoints_user_idx ON endpoints (user_id);
CREATE INDEX IF NOT EXISTS turns_conversation_idx ON turns (conversation_id);
-- A mention continues the conversation its thread already has, so the source
-- thread must be findable and one per member — unique, or two mentions racing
-- would each open one. Partial, because a top-level DM has no source and any
-- number of those may exist.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_source_thread
  ON conversations (user_id, source_channel_id, source_thread_ts)
  WHERE source_channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversations_activity_idx ON conversations (last_activity_at);

-- The session mode this conversation runs under (§4): its member's own pick,
-- applied from the next turn. NULL is read-only, which every conversation
-- predating the column was.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS mode_id text;
