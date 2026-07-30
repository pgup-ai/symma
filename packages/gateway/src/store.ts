/**
 * Owner lookups for tenancy (§1). Every question here is "who does this belong
 * to" — the relay and the HTTP layer ask, they never decide.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

/** `(workspace_id, slack_user_id)` collapsed to the users row it names. */
export type Owner = string;

export interface SessionRef {
  runId: string;
  sessionId: string;
}

export interface LiveSession extends SessionRef {
  endpoint: string;
}

/** §2 gives expired and already-used the same words, so `spent` covers both;
 * `unknown` is the mistyped code, which a log is worth telling apart. */
export type PairingResult = { ok: true; owner: Owner } | { ok: false; why: 'unknown' | 'spent' };

/** One endpoint row: paired, whether or not anything ever attached to it. A null
 * `lastSeenAt` has never run — pairing writes the row, attaching writes the
 * time. */
export interface PairedEndpoint {
  id: string;
  device: string;
  lastSeenAt: number | null;
}

export interface Conversation {
  id: string;
  dmChannel: string;
  rootThread: string;
  /** How far up the source thread the agent has been shown; absent until a
   * snapshot has been taken for it. */
  seenThroughTs?: string;
  /** The workspace this thread last ran in (§4). A preference, not a claim: the
   * endpoint chosen now may no longer advertise it. */
  workspaceId?: string;
}

export interface Store {
  ownerForClientToken(token: string): Promise<Owner | undefined>;
  /** The owner behind a Slack identity, created on first sight — `/connect`
   * holds an authenticated `team_id`/`user_id`, which §6's pilot treats as
   * membership: one privately administered workspace, known internal members.
   *
   * Undefined for a deactivated member. Their row survives the soft delete, so
   * re-creating them here would be re-admitting someone who was removed, which
   * stays an administrative act rather than something their own command does. */
  ensureMember(slackTeamId: string, slackUserId: string): Promise<Owner | undefined>;
  /** The conversation a source thread already has (§4). A repeat mention
   * continues it rather than opening a second one. */
  conversationForSource(
    owner: Owner,
    sourceChannel: string,
    sourceThread: string,
  ): Promise<Conversation | undefined>;
  /** The conversation a DM thread root names (§4). A reply resumes what that
   * root already is, rather than whatever the member most recently touched. */
  conversationForDm(
    owner: Owner,
    dmChannel: string,
    rootThread: string,
  ): Promise<Conversation | undefined>;
  /** Opens one. Undefined when a concurrent mention opened it first, which the
   * caller answers by adopting that one — the DM root it already posted is the
   * only cost, and it is a message in the member's own DM. */
  openConversation(
    owner: Owner,
    spec: {
      dmChannel: string;
      rootThread: string;
      sourceChannel?: string;
      sourceThread?: string;
      endpoint?: string;
      agent?: string;
    },
  ): Promise<Conversation | undefined>;
  /** Records one invocation. Undefined when this Slack event already made a turn
   * — which is how a redelivery finds its own work rather than repeating it. */
  recordTurn(conversation: string, slackEventId: string): Promise<string | undefined>;
  /** Advances the cursor, once the member has actually been shown that far. Kept
   * apart from `recordTurn` because a turn that fails to deliver must not leave
   * the thread marked read: the next mention would filter out what nobody saw,
   * and a skipped message never comes back. */
  markConversationSeen(conversation: string, seenThroughTs: string): Promise<void>;
  /** §1 retention, by last use rather than by age: a thread a member is still
   * replying in is not stale. Turns and session links cascade; frames belong to
   * sessions, which `expireSessions` already answers for. */
  expireConversations(olderThanDays: number): Promise<number>;
  /** Drops tokens that are already past their expiry. They cannot authenticate,
   * so keeping them only grows the table — and a Slack turn mints one every
   * time a member asks something. */
  expireTokens(): Promise<number>;
  /** §2 pairing. Returns the plaintext once — the row keeps only its hash — and
   * supersedes this owner's outstanding code. Undefined if they are no longer an
   * active member, which the caller must answer rather than hand back a code
   * that can only fail later; the type is what makes that unmissable. A store
   * failure still throws. */
  mintPairingCode(owner: Owner): Promise<string | undefined>;
  /** Spends a code. Two redeems of one code cannot both come back `ok`. */
  redeemPairingCode(code: string): Promise<PairingResult>;
  /** The other half of pairing: an endpoint for this member and the token it
   * presents, both returned once. The id is assigned, not taken from an
   * unauthenticated request body, where it would be a valid code away from
   * someone else's endpoint (§2).
   *
   * Undefined if the member is gone by the time this runs — a race to answer,
   * not a caller's mistake to throw at, which is `mintPairingCode` above too.
   * A store failure still throws. */
  claimEndpoint(
    owner: Owner,
    device: string,
  ): Promise<{ endpoint: string; token: string } | undefined>;
  /** The endpoint a companion token speaks for, and who owns it. */
  endpointForToken(token: string): Promise<{ endpoint: string; owner: Owner } | undefined>;
  /** The authorization question itself, not the owner to compare outside: with
   * the key scoped per endpoint, "who owns this id" no longer has one answer. */
  sessionBelongsTo(owner: Owner, runId: string, sessionId: string): Promise<boolean>;
  runsFor(owner: Owner): Promise<Set<string>>;
  /** Sessions this owner may see, by run. A runId is caller-chosen, so two
   * tenants can land in one run directory and the listing must not leak
   * across — batched, since a query per run grows with run history. */
  sessionsByRun(owner: Owner, runIds: string[]): Promise<Map<string, Set<string>>>;
  recordSession(session: {
    id: string;
    runId: string;
    endpoint: string;
    agent: string;
    model?: string;
  }): Promise<void>;
  markSeen(endpoint: string): Promise<void>;
  /** One conversation by id, scoped to its owner. Undefined is both "no such
   * conversation" and "not yours" on purpose: the bot names an id it was given,
   * and an id alone is not authorization. */
  conversationForId(owner: Owner, conversation: string): Promise<Conversation | undefined>;
  /** Records what this conversation ran on, so the next turn in the thread lands
   * on the same project (§4) rather than wherever the endpoint lists first. */
  bindConversation(owner: Owner, conversation: string, workspaceId: string): Promise<void>;
  /** A client token for this member, good for `ttlMinutes`. The bot holds no
   * credential of its own (§6), so this is how it acts as whoever is asking —
   * for one turn, rather than by being handed a standing key to them. */
  mintClientToken(owner: Owner, ttlMinutes: number): Promise<string>;
  /** Every endpoint this owner has paired, attached or not. The relay knows only
   * the ones that attached since it started, so without this a gateway restart
   * would tell a paired member they had never paired. */
  endpointsFor(owner: Owner): Promise<PairedEndpoint[]>;
  /** For an open the companion went on to refuse: the row outlives the relay's
   * in-memory session otherwise, and blocks the id from ever being reused.
   * Returns what it removed, like every other delete here — frames can already
   * have been journaled between the open and the refusal. */
  deleteSessionRow(id: string, runId: string, endpoint: string): Promise<SessionRef[]>;
  /** §1 data lifecycle. Each returns the sessions whose frames the caller must
   * now delete from disk — the row and the file are one unit, and only the
   * caller knows where the files live. */
  /** `live` is excluded: its frames are still arriving, and a session that lost
   * its row keeps writing a journal nothing can read or expire. Whole keys —
   * an id alone names a different session under another endpoint. */
  expireSessions(olderThanDays: number, live?: LiveSession[]): Promise<SessionRef[]>;
  deleteSession(owner: Owner, runId: string, sessionId: string): Promise<SessionRef[]>;
  deleteWorkspace(slackTeamId: string): Promise<SessionRef[]>;
  deactivateUser(slackTeamId: string, slackUserId: string): Promise<SessionRef[]>;
  close(): Promise<void>;
}

/** Spread, so an absent cursor is a missing key rather than an explicit
 * undefined — the shape the rest of this file uses for optional columns. */
const seen = (ts: string | null): { seenThroughTs?: string } => (ts ? { seenThroughTs: ts } : {});

/** The conversation lookups differ only in the key they ask by, so they read
 * the same row back and build it the same way. */
interface Row {
  id: string;
  dm: string;
  root: string;
  seen: string | null;
  workspace: string | null;
}
const conversationFrom = (row: Row): Conversation => ({
  id: row.id,
  dmChannel: row.dm,
  rootThread: row.root,
  ...seen(row.seen),
  ...(row.workspace ? { workspaceId: row.workspace } : {}),
});

/** Tokens are compared by hash, so the plaintext never lands in a row or a log. */
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Constant-time secret comparison, for the secrets that have no row to be
 * looked up as a hash. Digested first so both sides are 32 bytes, which is what
 * `timingSafeEqual` requires and what keeps the comparison from leaking the
 * length as well. */
export const sameSecret = (offered: string, expected: string): boolean =>
  timingSafeEqual(
    createHash('sha256').update(offered).digest(),
    createHash('sha256').update(expected).digest(),
  );

// Crockford base32: no I, L, O or U, so nothing retyped off a screen reads as
// another character. 256 is a whole multiple of its 32 symbols, so a random
// byte taken modulo the alphabet is unbiased.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 16 × 5 bits = 80, past §2's ≥64-bit floor. */
const CODE_LENGTH = 16;
/** Exported so `/connect` can tell the member how long their code lasts without
 * a second copy of the number drifting from this one. */
export const PAIRING_TTL_MINUTES = 10;

function newPairingCode(): string {
  const pick = (b: number): string => CODE_ALPHABET[b % CODE_ALPHABET.length];
  const code = Array.from(randomBytes(CODE_LENGTH), pick).join('');
  return code.replace(/(.{4})(?=.)/g, '$1-'); // grouped to read aloud
}

/** Crockford's decode: a retyped code arrives with I or l for 1 and O for 0,
 * and our grouping hyphens wherever the member left them. */
const normalizeCode = (code: string): string =>
  code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');

export async function openStore(url: string, schemaPath: string): Promise<Store> {
  const pool = new Pool({ connectionString: url });
  await pool.query(readFileSync(schemaPath, 'utf8'));

  const one = async <T>(sql: string, params: unknown[]): Promise<T | undefined> =>
    (await pool.query(sql, params)).rows[0] as T | undefined;
  const refs = (result: { rows: { id: string; run_id: string }[] }): SessionRef[] =>
    result.rows.map((r) => ({ runId: r.run_id, sessionId: r.id }));

  return {
    async ownerForClientToken(token) {
      const row = await one<{ subject_id: string }>(
        // Joined through to the member for the reason `endpointForToken` gives:
        // deactivation stops the token by construction, rather than by every
        // path that sets `deactivated_at` remembering to revoke it. It matters
        // more now that a Slack turn mints one of these per member.
        `SELECT t.subject_id FROM tokens t
           JOIN users u ON u.id = t.subject_id
          WHERE t.hash = $1 AND t.subject_kind = 'client' AND t.revoked_at IS NULL
            AND u.deactivated_at IS NULL
            AND (t.expires_at IS NULL OR t.expires_at > now())`,
        [hashToken(token)],
      );
      return row?.subject_id;
    },
    async ensureMember(slackTeamId, slackUserId) {
      // One transaction, for the reason deleteWorkspace gives for its own: the
      // workspace and the member arrive together or not at all. Apart, an
      // uninstall committing between them takes the workspace out from under
      // the second insert and it fails on a foreign key. The upsert holds a row
      // lock on the workspace for the transaction, so the uninstall waits.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Returns the existing id on conflict rather than assuming one: a
        // workspace row created by another path would otherwise fail the users
        // insert below on a foreign key naming a row we never looked up.
        const workspace = await client.query<{ id: string }>(
          `INSERT INTO workspaces (id, slack_team_id) VALUES ($1, $2)
           ON CONFLICT (slack_team_id) DO UPDATE SET slack_team_id = EXCLUDED.slack_team_id
           RETURNING id`,
          [`ws-${slackTeamId}`, slackTeamId],
        );
        // Assigned, never derived from the two caller values — the defect
        // `provision` documents, where a hyphen the caller controls let
        // ("a", "b-c") and ("a-b", "c") spell one owner.
        const member = await client.query<{ id: string; deactivated_at: string | null }>(
          `INSERT INTO users (id, workspace_id, slack_user_id) VALUES ($1, $2, $3)
           ON CONFLICT (workspace_id, slack_user_id)
             DO UPDATE SET slack_user_id = EXCLUDED.slack_user_id
           RETURNING id, deactivated_at`,
          [randomUUID(), workspace.rows[0]!.id, slackUserId],
        );
        await client.query('COMMIT');
        // Read, never cleared — see the contract above.
        const row = member.rows[0]!;
        return row.deactivated_at ? undefined : row.id;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async conversationForSource(owner, sourceChannel, sourceThread) {
      const row = await one<Row>(
        `SELECT id, dm_channel_id AS dm, root_thread_ts AS root, seen_through_ts AS seen,
                workspace_id AS workspace
           FROM conversations
          WHERE user_id = $1 AND source_channel_id = $2 AND source_thread_ts = $3`,
        [owner, sourceChannel, sourceThread],
      );
      return row && conversationFrom(row);
    },
    async conversationForDm(owner, dmChannel, rootThread) {
      const row = await one<Row>(
        `SELECT id, dm_channel_id AS dm, root_thread_ts AS root, seen_through_ts AS seen,
                workspace_id AS workspace
           FROM conversations
          WHERE user_id = $1 AND dm_channel_id = $2 AND root_thread_ts = $3`,
        [owner, dmChannel, rootThread],
      );
      return row && conversationFrom(row);
    },
    async openConversation(owner, spec) {
      const id = randomUUID();
      // DO NOTHING rather than an upsert: the loser of a race must not overwrite
      // the winner's DM root with its own, which would strand the thread the
      // member is already looking at. Untargeted, because which constraint
      // catches the race depends on where the conversation came from — a mention
      // collides on the source thread, a DM on its own root.
      const landed = await one<{ id: string }>(
        `INSERT INTO conversations (id, user_id, dm_channel_id, root_thread_ts,
                                    source_channel_id, source_thread_ts, endpoint_id, agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8, ''))
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          id,
          owner,
          spec.dmChannel,
          spec.rootThread,
          spec.sourceChannel ?? null,
          spec.sourceThread ?? null,
          spec.endpoint ?? null,
          spec.agent ?? null,
        ],
      );
      return landed && { id, dmChannel: spec.dmChannel, rootThread: spec.rootThread };
    },
    async recordTurn(conversation, slackEventId) {
      const turn = await one<{ id: string }>(
        `INSERT INTO turns (id, conversation_id, slack_event_id) VALUES ($1, $2, $3)
         ON CONFLICT (slack_event_id) DO NOTHING RETURNING id`,
        [randomUUID(), conversation, slackEventId],
      );
      // Activity is the invocation, not the delivery: a member who mentioned the
      // bot today is using this thread whether or not the answer landed.
      if (turn) {
        await pool.query(`UPDATE conversations SET last_activity_at = now() WHERE id = $1`, [
          conversation,
        ]);
      }
      return turn?.id;
    },
    async markConversationSeen(conversation, seenThroughTs) {
      // Never backwards: a redelivery or a slow turn must not rewind the thread
      // and re-send what the member already read.
      await pool.query(
        `UPDATE conversations SET seen_through_ts = greatest(seen_through_ts, $2)
          WHERE id = $1`,
        [conversation, seenThroughTs],
      );
    },
    async expireConversations(olderThanDays) {
      const { rowCount } = await pool.query(
        `DELETE FROM conversations WHERE last_activity_at < now() - make_interval(days => $1)`,
        [olderThanDays],
      );
      return rowCount ?? 0;
    },
    async mintPairingCode(owner) {
      const code = newPairingCode();
      // Supersede rather than queue: several live codes for one member is
      // several chances for the wrong one to land. Upsert on the unique
      // `user_id` rather than delete-then-insert, so two mints racing leave one
      // row rather than each finding nothing to delete and inserting its own.
      //
      // `FOR UPDATE` on the member is what orders this against deactivation,
      // which takes the same row lock: either it waits and then deletes this
      // code with the rest, or it went first and there is no live member here
      // to select. Unlocked, a mint could land a fresh code behind a cleanup
      // that had already run.
      const { rowCount } = await pool.query(
        `INSERT INTO pairings (code_hash, user_id, expires_at)
         SELECT $1, u.id, now() + make_interval(mins => $3)
           FROM users u WHERE u.id = $2 AND u.deactivated_at IS NULL FOR UPDATE
         ON CONFLICT (user_id) DO UPDATE
            SET code_hash = EXCLUDED.code_hash,
                expires_at = EXCLUDED.expires_at,
                consumed_at = NULL`,
        [hashToken(normalizeCode(code)), owner, PAIRING_TTL_MINUTES],
      );
      // No row means they are not an active member — deactivated, or gone with
      // their workspace between the caller's lookup and this lock.
      return rowCount ? code : undefined;
    },
    async redeemPairingCode(code) {
      const hash = hashToken(normalizeCode(code));
      // The claim is the UPDATE: its WHERE is re-checked against the committed
      // row once it holds the lock, so of two racing redeems exactly one wins.
      //
      // Joined to `users` because deactivation is a soft delete — the row stays,
      // so the cascade never reaches the code, and a removed member's
      // outstanding code would still name them.
      const won = await one<{ user_id: string }>(
        `UPDATE pairings p SET consumed_at = now()
           FROM users u
          WHERE u.id = p.user_id AND u.deactivated_at IS NULL
            AND p.code_hash = $1 AND p.consumed_at IS NULL AND p.expires_at > now()
          RETURNING p.user_id`,
        [hash],
      );
      if (won) return { ok: true, owner: won.user_id };
      // Only to say which, and only on the path that already failed.
      const seen = await one<{ ok: number }>(`SELECT 1 AS ok FROM pairings WHERE code_hash = $1`, [
        hash,
      ]);
      return { ok: false, why: seen ? 'spent' : 'unknown' };
    },
    async claimEndpoint(owner, device) {
      const endpoint = randomUUID();
      const token = randomUUID();
      // Same member lock as mintPairingCode, for the same reason: deactivation
      // deletes endpoints, and unlocked this could land one behind that.
      const { rowCount } = await pool.query(
        `WITH member AS (
           SELECT id FROM users WHERE id = $2 AND deactivated_at IS NULL FOR UPDATE
         ), claimed AS (
           INSERT INTO endpoints (id, user_id, device_name)
           SELECT $1, id, $3 FROM member
           RETURNING id
         )
         INSERT INTO tokens (id, subject_kind, subject_id, hash)
         SELECT $4, 'endpoint', id, $5 FROM claimed`,
        [endpoint, owner, device, randomUUID(), hashToken(token)],
      );
      return rowCount ? { endpoint, token } : undefined;
    },
    async endpointForToken(token) {
      const row = await one<{ subject_id: string; user_id: string }>(
        // Joined through to the member, so deactivation means no endpoint auth
        // by construction rather than by every path that sets deactivated_at
        // remembering to delete the endpoint too. Same shape as the revoked_at
        // check beside it.
        `SELECT t.subject_id, e.user_id FROM tokens t
           JOIN endpoints e ON e.id = t.subject_id
           JOIN users u ON u.id = e.user_id
          WHERE t.hash = $1 AND t.subject_kind = 'endpoint' AND t.revoked_at IS NULL
            AND u.deactivated_at IS NULL
            AND (t.expires_at IS NULL OR t.expires_at > now())`,
        [hashToken(token)],
      );
      return row && { endpoint: row.subject_id, owner: row.user_id };
    },
    async sessionBelongsTo(owner, runId, sessionId) {
      return (
        (await one<{ ok: number }>(
          `SELECT 1 AS ok FROM sessions s JOIN endpoints e ON e.id = s.endpoint_id
            WHERE s.id = $1 AND s.run_id = $2 AND e.user_id = $3`,
          [sessionId, runId, owner],
        )) !== undefined
      );
    },
    async runsFor(owner) {
      const { rows } = await pool.query(
        `SELECT DISTINCT s.run_id FROM sessions s JOIN endpoints e ON e.id = s.endpoint_id
          WHERE e.user_id = $1`,
        [owner],
      );
      return new Set(rows.map((r: { run_id: string }) => r.run_id));
    },
    async sessionsByRun(owner, runIds) {
      const { rows } = await pool.query(
        `SELECT s.run_id, s.id FROM sessions s JOIN endpoints e ON e.id = s.endpoint_id
          WHERE s.run_id = ANY($1) AND e.user_id = $2`,
        [runIds, owner],
      );
      const byRun = new Map<string, Set<string>>();
      for (const r of rows as { run_id: string; id: string }[]) {
        let owned = byRun.get(r.run_id);
        if (!owned) byRun.set(r.run_id, (owned = new Set()));
        owned.add(r.id);
      }
      return byRun;
    },
    async deleteSessionRow(id, runId, endpoint) {
      // The whole key: the same id names a different session under another
      // endpoint or run, and a partial match would strip that one instead.
      return refs(
        await pool.query(
          `DELETE FROM sessions WHERE id = $1 AND run_id = $2 AND endpoint_id = $3
           RETURNING id, run_id`,
          [id, runId, endpoint],
        ),
      );
    },
    async recordSession({ id, runId, endpoint, agent, model }) {
      // No ON CONFLICT: a reused id must not silently keep the old row, or the
      // new session's frames are authorized against whoever owned it last.
      await pool.query(
        `INSERT INTO sessions (id, run_id, endpoint_id, agent, model) VALUES ($1, $2, $3, $4, $5)`,
        [id, runId, endpoint, agent, model ?? null],
      );
    },
    async endpointsFor(owner) {
      const { rows } = await pool.query<{ id: string; device: string; seen: Date | null }>(
        `SELECT id, device_name AS device, last_seen_at AS seen FROM endpoints WHERE user_id = $1`,
        [owner],
      );
      return rows.map(({ id, device, seen }) => ({
        id,
        device,
        lastSeenAt: seen?.getTime() ?? null,
      }));
    },
    async expireTokens() {
      const { rowCount } = await pool.query(
        `DELETE FROM tokens WHERE expires_at IS NOT NULL AND expires_at < now()`,
      );
      return rowCount ?? 0;
    },
    async conversationForId(owner, conversation) {
      const row = await one<Row>(
        `SELECT id, dm_channel_id AS dm, root_thread_ts AS root, seen_through_ts AS seen,
                workspace_id AS workspace
           FROM conversations
          WHERE user_id = $1 AND id = $2`,
        [owner, conversation],
      );
      return row && conversationFrom(row);
    },
    async bindConversation(owner, conversation, workspaceId) {
      await pool.query(
        `UPDATE conversations SET workspace_id = $3 WHERE id = $2 AND user_id = $1`,
        [owner, conversation, workspaceId],
      );
    },
    async mintClientToken(owner, ttlMinutes) {
      const token = randomUUID();
      await pool.query(
        `INSERT INTO tokens (id, subject_kind, subject_id, hash, expires_at)
         VALUES ($1, 'client', $2, $3, now() + make_interval(mins => $4))`,
        [randomUUID(), owner, hashToken(token), ttlMinutes],
      );
      return token;
    },
    async markSeen(endpoint) {
      await pool.query(`UPDATE endpoints SET last_seen_at = now() WHERE id = $1`, [endpoint]);
    },
    async expireSessions(olderThanDays, live = []) {
      return refs(
        await pool.query(
          `DELETE FROM sessions s
            WHERE s.started_at < now() - make_interval(days => $1)
              AND NOT EXISTS (
                SELECT 1 FROM unnest($2::text[], $3::text[], $4::text[])
                       AS l(endpoint_id, run_id, id)
                 WHERE l.endpoint_id = s.endpoint_id AND l.run_id = s.run_id AND l.id = s.id
              )
           RETURNING s.id, s.run_id`,
          [
            olderThanDays,
            live.map((l) => l.endpoint),
            live.map((l) => l.runId),
            live.map((l) => l.sessionId),
          ],
        ),
      );
    },
    async deleteSession(owner, runId, sessionId) {
      // Scoped in the WHERE clause, not by a check before it: a delete that
      // authorizes separately is a delete that can race its own authorization.
      return refs(
        await pool.query(
          `DELETE FROM sessions s USING endpoints e
            WHERE s.endpoint_id = e.id AND s.id = $1 AND s.run_id = $2 AND e.user_id = $3
           RETURNING s.id, s.run_id`,
          [sessionId, runId, owner],
        ),
      );
    },
    async deleteWorkspace(slackTeamId) {
      // One transaction: a partial uninstall either strands tokens for a
      // workspace that is gone or deletes credentials for one that is not.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Lock first: an insert into sessions takes a key-share lock on its
        // endpoint, so holding these blocks an open in flight from landing a
        // row after the delete below has taken its snapshot.
        await client.query(
          `SELECT e.id FROM endpoints e JOIN users u ON u.id = e.user_id
            WHERE u.workspace_id = (SELECT id FROM workspaces WHERE slack_team_id = $1)
            FOR UPDATE`,
          [slackTeamId],
        );
        // Deleted here rather than left to the cascade, so the rows reported
        // and the rows removed are one statement: a session committed between
        // a separate SELECT and the cascade would vanish unreported, stranding
        // its journal outside authorization and retention both.
        const doomed = refs(
          await client.query(
            `DELETE FROM sessions s USING endpoints e, users u
              WHERE s.endpoint_id = e.id AND e.user_id = u.id
                AND u.workspace_id = (SELECT id FROM workspaces WHERE slack_team_id = $1)
             RETURNING s.id, s.run_id`,
            [slackTeamId],
          ),
        );
        // `tokens.subject_id` points at a user or an endpoint, so it carries no
        // foreign key and the cascade cannot reach it. Left alone, an uninstall
        // leaves live credentials for a tenant that no longer exists.
        //
        // Qualified by kind: ids are not namespaced across the two tables, so
        // an endpoint named after some other workspace's user id would have
        // matched the user predicate and lost its token.
        await client.query(
          `WITH doomed_users AS (
             SELECT u.id FROM users u JOIN workspaces w ON w.id = u.workspace_id
              WHERE w.slack_team_id = $1
           )
           DELETE FROM tokens
            WHERE (subject_kind = 'client' AND subject_id IN (SELECT id FROM doomed_users))
               OR (subject_kind = 'endpoint' AND subject_id IN (
                     SELECT id FROM endpoints WHERE user_id IN (SELECT id FROM doomed_users)))`,
          [slackTeamId],
        );
        await client.query(`DELETE FROM workspaces WHERE slack_team_id = $1`, [slackTeamId]);
        await client.query('COMMIT');
        return doomed;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async deactivateUser(slackTeamId, slackUserId) {
      // Same reason as deleteWorkspace: taking the sessions in one statement
      // that both removes and reports them, rather than letting the endpoint
      // cascade take rows the caller never learned about.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // The member first, and in a statement of its own. It is the row
        // claimEndpoint and mintPairingCode lock, so taking it here is what
        // orders them against this — and taking it *separately* is what makes
        // the statements below re-read: each gets its own snapshot at read
        // committed, so a claim that committed while this waited is visible to
        // them. Locked inside the cleanup instead, that claim would commit
        // behind its snapshot and keep an endpoint and a live token.
        await client.query(
          `SELECT u.id FROM users u JOIN workspaces w ON w.id = u.workspace_id
            WHERE w.slack_team_id = $1 AND u.slack_user_id = $2
            FOR UPDATE`,
          [slackTeamId, slackUserId],
        );
        // Then the endpoints, same reason as deleteWorkspace: an insert into
        // sessions takes a key-share lock on its endpoint.
        await client.query(
          `SELECT e.id FROM endpoints e
             JOIN users u ON u.id = e.user_id
             JOIN workspaces w ON w.id = u.workspace_id
            WHERE w.slack_team_id = $1 AND u.slack_user_id = $2
            FOR UPDATE`,
          [slackTeamId, slackUserId],
        );
        const doomed = refs(
          await client.query(
            `DELETE FROM sessions s USING endpoints e, users u, workspaces w
              WHERE s.endpoint_id = e.id AND e.user_id = u.id AND w.id = u.workspace_id
                AND w.slack_team_id = $1 AND u.slack_user_id = $2
             RETURNING s.id, s.run_id`,
            [slackTeamId, slackUserId],
          ),
        );
        await client.query(
          `WITH target AS (
           UPDATE users u SET deactivated_at = now()
             FROM workspaces w
            WHERE w.id = u.workspace_id AND w.slack_team_id = $1 AND u.slack_user_id = $2
           RETURNING u.id
         ), unpaired AS (
           -- Their code goes with the tokens. The target CTE holds the member
           -- row, which is also the lock mintPairingCode waits on to stay
           -- ordered against this.
           DELETE FROM pairings WHERE user_id IN (SELECT id FROM target)
         ), revoked AS (
           UPDATE tokens SET revoked_at = now()
            WHERE revoked_at IS NULL
              AND ((subject_kind = 'client' AND subject_id IN (SELECT id FROM target))
                OR (subject_kind = 'endpoint' AND subject_id IN (
                      SELECT id FROM endpoints WHERE user_id IN (SELECT id FROM target))))
         )
         DELETE FROM endpoints WHERE user_id IN (SELECT id FROM target)`,
          [slackTeamId, slackUserId],
        );
        await client.query('COMMIT');
        return doomed;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Seeds a workspace, a member and their endpoint, returning the tokens each
 * side presents. Pairing (§2) replaces this; until then it is how an operator
 * provisions and how the tests build two tenants. */
export async function provision(
  url: string,
  spec: { team: string; slackUser: string; endpoint: string; device?: string },
): Promise<{ owner: Owner; clientToken: string; endpointToken: string }> {
  const pool = new Pool({ connectionString: url });
  try {
    const workspace = `ws-${spec.team}`;
    const clientToken = randomUUID();
    const endpointToken = randomUUID();
    await pool.query(
      `INSERT INTO workspaces (id, slack_team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [workspace, spec.team],
    );
    // Assigned, never derived. `u-${team}-${user}` made the hyphen a boundary
    // the caller controls: ("a", "b-c") and ("a-b", "c") both spell u-a-b-c, so
    // the second insert no-opped onto the first tenant's owner and handed it
    // their endpoint and tokens.
    const { rows } = await pool.query(
      `INSERT INTO users (id, workspace_id, slack_user_id) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, slack_user_id)
         DO UPDATE SET slack_user_id = EXCLUDED.slack_user_id
       RETURNING id`,
      [randomUUID(), workspace, spec.slackUser],
    );
    const owner = (rows[0] as { id: string }).id;
    // Never reassign: the id is already on historical sessions, so moving it
    // would hand their journals to the new owner and leave the old owner's
    // endpoint token authenticating as them.
    const claimed = await pool.query(
      `INSERT INTO endpoints (id, user_id, device_name) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [spec.endpoint, owner, spec.device ?? spec.endpoint],
    );
    if (claimed.rowCount === 0) {
      const { rows } = await pool.query(`SELECT user_id FROM endpoints WHERE id = $1`, [
        spec.endpoint,
      ]);
      if (rows[0]?.user_id !== owner) {
        throw new Error(`endpoint ${spec.endpoint} already belongs to ${rows[0]?.user_id}`);
      }
    }
    await pool.query(
      `INSERT INTO tokens (id, subject_kind, subject_id, hash) VALUES
         ($1, 'client', $2, $3), ($4, 'endpoint', $5, $6)`,
      [
        randomUUID(),
        owner,
        hashToken(clientToken),
        randomUUID(),
        spec.endpoint,
        hashToken(endpointToken),
      ],
    );
    return { owner, clientToken, endpointToken };
  } finally {
    await pool.end();
  }
}

/**
 * The same contract backed by the journal directory, for a gateway with no
 * database. Single tenant means every question about ownership has one answer,
 * so this is not a stub — it is the degenerate case of the same model.
 *
 * It exists so the server never asks "is there a store?". That question was a
 * fork at nine call sites, and a behaviour written on one side of it kept
 * shipping without the other.
 */
export function localStore(
  clientToken: string,
  endpointTokens: Map<string, string>,
  /** Every journal on disk, with its mtime — the filesystem is the index. */
  journals: () => { runId: string; sessionId: string; mtimeMs: number }[],
  /** Every run on disk. Not derivable from `journals`: a run that failed before
   * its first ACP session has a status and no journals, and still has to be
   * discoverable — deriving ownership from the journals alone hid exactly the
   * failures a viewer is opened to look at. */
  runsOnDisk: () => string[],
): Store {
  const LOCAL = 'local';
  const needsDatabase = (): never => {
    throw new Error('this gateway is single-tenant; pairing and workspaces need a database');
  };
  return {
    ownerForClientToken: (token) =>
      // No configured token is M2's local mode: loopback only, no auth.
      Promise.resolve(!clientToken || sameSecret(token, clientToken) ? LOCAL : undefined),
    endpointForToken: (token) => {
      for (const [endpoint, expected] of endpointTokens) {
        if (sameSecret(token, expected)) return Promise.resolve({ endpoint, owner: LOCAL });
      }
      return Promise.resolve(undefined);
    },
    sessionBelongsTo: (owner, runId, sessionId) =>
      Promise.resolve(
        owner === LOCAL && journals().some((j) => j.runId === runId && j.sessionId === sessionId),
      ),
    runsFor: () => Promise.resolve(new Set(runsOnDisk())),
    sessionsByRun: (_owner, runIds) => {
      const byRun = new Map<string, Set<string>>();
      for (const j of journals()) {
        if (!runIds.includes(j.runId)) continue;
        let owned = byRun.get(j.runId);
        if (!owned) byRun.set(j.runId, (owned = new Set()));
        owned.add(j.sessionId);
      }
      return Promise.resolve(byRun);
    },
    // Ownership is universal here, so there is nothing to record or release.
    recordSession: () => Promise.resolve(),
    // Nothing is recorded here, so nothing is released — the journal is
    // reached and expired through the filesystem either way.
    deleteSessionRow: () => Promise.resolve([]),
    markSeen: () => Promise.resolve(),
    endpointsFor: needsDatabase,
    mintClientToken: needsDatabase,
    bindConversation: needsDatabase,
    conversationForId: needsDatabase,
    expireTokens: needsDatabase,
    expireSessions: (olderThanDays, live = []) => {
      const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
      // One tenant, so a run and session id are the whole key here.
      const isLive = (runId: string, sessionId: string): boolean =>
        live.some((l) => l.runId === runId && l.sessionId === sessionId);
      return Promise.resolve(
        journals()
          .filter((j) => j.mtimeMs < cutoff && !isLive(j.runId, j.sessionId))
          .map(({ runId, sessionId }) => ({ runId, sessionId })),
      );
    },
    deleteSession: (_owner, runId, sessionId) =>
      Promise.resolve(
        journals().some((j) => j.runId === runId && j.sessionId === sessionId)
          ? [{ runId, sessionId }]
          : [],
      ),
    deleteWorkspace: needsDatabase,
    deactivateUser: needsDatabase,
    claimEndpoint: needsDatabase,
    // One member, holding a token they configured: nobody to introduce.
    ensureMember: needsDatabase,
    conversationForSource: needsDatabase,
    conversationForDm: needsDatabase,
    openConversation: needsDatabase,
    recordTurn: needsDatabase,
    markConversationSeen: needsDatabase,
    expireConversations: needsDatabase,
    mintPairingCode: needsDatabase,
    redeemPairingCode: needsDatabase,
    close: () => Promise.resolve(),
  };
}
