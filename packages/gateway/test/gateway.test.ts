import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { ObserverEnvelope } from '@symma/protocol';

import { localStore } from '../src/store.js';
import {
  appendEnvelope,
  listJournals,
  journalPath,
  listRuns,
  parseRunControl,
  readJournalLines,
  writeRunStatus,
} from '../src/journal.js';

const envelope = (overrides: Partial<ObserverEnvelope> = {}): ObserverEnvelope => ({
  v: 1,
  runId: 'run-1',
  sessionId: 'review',
  seq: 1,
  ts: 1,
  agent: 'kilo',
  label: 'review',
  dir: 'in',
  frame: { jsonrpc: '2.0', method: 'session/update' },
  ...overrides,
});

describe('gateway', () => {
  it('appends, lists, and replays journals from plain files', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'symma-gw-test-'));
    try {
      appendEnvelope(dataDir, envelope({ seq: 1 }));
      appendEnvelope(dataDir, envelope({ seq: 2 }));
      appendEnvelope(dataDir, envelope({ sessionId: 'guideline', seq: 1 }));
      const runs = listRuns(dataDir);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].runId, 'run-1');
      assert.deepEqual(runs[0].sessions, ['guideline', 'review']);
      const lines = readJournalLines(dataDir, 'run-1', 'review');
      assert.deepEqual(
        lines.map((line) => (JSON.parse(line) as ObserverEnvelope).seq),
        [1, 2],
      );
      assert.deepEqual(readJournalLines(dataDir, 'run-1', 'missing'), []);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('parses and stores run-status controls, surfaced in the run listing', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'symma-gw-run-'));
    try {
      const control = parseRunControl(
        JSON.stringify({ v: 1, kind: 'run', runId: 'run-1', status: 'failed', ts: 1 }),
      );
      assert.equal(control?.status, 'failed');
      // A frame is not a control, and a bad status / unsafe id is rejected.
      assert.equal(parseRunControl(JSON.stringify(envelope())), undefined);
      assert.equal(
        parseRunControl(JSON.stringify({ v: 1, kind: 'run', runId: 'r', status: 'bogus', ts: 1 })),
        undefined,
      );
      appendEnvelope(dataDir, envelope());
      writeRunStatus(dataDir, control!);
      assert.equal(listRuns(dataDir)[0].status, 'failed');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('serves ingest → journal → SSE replay and live fanout with token auth', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'symma-gw-int-'));
    const port = 18000 + Math.floor(Math.random() * 2000);
    const base = `http://127.0.0.1:${port}`;
    const token = 'test-token';
    let child: ChildProcess | undefined;
    try {
      child = spawn(
        process.execPath,
        ['--conditions=symma-source', '--import', 'tsx', 'packages/gateway/src/server.ts'],
        {
          env: {
            ...process.env,
            SYMMA_GATEWAY_PORT: String(port),
            SYMMA_GATEWAY_DATA: dataDir,
            SYMMA_GATEWAY_TOKEN: token,
            // Reverse-proxy topology: token auth without the 0.0.0.0 bind.
            SYMMA_GATEWAY_HOST: '127.0.0.1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      // Accumulate stdout: chunk boundaries are arbitrary, so never assert
      // against a single data event.
      let startupLog = '';
      let startupErr = '';
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`gateway did not start: ${startupErr.trim() || 'no stderr'}`)),
          15_000,
        );
        child?.stderr?.on('data', (chunk: Buffer) => {
          startupErr += String(chunk);
        });
        child?.stdout?.on('data', (chunk: Buffer) => {
          startupLog += String(chunk);
          if (startupLog.includes('listening')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child?.on('exit', (code) =>
          reject(new Error(`gateway exited ${code}: ${startupErr.trim() || 'no stderr'}`)),
        );
      });
      assert.ok(startupLog.includes('http://127.0.0.1:'), `host override ignored: ${startupLog}`);

      assert.equal((await fetch(`${base}/healthz`)).status, 200);
      // Token mode: unauthenticated ingest and streams are refused.
      assert.equal((await fetch(`${base}/api/ingest`, { method: 'POST', body: '{}' })).status, 401);
      assert.equal((await fetch(`${base}/api/runs`)).status, 401);

      const auth = { authorization: `Bearer ${token}` };
      const first = envelope({ seq: 1, frame: { jsonrpc: '2.0', method: 'session/update' } });
      const ingest1 = await fetch(`${base}/api/ingest`, {
        method: 'POST',
        headers: auth,
        body: `${JSON.stringify(first)}\nnot json\n`,
      });
      assert.deepEqual(await ingest1.json(), { accepted: 1, rejected: 1 });
      assert.ok(existsSync(journalPath(dataDir, 'run-1', 'review')));

      // Subscribe (gets the replay), then ingest one more (arrives live).
      const stream = await fetch(`${base}/api/runs/run-1/sessions/review/stream?token=${token}`);
      assert.equal(stream.status, 200);
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const seen: number[] = [];
      const readEvents = async (count: number): Promise<void> => {
        while (seen.length < count) {
          const { value, done } = await reader.read();
          if (done) throw new Error('stream ended early');
          buffer += decoder.decode(value, { stream: true });
          for (const match of buffer.matchAll(/^data: (.+)$/gm)) {
            const seq = (JSON.parse(match[1]) as ObserverEnvelope).seq;
            if (!seen.includes(seq)) seen.push(seq);
          }
        }
      };
      await readEvents(1);
      const second = envelope({ seq: 2 });
      await fetch(`${base}/api/ingest`, {
        method: 'POST',
        headers: auth,
        body: `${JSON.stringify(second)}\n`,
      });
      await readEvents(2);
      assert.deepEqual(seen, [1, 2]);
      await reader.cancel();

      const runs = (await (await fetch(`${base}/api/runs?token=${token}`)).json()) as {
        runId: string;
      }[];
      assert.equal(runs[0].runId, 'run-1');

      // `q=0` is a refusal, not a mention (RFC 9110 §12.5.3).
      const journalUrl = `${base}/api/runs/run-1/sessions/review/journal?token=${token}`;
      const encodingFor = async (accept: string): Promise<string | null> =>
        (await fetch(journalUrl, { headers: { 'accept-encoding': accept } })).headers.get(
          'content-encoding',
        );
      assert.equal(await encodingFor('gzip'), 'gzip');
      assert.equal(await encodingFor('gzip;q=0.5'), 'gzip');
      assert.equal(await encodingFor('gzip;q=0'), null);
      assert.equal(await encodingFor('identity'), null);
    } finally {
      child?.kill('SIGKILL');
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('answers the same questions with no database behind it', async () => {
    // The single-tenant path used to be an `if (store)` else-branch at nine
    // call sites, so retention and delete each shipped on one side only. It is
    // the same contract now, backed by the journal directory.
    const dir = mkdtempSync(join(tmpdir(), 'symma-local-store-'));
    try {
      const frame = (runId: string, sessionId: string): void =>
        appendEnvelope(dir, {
          v: 1,
          runId,
          sessionId,
          seq: 1,
          ts: 1,
          agent: 'kilo',
          label: 'l',
          dir: 'out',
          frame: {},
        });
      frame('run-a', 'sid-a');
      frame('run-b', 'sid-b');
      const store = localStore('secret', new Map([['box', 'endpoint-secret']]), () =>
        listJournals(dir),
      );

      await Promise.all([
        // One tenant, so every journal is theirs — and a wrong token is nobody.
        store.ownerForClientToken('secret').then((o) => assert.equal(o, 'local')),
        store.ownerForClientToken('wrong').then((o) => assert.equal(o, undefined)),
        store
          .endpointForToken('endpoint-secret')
          .then((e) => assert.deepEqual(e, { endpoint: 'box', owner: 'local' })),
        store.ownerForSession('run-a', 'sid-a').then((o) => assert.equal(o, 'local')),
        store.ownerForSession('run-a', 'nope').then((o) => assert.equal(o, undefined)),
        // Retention runs here too — this was skipped entirely without a database.
        store
          .expireSessions(0, [])
          .then((doomed) =>
            assert.deepEqual(doomed.map((d) => d.sessionId).sort(), ['sid-a', 'sid-b']),
          ),
        store.expireSessions(0, ['sid-a']).then((doomed) =>
          assert.deepEqual(
            doomed.map((d) => d.sessionId),
            ['sid-b'],
          ),
        ),
        store.expireSessions(30, []).then((doomed) => assert.deepEqual(doomed, [])),
        // And delete reports what it removed, so the caller ends the session.
        store
          .deleteSession('local', 'run-a', 'sid-a')
          .then((gone) => assert.deepEqual(gone, [{ runId: 'run-a', sessionId: 'sid-a' }])),
        store.deleteSession('local', 'run-a', 'gone').then((g) => assert.deepEqual(g, [])),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
