/**
 * Owner lookups for tenancy (§1). Every question here is "who does this belong
 * to" — the relay and the HTTP layer ask, they never decide.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
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

export interface Store {
  ownerForClientToken(token: string): Promise<Owner | undefined>;
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

/** Tokens are compared by hash, so the plaintext never lands in a row or a log. */
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

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
        `SELECT subject_id FROM tokens
          WHERE hash = $1 AND subject_kind = 'client' AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > now())`,
        [hashToken(token)],
      );
      return row?.subject_id;
    },
    async endpointForToken(token) {
      const row = await one<{ subject_id: string; user_id: string }>(
        `SELECT t.subject_id, e.user_id FROM tokens t
           JOIN endpoints e ON e.id = t.subject_id
          WHERE t.hash = $1 AND t.subject_kind = 'endpoint' AND t.revoked_at IS NULL
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
        // Same lock, same reason as deleteWorkspace.
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
): Store {
  const LOCAL = 'local';
  const matches = (presented: string, expected: string): boolean => {
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const noWorkspaces = (): never => {
    throw new Error('workspaces need a database; this gateway is single-tenant');
  };
  return {
    ownerForClientToken: (token) =>
      // No configured token is M2's local mode: loopback only, no auth.
      Promise.resolve(!clientToken || matches(token, clientToken) ? LOCAL : undefined),
    endpointForToken: (token) => {
      for (const [endpoint, expected] of endpointTokens) {
        if (matches(token, expected)) return Promise.resolve({ endpoint, owner: LOCAL });
      }
      return Promise.resolve(undefined);
    },
    sessionBelongsTo: (owner, runId, sessionId) =>
      Promise.resolve(
        owner === LOCAL && journals().some((j) => j.runId === runId && j.sessionId === sessionId),
      ),
    runsFor: () => Promise.resolve(new Set(journals().map((j) => j.runId))),
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
    deleteWorkspace: noWorkspaces,
    deactivateUser: noWorkspaces,
    close: () => Promise.resolve(),
  };
}
