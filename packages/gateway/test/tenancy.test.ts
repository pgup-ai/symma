import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { appendEnvelope, deleteJournal, readJournalLines } from '../src/journal.js';
import { openStore, provision } from '../src/store.js';

// M3a's bar: a second user can neither open a session on, nor list, nor read
// journals or the viewer for, the first user's companion. Black box on purpose
// — these are HTTP answers, not function returns.
let pg: StartedPostgreSqlContainer;
let gateway: ChildProcess | undefined;
let base: string;
let dataDir: string;
let alice: Awaited<ReturnType<typeof provision>>;
let bob: Awaited<ReturnType<typeof provision>>;

const waitFor = async <T>(probe: () => Promise<T | undefined>, what: string): Promise<T> => {
  for (let i = 0; i < 100; i++) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};

before(
  async () => {
    pg = await new PostgreSqlContainer('postgres:17-alpine').start();
    const url = pg.getConnectionUri();
    // Creating the schema is openStore's job; do it once up front so provision()
    // has tables to write into.
    await (await openStore(url, join(import.meta.dirname, '../src/schema.sql'))).close();
    alice = await provision(url, { team: 'acme', slackUser: 'alice', endpoint: 'alice-laptop' });
    bob = await provision(url, { team: 'acme', slackUser: 'bob', endpoint: 'bob-laptop' });

    dataDir = mkdtempSync(join(tmpdir(), 'symma-tenancy-'));
    const port = 26000 + Math.floor(Math.random() * 2000);
    base = `http://127.0.0.1:${port}`;
    gateway = spawn(
      process.execPath,
      ['--conditions=symma-source', '--import', 'tsx', 'packages/gateway/src/server.ts'],
      {
        env: {
          ...process.env,
          SYMMA_GATEWAY_PORT: String(port),
          SYMMA_GATEWAY_DATA: dataDir,
          SYMMA_GATEWAY_HOST: '127.0.0.1',
          SYMMA_GATEWAY_TOKEN: 'unused-when-a-store-is-configured',
          SYMMA_GATEWAY_DATABASE_URL: url,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    await waitFor(
      async () => ((await fetch(`${base}/healthz`)).ok ? true : undefined),
      'gateway up',
    );
  },
  { timeout: 180_000 },
);

after(async () => {
  gateway?.kill('SIGKILL');
  rmSync(dataDir, { recursive: true, force: true });
  await pg?.stop();
});

/** Backdates a session so retention has something old to find. */
const ageSession = async (url: string, sessionId: string, days: number): Promise<void> => {
  const admin = await openStore(url, join(import.meta.dirname, '../src/schema.sql'));
  await admin.close();
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: url });
  await pool.query(
    `UPDATE sessions SET started_at = now() - make_interval(days => $2) WHERE id = $1`,
    [sessionId, days],
  );
  await pool.end();
};

const forget = (refs: { runId: string; sessionId: string }[]): void => {
  for (const { runId, sessionId } of refs) deleteJournal(dataDir, runId, sessionId);
};

const as = (token: string, path: string, init?: RequestInit): Promise<Response> =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init?.headers },
  });

/** Attach a companion for `endpoint` and leave its SSE leg open. */
const attach = async (token: string, endpoint: string, agents = ['kilo']): Promise<() => void> => {
  const abort = new AbortController();
  void fetch(`${base}/api/endpoints/${endpoint}/stream`, {
    headers: { authorization: `Bearer ${token}` },
    signal: abort.signal,
  }).catch(() => undefined);
  await as(token, `/api/endpoints/${endpoint}/ingest`, {
    method: 'POST',
    body: `${JSON.stringify({
      kind: 'hello',
      endpoint,
      device: endpoint,
      agents: agents.map((agent) => ({ agent })),
      maxSessions: 2,
    })}\n`,
  });
  return () => abort.abort();
};

describe('tenancy', () => {
  it('scopes endpoints, sessions, journals and listings to their owner', async () => {
    const detach = await attach(alice.endpointToken, 'alice-laptop');
    try {
      await waitFor(async () => {
        const listed = (await (await as(alice.clientToken, '/api/endpoints')).json()) as {
          endpoint: string;
        }[];
        return listed.some((e) => e.endpoint === 'alice-laptop') ? true : undefined;
      }, 'alice sees her endpoint');

      // 1. Listing shows only your own.
      const bobSees = (await (await as(bob.clientToken, '/api/endpoints')).json()) as unknown[];
      assert.deepEqual(bobSees, [], "bob's listing does not include alice's endpoint");

      // 2. Opening a session on it is refused, and refused as `offline` — the
      //    same answer an endpoint that is merely away gives, so probing tells
      //    him nothing about whether it exists.
      const refusal = await waitFor(async () => {
        const res = await as(bob.clientToken, '/api/sessions/sid-bob/ingest', {
          method: 'POST',
          body: `${JSON.stringify({
            kind: 'open',
            sessionId: 'sid-bob',
            runId: 'run-bob',
            endpoint: 'alice-laptop',
            agent: 'kilo',
          })}\n`,
        });
        return res.ok ? true : undefined;
      }, "bob's open is accepted for routing");
      assert.equal(refusal, true);

      // Alice's companion must never have been asked.
      const opened = (await (await as(alice.clientToken, '/api/endpoints')).json()) as {
        activeSessions: number;
      }[];
      assert.equal(opened[0]?.activeSessions, 0, "bob's open never reached alice's endpoint");

      // Nor may the refusal leave a row. It would name ALICE's endpoint, and
      // recordSession is ON CONFLICT DO NOTHING — so if bob later opened this
      // id for real, the stale row would still say alice, handing her his
      // journal.
      const store = await openStore(
        pg.getConnectionUri(),
        join(import.meta.dirname, '../src/schema.sql'),
      );
      try {
        assert.equal(
          await store.ownerForSession('run-bob', 'sid-bob'),
          undefined,
          'a refused open records no session',
        );
      } finally {
        await store.close();
      }

      // 3. An unknown token is nobody.
      assert.equal((await as('not-a-token', '/api/endpoints')).status, 401);
      assert.equal((await as('not-a-token', '/api/runs')).status, 401);
    } finally {
      detach();
    }
  });

  it("hides another owner's journal and run listing", async () => {
    // The frame makes the journal exist; the session row makes it alice's.
    // Both are needed, and only the second is what this test is about.
    appendEnvelope(dataDir, {
      v: 1,
      runId: 'run-alice',
      sessionId: 'sid-alice',
      seq: 1,
      ts: 1,
      agent: 'kilo',
      label: 'review',
      dir: 'out',
      frame: { method: 'initialize' },
    });
    const store = await openStore(
      pg.getConnectionUri(),
      join(import.meta.dirname, '../src/schema.sql'),
    );
    try {
      await store.recordSession({
        id: 'sid-alice',
        runId: 'run-alice',
        endpoint: 'alice-laptop',
        agent: 'kilo',
      });
    } finally {
      await store.close();
    }

    const path = '/api/runs/run-alice/sessions/sid-alice/journal';
    assert.equal((await as(alice.clientToken, path)).status, 200);
    // 404, not 403: whether the session exists is itself alice's to know.
    assert.equal((await as(bob.clientToken, path)).status, 404);
    assert.equal(
      (await as(bob.clientToken, '/api/runs/run-alice/sessions/sid-alice/stream')).status,
      404,
    );

    const bobRuns = (await (await as(bob.clientToken, '/api/runs')).json()) as unknown[];
    assert.deepEqual(bobRuns, [], "bob's run listing is empty");
  });

  it('deletes, expires and uninstalls frames with their rows', async () => {
    const url = pg.getConnectionUri();
    const schema = join(import.meta.dirname, '../src/schema.sql');
    const frame = (runId: string, sessionId: string): void =>
      appendEnvelope(dataDir, {
        v: 1,
        runId,
        sessionId,
        seq: 1,
        ts: 1,
        agent: 'kilo',
        label: 'review',
        dir: 'out',
        frame: {},
      });
    const store = await openStore(url, schema);
    const seed = async (runId: string, sessionId: string, endpoint: string): Promise<void> => {
      frame(runId, sessionId);
      await store.recordSession({ id: sessionId, runId, endpoint, agent: 'kilo' });
    };

    try {
      // Deleting your own takes the frames with it; someone else's is a 404 and
      // leaves them alone.
      await seed('run-del', 'sid-del', 'alice-laptop');
      assert.equal(
        (
          await as(bob.clientToken, '/api/runs/run-del/sessions/sid-del/journal', {
            method: 'DELETE',
          })
        ).status,
        404,
      );
      assert.notDeepEqual(readJournalLines(dataDir, 'run-del', 'sid-del'), []);
      assert.equal(
        (
          await as(alice.clientToken, '/api/runs/run-del/sessions/sid-del/journal', {
            method: 'DELETE',
          })
        ).status,
        204,
      );
      assert.deepEqual(readJournalLines(dataDir, 'run-del', 'sid-del'), []);

      // Retention is by age, so a fresh session survives its own sweep.
      await seed('run-old', 'sid-old', 'alice-laptop');
      await seed('run-new', 'sid-new', 'alice-laptop');
      await ageSession(url, 'sid-old', 40);
      const expired = await store.expireSessions(30);
      forget(expired);
      assert.deepEqual(expired, [{ runId: 'run-old', sessionId: 'sid-old' }]);
      assert.deepEqual(readJournalLines(dataDir, 'run-old', 'sid-old'), []);
      assert.notDeepEqual(readJournalLines(dataDir, 'run-new', 'sid-new'), []);

      // Uninstall reports the frames before the cascade removes the rows, or
      // they would be unreachable and undeletable.
      await seed('run-gone', 'sid-gone', 'bob-laptop');
      forget(await store.deleteWorkspace('acme'));
      assert.deepEqual(readJournalLines(dataDir, 'run-gone', 'sid-gone'), []);
      // tokens.subject_id is polymorphic, so no cascade reaches it — an
      // uninstall that skipped them would leave live credentials behind.
      assert.equal(await store.ownerForClientToken(alice.clientToken), undefined);
      assert.equal(await store.endpointForToken(alice.endpointToken), undefined);
    } finally {
      await store.close();
    }
  });

  it('revokes tokens and unpairs endpoints when a member is deactivated', async () => {
    const url = pg.getConnectionUri();
    const schema = join(import.meta.dirname, '../src/schema.sql');
    const carol = await provision(url, {
      team: 'other',
      slackUser: 'carol',
      endpoint: 'carol-laptop',
    });
    const store = await openStore(url, schema);
    try {
      assert.equal(await store.ownerForClientToken(carol.clientToken), carol.owner);
      await store.deactivateUser('other', 'carol');
      assert.equal(await store.ownerForClientToken(carol.clientToken), undefined);
      assert.equal(await store.endpointForToken(carol.endpointToken), undefined);
    } finally {
      await store.close();
    }
  });
});
