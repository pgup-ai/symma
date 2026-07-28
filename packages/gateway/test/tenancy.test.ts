import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';

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
    // Piped and drained: the gateway logs per attach and refusal, and an unread
    // pipe eventually blocks it mid-test.
    gateway.stdout?.resume();
    gateway.stderr?.resume();
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

/** Runs `act`, then resolves with the first control the gateway pushes to that
 * session's stream. */
const onceOnStream = async (
  token: string,
  sid: string,
  act: () => Promise<void>,
): Promise<{ kind?: string; code?: string }> => {
  const abort = new AbortController();
  const res = await fetch(`${base}/api/sessions/${sid}/stream`, {
    headers: { authorization: `Bearer ${token}` },
    signal: abort.signal,
  });
  const reader = res.body!.getReader();
  try {
    await act();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream for ${sid} ended before a control arrived`);
      buffer += decoder.decode(value, { stream: true });
      // Complete lines only. A chunk boundary inside `data: {...}` leaves a
      // fragment that still starts with the prefix, and parsing it throws.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) return JSON.parse(line.slice(6)) as { kind?: string };
      }
    }
  } finally {
    abort.abort();
  }
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

      // 2. Opening a session on it comes back refused as `offline` — the same
      //    answer an endpoint that is merely away gives, so probing tells him
      //    nothing about whether it exists. Read off his own session stream:
      //    the ingest POST only reports that the line was accepted.
      const refusal = await onceOnStream(bob.clientToken, 'sid-bob', async () => {
        await as(bob.clientToken, '/api/sessions/sid-bob/ingest', {
          method: 'POST',
          body: `${JSON.stringify({
            kind: 'open',
            sessionId: 'sid-bob',
            runId: 'run-bob',
            endpoint: 'alice-laptop',
            agent: 'kilo',
          })}\n`,
        });
      });
      assert.equal(refusal.kind, 'refused');
      assert.equal(refusal.code, 'offline', 'indistinguishable from merely away');

      // Alice's companion must never have been asked.
      const opened = (await (await as(alice.clientToken, '/api/endpoints')).json()) as {
        activeSessions: number;
      }[];
      assert.equal(opened[0]?.activeSessions, 0, "bob's open never reached alice's endpoint");

      // Nor may the refusal leave a row. It would name ALICE's endpoint, so
      // bob could never open that id for real afterwards — the insert would
      // conflict and close his session.
      const store = await openStore(
        pg.getConnectionUri(),
        join(import.meta.dirname, '../src/schema.sql'),
      );
      try {
        assert.equal(
          await store.sessionBelongsTo(alice.owner, 'run-bob', 'sid-bob'),
          false,
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

      // Its own workspace: uninstalling the shared one would invalidate alice
      // and bob for every test after this, which is an ordering rule nobody
      // adding a test would see.
      const doomed = await provision(url, {
        team: 'doomed',
        slackUser: 'ivan',
        endpoint: 'ivan-box',
      });
      await seed('run-gone', 'sid-gone', 'ivan-box');
      // Uninstall reports the frames before the cascade removes the rows, or
      // they would be unreachable and undeletable.
      forget(await store.deleteWorkspace('doomed'));
      assert.deepEqual(readJournalLines(dataDir, 'run-gone', 'sid-gone'), []);
      // tokens.subject_id is polymorphic, so no cascade reaches it — an
      // uninstall that skipped them would leave live credentials behind.
      assert.equal(await store.ownerForClientToken(doomed.clientToken), undefined);
      assert.equal(await store.endpointForToken(doomed.endpointToken), undefined);
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
      appendEnvelope(dataDir, {
        v: 1,
        runId: 'run-carol',
        sessionId: 'sid-carol',
        seq: 1,
        ts: 1,
        agent: 'kilo',
        label: 'review',
        dir: 'out',
        frame: {},
      });
      await store.recordSession({
        id: 'sid-carol',
        runId: 'run-carol',
        endpoint: 'carol-laptop',
        agent: 'kilo',
      });
      // Dropping her endpoints cascades the rows away, so the frames have to
      // come back or they are stranded: unreachable by any route and invisible
      // to retention, which reads sessions.started_at.
      const doomed = await store.deactivateUser('other', 'carol');
      assert.deepEqual(doomed, [{ runId: 'run-carol', sessionId: 'sid-carol' }]);
      forget(doomed);
      assert.deepEqual(readJournalLines(dataDir, 'run-carol', 'sid-carol'), []);
      assert.equal(await store.ownerForClientToken(carol.clientToken), undefined);
      assert.equal(await store.endpointForToken(carol.endpointToken), undefined);
    } finally {
      await store.close();
    }
  });

  it("keeps another owner off a live session's leg, frames and close", async () => {
    // Ownership was enforced on the observer routes and not on /api/sessions,
    // where the damage is worse: the stream is last-connection-wins, so an
    // unchecked connect takes the owner's leg away as well as reading it.
    // Own tenants: the uninstall case above deletes the acme workspace, so
    // alice and bob no longer exist by the time this runs.
    const url = pg.getConnectionUri();
    const dana = await provision(url, { team: 'live', slackUser: 'dana', endpoint: 'dana-laptop' });
    const eve = await provision(url, { team: 'live', slackUser: 'eve', endpoint: 'eve-laptop' });
    const detach = await attach(dana.endpointToken, 'dana-laptop');
    try {
      // The stub companion never acks, so `opened` never comes back — what
      // matters is that the relay accepted it and the session now has an owner.
      await as(dana.clientToken, '/api/sessions/sid-live/ingest', {
        method: 'POST',
        body: `${JSON.stringify({
          kind: 'open',
          sessionId: 'sid-live',
          runId: 'run-live',
          endpoint: 'dana-laptop',
          agent: 'kilo',
        })}\n`,
      });
      const live = async (): Promise<number> =>
        (
          (await (await as(dana.clientToken, '/api/endpoints')).json()) as {
            activeSessions: number;
          }[]
        )[0]!.activeSessions;
      await waitFor(async () => ((await live()) === 1 ? true : undefined), 'dana opened hers');

      assert.equal(
        (
          await as(eve.clientToken, '/api/sessions/sid-live/stream', {
            headers: { accept: 'text/event-stream' },
          })
        ).status,
        404,
        "eve cannot take dana's client leg",
      );

      // A close and a frame are accepted at the transport and dropped inside:
      // answering differently would confirm the session exists.
      for (const body of [
        JSON.stringify({ kind: 'close', sessionId: 'sid-live', reason: 'bye' }),
        JSON.stringify({
          v: 1,
          runId: 'run-live',
          sessionId: 'sid-live',
          seq: 1,
          ts: 1,
          agent: 'kilo',
          label: 'l',
          dir: 'out',
          frame: {},
        }),
      ]) {
        await as(eve.clientToken, '/api/sessions/sid-live/ingest', {
          method: 'POST',
          body: `${body}\n`,
        });
      }
      assert.equal(await live(), 1, "eve's close did not end dana's session");

      // And an open reusing dana's session id must not end it either. The
      // relay refuses `session_in_use`, but asking sessionRun whether the open
      // landed answers about DANA's session — and the failed insert that
      // follows closes it.
      await as(eve.clientToken, '/api/sessions/sid-live/ingest', {
        method: 'POST',
        body: `${JSON.stringify({
          kind: 'open',
          sessionId: 'sid-live',
          runId: 'run-eve',
          endpoint: 'eve-laptop',
          agent: 'kilo',
        })}\n`,
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(await live(), 1, "eve's duplicate id did not end dana's session");

      // Nor may eve's companion refuse a session it does not hold. The relay
      // ignores the cross-endpoint ack; acting on it anyway would delete dana's
      // row, stripping her journal of both authorization and retention.
      const detachEve = await attach(eve.endpointToken, 'eve-laptop');
      try {
        await as(eve.endpointToken, '/api/endpoints/eve-laptop/ingest', {
          method: 'POST',
          body: `${JSON.stringify({ kind: 'refused', sessionId: 'sid-live', reason: 'nope' })}\n`,
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(await live(), 1, "eve's forged refusal did not end dana's session");
        const store = await openStore(
          pg.getConnectionUri(),
          join(import.meta.dirname, '../src/schema.sql'),
        );
        try {
          assert.equal(await store.sessionBelongsTo(dana.owner, 'run-live', 'sid-live'), true);
        } finally {
          await store.close();
        }
      } finally {
        detachEve();
      }
      // Deleting a live session ends it. Leaving it running would let the next
      // frame recreate the journal with no row — past every route and past
      // retention, so the delete would grow what is retained.
      assert.equal(
        (
          await as(dana.clientToken, '/api/runs/run-live/sessions/sid-live/journal', {
            method: 'DELETE',
          })
        ).status,
        204,
      );
      // Immediately, not eventually: closeSession is synchronous, and a
      // `waitFor` here would also pass for a session that ended some other way.
      assert.equal(await live(), 0, 'deleting a live session ends it');
    } finally {
      detach();
    }
  });

  it('refuses the observer tee and endpoint theft in multi-tenant mode', async () => {
    // /api/ingest journals sessions this gateway never routed, so its runId and
    // sessionId are whatever the caller says — there is nothing to check them
    // against, and unchecked any tenant writes into another's journal.
    // Fresh tenant: the uninstall case deleted acme, so alice and bob are gone.
    const frank = await provision(pg.getConnectionUri(), {
      team: 'tee',
      slackUser: 'frank',
      endpoint: 'frank-laptop',
    });
    const res = await as(frank.clientToken, '/api/ingest', {
      method: 'POST',
      body: `${JSON.stringify({
        v: 1,
        runId: 'run-alice',
        sessionId: 'sid-alice',
        seq: 99,
        ts: 1,
        agent: 'kilo',
        label: 'l',
        dir: 'out',
        frame: {},
      })}\n`,
    });
    assert.equal(res.status, 404);

    // And an endpoint id is claimed once: reassigning it would hand its
    // historical journals to the new owner and leave the old owner's token
    // authenticating as them.
    await assert.rejects(
      provision(pg.getConnectionUri(), {
        team: 'live',
        slackUser: 'mallory',
        endpoint: 'dana-laptop',
      }),
      /already belongs to/,
    );
  });

  it('keeps a shared run id from leaking session ids across owners', async () => {
    // runId is caller-chosen, so two tenants can land in one run directory and
    // listRuns returns every journal filename in it.
    const url = pg.getConnectionUri();
    const gina = await provision(url, { team: 'shared', slackUser: 'gina', endpoint: 'gina-box' });
    const hank = await provision(url, { team: 'shared', slackUser: 'hank', endpoint: 'hank-box' });
    const store = await openStore(url, join(import.meta.dirname, '../src/schema.sql'));
    try {
      for (const [sid, endpoint] of [
        ['sid-gina', 'gina-box'],
        ['sid-hank', 'hank-box'],
      ] as const) {
        appendEnvelope(dataDir, {
          v: 1,
          runId: 'run-shared',
          sessionId: sid,
          seq: 1,
          ts: 1,
          agent: 'kilo',
          label: 'l',
          dir: 'out',
          frame: {},
        });
        await store.recordSession({ id: sid, runId: 'run-shared', endpoint, agent: 'kilo' });
      }
      const seen = async (token: string): Promise<string[]> =>
        (
          (await (await as(token, '/api/runs')).json()) as { runId: string; sessions: string[] }[]
        ).find((r) => r.runId === 'run-shared')!.sessions;
      assert.deepEqual(await seen(gina.clientToken), ['sid-gina']);
      assert.deepEqual(await seen(hank.clientToken), ['sid-hank']);
    } finally {
      await store.close();
    }
  });

  it('refuses a session id that is already recorded', async () => {
    // The id is the journal's filename as well as this row's key, so it has to
    // stay globally unique — two rows addressing one file would let either
    // owner read and delete the other's frames. That makes a cross-tenant
    // collision a refusal rather than a leak: the wrong trade to reverse, and
    // the real fix is a server-assigned identity, not a looser key here.
    const url = pg.getConnectionUri();
    const store = await openStore(url, join(import.meta.dirname, '../src/schema.sql'));
    const session = (endpoint: string, runId: string) => ({
      id: 'sid-shared',
      runId,
      endpoint,
      agent: 'kilo',
    });
    try {
      await store.recordSession(session('frank-laptop', 'run-same'));
      await assert.rejects(store.recordSession(session('gina-box', 'run-same')));
      await assert.rejects(store.recordSession(session('frank-laptop', 'run-other')));
      assert.equal(await store.sessionBelongsTo('u-tee-frank', 'run-same', 'sid-shared'), true);
      assert.equal(await store.sessionBelongsTo('u-shared-gina', 'run-same', 'sid-shared'), false);

      await store.deleteSessionRow('sid-shared', 'run-same', 'frank-laptop');
      assert.equal(await store.sessionBelongsTo('u-tee-frank', 'run-same', 'sid-shared'), false);
    } finally {
      await store.close();
    }
  });

  it('leaves a live session alone when retention comes for it', async () => {
    // Deleting a live session's row does not stop the frames: the relay keeps
    // writing, recreating a journal with no row — unreadable, and invisible to
    // every sweep after.
    const url = pg.getConnectionUri();
    const store = await openStore(url, join(import.meta.dirname, '../src/schema.sql'));
    try {
      await store.recordSession({
        id: 'sid-running',
        runId: 'run-running',
        endpoint: 'gina-box',
        agent: 'kilo',
      });
      await ageSession(url, 'sid-running', 40);
      assert.deepEqual(
        await store.expireSessions(30, [
          { endpoint: 'gina-box', runId: 'run-running', sessionId: 'sid-running' },
        ]),
        [],
      );

      // A different session, live elsewhere, must not shield this one.
      assert.deepEqual(
        await store.expireSessions(30, [
          { endpoint: 'gina-box', runId: 'run-other', sessionId: 'sid-elsewhere' },
        ]),
        [{ runId: 'run-running', sessionId: 'sid-running' }],
      );
    } finally {
      await store.close();
    }
  });

  it('lets a pre-open stream be claimed once, and answers conflicts only to their sender', async () => {
    const url = pg.getConnectionUri();
    const jo = await provision(url, { team: 'claim', slackUser: 'jo', endpoint: 'jo-box' });
    const kim = await provision(url, { team: 'claim', slackUser: 'kim', endpoint: 'kim-box' });

    // Before any open the relay has no owner for the id, so both callers used
    // to pass and the second ended the first's leg — which the client reads as
    // its session failing.
    const abort = new AbortController();
    const held = await fetch(`${base}/api/sessions/sid-claim/stream`, {
      headers: { authorization: `Bearer ${jo.clientToken}` },
      signal: abort.signal,
    });
    try {
      assert.equal(held.status, 200);
      assert.equal((await as(kim.clientToken, '/api/sessions/sid-claim/stream')).status, 404);
    } finally {
      abort.abort();
    }

    // And a duplicate open is answered to its sender or to nobody, never down
    // the leg the existing owner is listening on.
    const store = await openStore(url, join(import.meta.dirname, '../src/schema.sql'));
    try {
      await store.recordSession({
        id: 'sid-taken',
        runId: 'run-jo',
        endpoint: 'jo-box',
        agent: 'kilo',
      });
    } finally {
      await store.close();
    }
    const joLeg = new AbortController();
    const joStream = await fetch(`${base}/api/sessions/sid-taken/stream`, {
      headers: { authorization: `Bearer ${jo.clientToken}` },
      signal: joLeg.signal,
    });
    try {
      const reader = joStream.body!.getReader();
      const decoder = new TextDecoder();
      let seen = '';
      // The leg emits its own connect traffic, so watch for the refusal itself
      // rather than for any bytes at all.
      // Aborting the leg rejects the pending read, which is how this ends.
      void (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          seen += decoder.decode(value, { stream: true });
        }
      })().catch(() => undefined);
      await as(kim.clientToken, '/api/sessions/sid-taken/ingest', {
        method: 'POST',
        body: `${JSON.stringify({
          kind: 'open',
          sessionId: 'sid-taken',
          runId: 'run-jo',
          endpoint: 'kim-box',
          agent: 'kilo',
        })}\n`,
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.doesNotMatch(seen, /refused/, "kim's conflict never reached jo's leg");
    } finally {
      joLeg.abort();
    }
  });

  it('does not revoke a token whose id collides across the two subject kinds', async () => {
    // tokens.subject_id names a user or an endpoint and the ids are not
    // namespaced, so an endpoint named after another workspace's user id used
    // to lose its token when that workspace was removed.
    const url = pg.getConnectionUri();
    const victim = await provision(url, {
      team: 'collide',
      slackUser: 'liz',
      endpoint: 'u-gone-mo',
    });
    await provision(url, { team: 'gone', slackUser: 'mo', endpoint: 'mo-box' });
    const store = await openStore(url, join(import.meta.dirname, '../src/schema.sql'));
    try {
      forget(await store.deleteWorkspace('gone'));
      assert.deepEqual(await store.endpointForToken(victim.endpointToken), {
        endpoint: 'u-gone-mo',
        owner: victim.owner,
      });
    } finally {
      await store.close();
    }
  });

  it('takes the frames when a refused open releases its row', async () => {
    // The relay accepts an open before the companion sees it, so frames can be
    // journaled before a refusal arrives. Deleting only the row leaves a file
    // no owner-scoped route reaches and retention never sees, which a
    // misbehaving companion could repeat until the disk is gone.
    const url = pg.getConnectionUri();
    const store = await openStore(url, join(import.meta.dirname, '../src/schema.sql'));
    try {
      appendEnvelope(dataDir, {
        v: 1,
        runId: 'run-refused',
        sessionId: 'sid-refused',
        seq: 1,
        ts: 1,
        agent: 'kilo',
        label: 'l',
        dir: 'in',
        frame: {},
      });
      await store.recordSession({
        id: 'sid-refused',
        runId: 'run-refused',
        endpoint: 'gina-box',
        agent: 'kilo',
      });
      const released = await store.deleteSessionRow('sid-refused', 'run-refused', 'gina-box');
      assert.deepEqual(released, [{ runId: 'run-refused', sessionId: 'sid-refused' }]);
      forget(released);
      assert.deepEqual(readJournalLines(dataDir, 'run-refused', 'sid-refused'), []);
    } finally {
      await store.close();
    }
  });
});
