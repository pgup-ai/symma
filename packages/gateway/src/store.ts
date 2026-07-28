/**
 * Owner lookups for tenancy (§1). Every question here is "who does this belong
 * to" — the relay and the HTTP layer ask, they never decide.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

/** `(workspace_id, slack_user_id)` collapsed to the users row it names. */
export type Owner = string;

export interface SessionRef {
  runId: string;
  sessionId: string;
}

export interface Store {
  ownerForClientToken(token: string): Promise<Owner | undefined>;
  /** The endpoint a companion token speaks for, and who owns it. */
  endpointForToken(token: string): Promise<{ endpoint: string; owner: Owner } | undefined>;
  ownerForSession(runId: string, sessionId: string): Promise<Owner | undefined>;
  runsFor(owner: Owner): Promise<Set<string>>;
  recordSession(session: {
    id: string;
    runId: string;
    endpoint: string;
    agent: string;
    model?: string;
  }): Promise<void>;
  markSeen(endpoint: string): Promise<void>;
  /** §1 data lifecycle. Each returns the sessions whose frames the caller must
   * now delete from disk — the row and the file are one unit, and only the
   * caller knows where the files live. */
  expireSessions(olderThanDays: number): Promise<SessionRef[]>;
  deleteSession(owner: Owner, runId: string, sessionId: string): Promise<SessionRef[]>;
  deleteWorkspace(slackTeamId: string): Promise<SessionRef[]>;
  deactivateUser(slackTeamId: string, slackUserId: string): Promise<void>;
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
    async ownerForSession(runId, sessionId) {
      return (
        await one<{ user_id: string }>(
          `SELECT e.user_id FROM sessions s JOIN endpoints e ON e.id = s.endpoint_id
            WHERE s.id = $1 AND s.run_id = $2`,
          [sessionId, runId],
        )
      )?.user_id;
    },
    async runsFor(owner) {
      const { rows } = await pool.query(
        `SELECT DISTINCT s.run_id FROM sessions s JOIN endpoints e ON e.id = s.endpoint_id
          WHERE e.user_id = $1`,
        [owner],
      );
      return new Set(rows.map((r: { run_id: string }) => r.run_id));
    },
    async recordSession({ id, runId, endpoint, agent, model }) {
      await pool.query(
        `INSERT INTO sessions (id, run_id, endpoint_id, agent, model)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
        [id, runId, endpoint, agent, model ?? null],
      );
    },
    async markSeen(endpoint) {
      await pool.query(`UPDATE endpoints SET last_seen_at = now() WHERE id = $1`, [endpoint]);
    },
    async expireSessions(olderThanDays) {
      return refs(
        await pool.query(
          `DELETE FROM sessions WHERE started_at < now() - make_interval(days => $1)
           RETURNING id, run_id`,
          [olderThanDays],
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
      // Sessions come back before the cascade removes them, so the caller still
      // learns which files to delete.
      const doomed = refs(
        await pool.query(
          `SELECT s.id, s.run_id FROM sessions s
             JOIN endpoints e ON e.id = s.endpoint_id
             JOIN users u ON u.id = e.user_id
            WHERE u.workspace_id = (SELECT id FROM workspaces WHERE slack_team_id = $1)`,
          [slackTeamId],
        ),
      );
      // `tokens.subject_id` points at a user or an endpoint, so it carries no
      // foreign key and the cascade cannot reach it. Left alone, an uninstall
      // leaves live credentials for a tenant that no longer exists.
      await pool.query(
        `WITH doomed_users AS (
           SELECT u.id FROM users u JOIN workspaces w ON w.id = u.workspace_id
            WHERE w.slack_team_id = $1
         )
         DELETE FROM tokens
          WHERE subject_id IN (SELECT id FROM doomed_users)
             OR subject_id IN (SELECT id FROM endpoints WHERE user_id IN (SELECT id FROM doomed_users))`,
        [slackTeamId],
      );
      await pool.query(`DELETE FROM workspaces WHERE slack_team_id = $1`, [slackTeamId]);
      return doomed;
    },
    async deactivateUser(slackTeamId, slackUserId) {
      // Tokens revoked and endpoints unpaired, but their journals survive: a
      // departing member's runs are still the workspace's record until
      // retention or an uninstall takes them.
      await pool.query(
        `WITH target AS (
           UPDATE users u SET deactivated_at = now()
             FROM workspaces w
            WHERE w.id = u.workspace_id AND w.slack_team_id = $1 AND u.slack_user_id = $2
           RETURNING u.id
         ), revoked AS (
           UPDATE tokens SET revoked_at = now()
            WHERE revoked_at IS NULL
              AND (subject_id IN (SELECT id FROM target)
                OR subject_id IN (SELECT id FROM endpoints WHERE user_id IN (SELECT id FROM target)))
         )
         DELETE FROM endpoints WHERE user_id IN (SELECT id FROM target)`,
        [slackTeamId, slackUserId],
      );
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
    const owner = `u-${spec.team}-${spec.slackUser}`;
    const clientToken = randomUUID();
    const endpointToken = randomUUID();
    await pool.query(
      `INSERT INTO workspaces (id, slack_team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [workspace, spec.team],
    );
    await pool.query(
      `INSERT INTO users (id, workspace_id, slack_user_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [owner, workspace, spec.slackUser],
    );
    await pool.query(
      `INSERT INTO endpoints (id, user_id, device_name) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id`,
      [spec.endpoint, owner, spec.device ?? spec.endpoint],
    );
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
