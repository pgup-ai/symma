import assert from 'node:assert/strict';
import { generateSigningKeys, verifyEnvelope, type ObserverEnvelope } from '@symma/protocol';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { describe, it } from 'node:test';

import { readJournalLines } from '@symma/gateway';

// Scripted ACP agent: answers initialize/new/prompt like a real CLI, so the
// black-box path (client → gateway → companion → agent and back) is exercised
// with zero credentials.
const ECHO_AGENT = `
let buf = '';
process.stdin.setEncoding('utf8');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
    else if (m.method === 'session/new') out({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'a1' } });
    else if (m.method === 'session/prompt') {
      out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'a1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'echo!' } } } });
      out({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
    }
  }
});
`;

const envelope = (sessionId: string, seq: number, frame: object): string =>
  JSON.stringify({
    v: 1,
    runId: 'run-e2e',
    sessionId,
    seq,
    ts: Date.now(),
    agent: 'echo',
    label: 'client',
    dir: 'out',
    frame,
  });

/** The shape `symma pair` will write, until it exists to write it. */
const writePairing = (home: string, contents: string): void => {
  const dir = join(home, '.local', 'share', 'symma-companion');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pairing.json'), contents);
};

/** `settled`'s value, or 'timeout'. The timer is cleared either way, so a race
 * the fast path wins does not then hold the loop open until it fires. */
const within = async <T>(ms: number, settled: Promise<T>): Promise<T | 'timeout'> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([settled, late]);
  } finally {
    clearTimeout(timer);
  }
};

/** A child inheriting no configuration of ours — for the tests that assert what
 * a machine does with none. A runner's own SYMMA_COMPANION_AGENTS would replace
 * the built-in default one of them is about, its GATEWAY and TOKEN would start a
 * companion that should have said it was unpaired, and the blanked keys are the
 * credentials that live outside HOME — any real one makes a bare machine
 * pairable (XDG_DATA_HOME likewise points detection away from the fake HOME). */
const bare = (home: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CURSOR_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    XDG_DATA_HOME: '',
  };
  for (const key of Object.keys(env)) if (key.startsWith('SYMMA_COMPANION_')) delete env[key];
  return env;
};

async function waitFor<T>(probe: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('relay e2e', () => {
  it('relays a full session client → gateway → companion → agent and back', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'symma-relay-e2e-'));
    // The companion writes a signing key under HOME on startup; give it a
    // throwaway one, or the suite leaves real key material in the developer's
    // own ~/.local/share and reuses it across runs.
    const companionHome = mkdtempSync(join(tmpdir(), 'symma-companion-home-'));
    const agentPath = join(dataDir, 'echo-agent.mjs');
    writeFileSync(agentPath, ECHO_AGENT);
    const port = 22000 + Math.floor(Math.random() * 2000);
    const base = `http://127.0.0.1:${port}`;
    let gateway: ChildProcess | undefined;
    let companion: ChildProcess | undefined;
    let tornDown = false;
    try {
      gateway = spawn(
        process.execPath,
        ['--conditions=symma-source', '--import', 'tsx', 'packages/gateway/src/server.ts'],
        {
          env: {
            ...process.env,
            SYMMA_GATEWAY_PORT: String(port),
            SYMMA_GATEWAY_DATA: dataDir,
            SYMMA_GATEWAY_TOKEN: 'client-tok',
            SYMMA_GATEWAY_HOST: '127.0.0.1',
            SYMMA_GATEWAY_ENDPOINTS: 'e2e:endpoint-tok',
            SYMMA_GATEWAY_RESUME_MS: '400',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let startupErr = '';
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`gateway did not start: ${startupErr.trim() || 'no stderr'}`)),
          15_000,
        );
        gateway?.stderr?.on('data', (chunk: Buffer) => {
          startupErr += String(chunk);
        });
        gateway?.stdout?.on('data', (chunk: Buffer) => {
          if (String(chunk).includes('listening')) {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      // Wrong endpoint token is refused before any relay state exists.
      const bad = await fetch(`${base}/api/endpoints/e2e/stream?token=wrong`);
      assert.equal(bad.status, 401);
      await bad.body?.cancel();

      companion = spawn(
        process.execPath,
        ['--conditions=symma-source', '--import', 'tsx', 'packages/companion/src/index.ts'],
        {
          env: {
            ...process.env,
            HOME: companionHome,
            SYMMA_COMPANION_GATEWAY: base,
            SYMMA_COMPANION_TOKEN: 'endpoint-tok',
            SYMMA_COMPANION_ENDPOINT: 'e2e',
            SYMMA_COMPANION_DEVICE: 'test-box',
            SYMMA_COMPANION_AGENTS: `echo=${process.execPath} ${agentPath}`,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      const auth = { authorization: 'Bearer client-tok' };
      const presence = await waitFor(async () => {
        const listed = (await (await fetch(`${base}/api/endpoints`, { headers: auth })).json()) as {
          endpoint: string;
          device: string;
          agents: { agent: string }[];
          publicKey?: string;
        }[];
        return listed.find((entry) => entry.endpoint === 'e2e');
      }, 'endpoint presence');
      assert.equal(presence.device, 'test-box');
      assert.deepEqual(presence.agents, [{ agent: 'echo' }]);

      // Client SSE leg first, then one streaming ingest with open + frames.
      const stream = await fetch(`${base}/api/sessions/sid-e2e/stream?token=client-tok`);
      assert.equal(stream.status, 200);
      // Reader runs for the stream's whole life so late frames (the loud
      // close) are captured too; waiters poll `lines`.
      const lines: string[] = [];
      void (async () => {
        const reader = stream.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let nl = buffer.indexOf('\n');
          while (nl !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line.startsWith('data: ')) lines.push(line.slice(6));
            nl = buffer.indexOf('\n');
          }
        }
      })().catch((error: unknown) => {
        // Nothing awaits this reader and the assertions below wait on `lines`,
        // so a silent failure would arrive as a timeout naming a frame that
        // never came. Teardown always kills the stream, and reporting that
        // would cry wolf on every green run.
        if (tornDown) return;
        console.error(`SSE reader failed: ${error instanceof Error ? error.message : error}`);
      });

      const body = [
        JSON.stringify({
          kind: 'open',
          sessionId: 'sid-e2e',
          runId: 'run-e2e',
          endpoint: 'e2e',
          agent: 'echo',
        }),
        envelope('sid-e2e', 1, {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: 1 },
        }),
        envelope('sid-e2e', 2, {
          jsonrpc: '2.0',
          id: 2,
          method: 'session/new',
          params: { cwd: '.' },
        }),
        envelope('sid-e2e', 3, {
          jsonrpc: '2.0',
          id: 3,
          method: 'session/prompt',
          params: { sessionId: 'a1' },
        }),
        '',
      ].join('\n');
      const ingest = await fetch(`${base}/api/sessions/sid-e2e/ingest`, {
        method: 'POST',
        headers: auth,
        body,
      });
      assert.equal(ingest.status, 200);
      await waitFor(async () => {
        const text = lines.join('\n');
        return text.includes('"opened"') && text.includes('echo!') && text.includes('end_turn')
          ? true
          : undefined;
      }, 'opened + echoed reply + end_turn');

      // Both directions journaled under the client's run id.
      const journaled = readJournalLines(dataDir, 'run-e2e', 'sid-e2e').map(
        (line) => JSON.parse(line) as ObserverEnvelope,
      );
      assert.ok(journaled.some((entry) => entry.dir === 'out'));
      assert.ok(journaled.some((entry) => entry.dir === 'in' && entry.agent === 'echo'));

      // The companion's own frames must verify against the key it advertised,
      // through the real relay and journal rather than a hand-built envelope.
      assert.ok(presence.publicKey, 'companion advertised a signing key');
      const signed = journaled.filter((entry) => entry.dir === 'in' && entry.endpoint === 'e2e');
      assert.ok(signed.length > 0, 'companion emitted at least one signed frame');
      for (const entry of signed) assert.equal(verifyEnvelope(entry, presence.publicKey), true);
      // A key from a different companion must not validate these.
      const stranger = generateSigningKeys().publicKey;
      assert.equal(verifyEnvelope(signed[0]!, stranger), false);

      // A frame claiming another run must not reach that run's journal: the
      // session it arrived on is authoritative, not the ids inside the line.
      await fetch(`${base}/api/sessions/sid-e2e/ingest`, {
        method: 'POST',
        headers: auth,
        body: `${JSON.stringify({
          ...(JSON.parse(envelope('sid-e2e', 99, { spoofed: true })) as ObserverEnvelope),
          runId: 'run-victim',
        })}\n`,
      });
      assert.deepEqual(readJournalLines(dataDir, 'run-victim', 'sid-e2e'), []);

      // Companion death fails the session loudly within the resume window.
      companion.kill('SIGKILL');
      await waitFor(async () => {
        const closed = lines.some((line) => line.includes('resume window'));
        return closed ? true : undefined;
      }, 'loud close after resume window');
    } finally {
      tornDown = true;
      companion?.kill('SIGKILL');
      gateway?.kill('SIGKILL');
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(companionHome, { recursive: true, force: true });
    }
  });

  it('gives up on a gateway that accepts and then says nothing', async () => {
    // Without a deadline this is a command that never returns and never fails.
    const stub = createServer(() => {
      /* accepted, and deliberately never answered */
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const port = (stub.address() as { port: number }).port;
    const home = mkdtempSync(join(tmpdir(), 'symma-companion-home-'));
    let pair: ChildProcess | undefined;
    try {
      const child = (pair = spawn(
        process.execPath,
        [
          '--conditions=symma-source',
          '--import',
          'tsx',
          'packages/companion/src/index.ts',
          'pair',
          'BPB1-9W92-HTZJ-RA19',
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            SYMMA_COMPANION_GATEWAY: `http://127.0.0.1:${port}`,
            SYMMA_COMPANION_AGENTS: `probe=${process.execPath} -e 0`,
            SYMMA_COMPANION_PAIR_TIMEOUT_MS: '300',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ));
      let said = '';
      child.stderr?.on('data', (c) => (said += String(c)));
      // Raced, because "it fails eventually" is not the property: undici's own
      // header timeout ends this after five minutes with no deadline at all,
      // which is the hang the deadline exists to prevent.
      const ended = await within(5_000, new Promise((resolve) => child.on('close', resolve)));
      assert.equal(ended, 1, `expected a prompt refusal, got ${String(ended)} — ${said}`);
      assert.match(said, /Could not reach/);
    } finally {
      pair?.kill('SIGKILL');
      stub.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('says the code is spent when it cannot save what it got', async () => {
    // A directory where the file goes: rename fails, deterministically, after
    // the gateway has already consumed the code.
    const stub = createServer((req, res) => {
      req.resume();
      req.on('end', () =>
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ endpoint: 'e1', token: 't1' })),
      );
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const port = (stub.address() as { port: number }).port;
    const home = mkdtempSync(join(tmpdir(), 'symma-companion-home-'));
    const dir = join(home, '.local', 'share', 'symma-companion');
    mkdirSync(join(dir, 'pairing.json'), { recursive: true });
    try {
      const pair = spawn(
        process.execPath,
        [
          '--conditions=symma-source',
          '--import',
          'tsx',
          'packages/companion/src/index.ts',
          'pair',
          'BPB1-9W92-HTZJ-RA19',
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            SYMMA_COMPANION_GATEWAY: `http://127.0.0.1:${port}`,
            SYMMA_COMPANION_AGENTS: `probe=${process.execPath} -e 0`,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let said = '';
      pair.stderr?.on('data', (c) => (said += String(c)));
      assert.equal(await new Promise((resolve) => pair.on('close', resolve)), 1, said);
      assert.match(said, /could not save it/);
      assert.match(said, /code is spent/);
      // And took the staged file with it, rather than leaving a token under a
      // name nothing will ever read.
      assert.deepEqual(
        readdirSync(dir).filter((entry) => entry.startsWith('pairing.json.')),
        [],
      );
    } finally {
      stub.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('says goodbye on its way out, so a quit is not read as a sleeping laptop', async () => {
    // The distinction only exists because the deliberate exit says so: a kill
    // or a closed lid reaches no handler, which is exactly why hearing it from
    // the ones that can is worth a frame (§3).
    let ingested = '';
    const stub = createServer((req, res) => {
      if (req.url?.endsWith('/stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': open\n\n');
        return;
      }
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (ingested += chunk));
      req.on('end', () => res.writeHead(200).end('{}'));
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const port = (stub.address() as { port: number }).port;
    const home = mkdtempSync(join(tmpdir(), 'symma-companion-home-'));
    let companion: ChildProcess | undefined;
    try {
      companion = spawn(
        process.execPath,
        ['--conditions=symma-source', '--import', 'tsx', 'packages/companion/src/index.ts'],
        {
          env: {
            ...bare(home),
            SYMMA_COMPANION_GATEWAY: `http://127.0.0.1:${port}`,
            SYMMA_COMPANION_TOKEN: 'tok',
            SYMMA_COMPANION_ENDPOINT: 'quitter',
            SYMMA_COMPANION_AGENTS: `probe=${process.execPath} -e 0`,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      await waitFor(
        async () => (ingested.includes('"kind":"hello"') ? true : undefined),
        'the companion attaches',
      );

      // SIGTERM with nothing running — the common quit, and the case that sent
      // nothing at all before this.
      companion.kill('SIGTERM');
      await waitFor(
        async () => (ingested.includes('"kind":"goodbye"') ? true : undefined),
        `a goodbye follows the hello (saw ${ingested})`,
      );
    } finally {
      companion?.kill('SIGKILL');
      stub.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('will not pair a machine with nothing to run', async () => {
    // §2: never attach an endpoint with zero agents. Refused here, before a
    // code is spent, and the reasons are the copy that tells them what to do.
    const home = mkdtempSync(join(tmpdir(), 'symma-companion-home-'));
    try {
      const pair = spawn(
        process.execPath,
        [
          '--conditions=symma-source',
          '--import',
          'tsx',
          'packages/companion/src/index.ts',
          'pair',
          'BPB1-9W92-HTZJ-RA19',
        ],
        { env: bare(home), stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let said = '';
      pair.stdout?.on('data', (c) => (said += String(c)));
      pair.stderr?.on('data', (c) => (said += String(c)));
      assert.equal(await new Promise((resolve) => pair.on('close', resolve)), 1);
      assert.match(said, /Nothing to connect/);
      // Each built-in's reason, so the default list cannot quietly shrink.
      assert.match(said, /kilo: no auth/);
      assert.match(said, /codex: no auth/);
      assert.match(said, /devin: no credentials/);
      assert.match(said, /cursor: CURSOR_API_KEY not set/);
      assert.match(said, /claude: not logged in/);
      assert.match(said, /gemini: not logged in/);
      assert.match(said, /opencode: no auth/);
      // The README's supported-agents list rides the same seven names: pinned
      // here, beside the reasons, so adding an agent updates both or fails.
      const readme = readFileSync(join(import.meta.dirname, '..', '..', '..', 'README.md'), 'utf8');
      for (const name of ['kilo', 'codex', 'devin', 'cursor', 'claude', 'gemini', 'opencode'])
        assert.ok(readme.includes(`\`${name}\``), `README supported-agents lists ${name}`);
      // Nothing persisted at all — not the pairing, and not the signing key,
      // which a refused pair has no use for.
      assert.equal(existsSync(join(home, '.local', 'share', 'symma-companion')), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('takes each field from the file or a variable, and says when it took none', async () => {
    const attaches: { url: string; auth: string }[] = [];
    let ingested = '';
    const stub = createServer((req, res) => {
      if (req.url?.endsWith('/stream')) {
        attaches.push({ url: req.url, auth: String(req.headers.authorization) });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': open\n\n');
        return;
      }
      // The ingest POST streams for the connection's life, so `end` never
      // comes — take the lines as they arrive.
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (ingested += chunk));
      req.on('end', () => res.writeHead(200).end('{}'));
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const port = (stub.address() as { port: number }).port;
    const home = mkdtempSync(join(tmpdir(), 'symma-companion-home-'));
    const homes = [home];
    writePairing(
      home,
      JSON.stringify({
        gateway: `http://127.0.0.1:${port}`,
        endpoint: 'from-file',
        // Padded: a hand-edited file should not send a token with a space in it.
        token: '  file-tok  ',
        device: "Tam's laptop",
      }),
    );
    const start = (from: string, extra: Record<string, string>): ChildProcess =>
      spawn(
        process.execPath,
        ['--conditions=symma-source', '--import', 'tsx', 'packages/companion/src/index.ts'],
        {
          env: {
            ...bare(from),
            SYMMA_COMPANION_AGENTS: `probe=${process.execPath} -e 0`,
            ...extra,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

    let companion: ChildProcess | undefined;
    try {
      // Nothing in the environment: gateway, endpoint and token off the file.
      companion = start(home, {});
      const first = await waitFor(async () => attaches[0], 'attaches from the file alone');
      assert.equal(first.url, '/api/endpoints/from-file/stream');
      assert.equal(first.auth, 'Bearer file-tok');
      // Including the label the member chose while pairing: `hello` has to
      // carry it, or the listing shows a hostname the DM never mentioned.
      await waitFor(
        async () => (ingested.includes('"device":"Tam\'s laptop"') ? true : undefined),
        `hello carries the paired label (saw ${ingested})`,
      );
      companion.kill('SIGKILL');

      // Per field, not all-or-nothing: the variable replaces the endpoint and
      // the token still comes off the file.
      companion = start(home, { SYMMA_COMPANION_ENDPOINT: 'from-env' });
      const second = await waitFor(async () => attaches[1], 'attaches with the override');
      assert.equal(second.url, '/api/endpoints/from-env/stream');
      assert.equal(second.auth, 'Bearer file-tok');
      companion.kill('SIGKILL');

      // A variable holding nothing but a space is not an override. Untrimmed it
      // would win and then come to nothing, and the pairing would read absent.
      companion = start(home, { SYMMA_COMPANION_ENDPOINT: '   ' });
      const third = await waitFor(async () => attaches[2], 'attaches past a blank override');
      assert.equal(third.url, '/api/endpoints/from-file/stream');
      companion.kill('SIGKILL');

      // Half a file is still a file in use: it supplies the gateway and token
      // and leaves the endpoint to a variable, so calling it ignored would be a
      // false alarm on a setup that works.
      const half = mkdtempSync(join(tmpdir(), 'symma-companion-home-'));
      homes.push(half);
      writePairing(
        half,
        JSON.stringify({ gateway: `http://127.0.0.1:${port}`, token: 'half-tok' }),
      );
      companion = start(half, { SYMMA_COMPANION_ENDPOINT: 'from-env-only' });
      let said = '';
      companion.stdout?.on('data', (c) => (said += String(c)));
      const fourth = await waitFor(async () => attaches[3], 'attaches from half a file');
      assert.equal(fourth.url, '/api/endpoints/from-env-only/stream');
      assert.equal(fourth.auth, 'Bearer half-tok');
      assert.doesNotMatch(said, /ignoring/);
    } finally {
      companion?.kill('SIGKILL');
      stub.close();
      for (const dir of homes) rmSync(dir, { recursive: true, force: true });
    }
  });

  // Unparseable, and parseable but useless — a typo'd key reads as valid JSON
  // and contributes nothing, which is the case silence would hide.
  for (const contents of ['{ broken', '{"endPoint":"typo","token":42}']) {
    it(`says how to pair rather than starting on ${contents}`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'symma-companion-home-'));
      writePairing(home, contents);
      try {
        const companion = spawn(
          process.execPath,
          ['--conditions=symma-source', '--import', 'tsx', 'packages/companion/src/index.ts'],
          { env: bare(home), stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let out = '';
        companion.stdout?.on('data', (c) => (out += String(c)));
        companion.stderr?.on('data', (c) => (out += String(c)));
        const code = await new Promise((resolve) => companion.on('close', resolve));
        assert.equal(code, 1);
        assert.match(out, /Not paired\. Run `symma pair <CODE>`/);
        // And says why, so nobody re-pairs against a file that is sitting there.
        assert.match(out, /ignoring .*pairing\.json/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  it('drops a silent stream and keeps a chatty one', async () => {
    // A slept laptop's NAT entry expires without a FIN, so the down leg stays
    // open and mute forever. Nothing in the read loop can notice that — the
    // read simply never resolves. Both halves matter and fail in opposite
    // directions: no timer and a dead connection is held forever, no rearm and
    // a healthy one is dropped on a stopwatch.
    const companionHome = mkdtempSync(join(tmpdir(), 'symma-companion-home-'));
    const streamOpens: number[] = [];
    const held: ServerResponse[] = [];
    let pinger: ReturnType<typeof setInterval> | undefined;
    // Mute on the first attach; on the second it heartbeats faster than the
    // idle budget, which must keep the connection alive indefinitely.
    const stub = createServer((req, res) => {
      if (req.url?.endsWith('/stream')) {
        streamOpens.push(Date.now());
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // One flush so the head reaches the client and the stream is genuinely
        // live; without it `fetch` never resolves and nothing is proven.
        res.write(': open\n\n');
        held.push(res);
        // Mute for the first two attaches, chatty from the third.
        if (streamOpens.length >= 3) {
          pinger = setInterval(() => res.write(': ping\n\n'), 100);
          pinger.unref?.();
        }
        return;
      }
      req.resume();
      req.on('end', () => res.writeHead(200).end('{}'));
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const port = (stub.address() as { port: number }).port;

    let companion: ChildProcess | undefined;
    try {
      companion = spawn(
        process.execPath,
        ['--conditions=symma-source', '--import', 'tsx', 'packages/companion/src/index.ts'],
        {
          env: {
            ...process.env,
            HOME: companionHome,
            SYMMA_COMPANION_GATEWAY: `http://127.0.0.1:${port}`,
            SYMMA_COMPANION_TOKEN: 'tok',
            SYMMA_COMPANION_ENDPOINT: 'mute',
            SYMMA_COMPANION_AGENTS: `probe=${process.execPath} -e 0`,
            SYMMA_COMPANION_IDLE_MS: '300',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let err = '';
      companion.stderr?.on('data', (c) => (err += String(c)));

      // A second attach means the first was abandoned — the stub never closed it.
      await waitFor(
        async () => (streamOpens.length >= 3 ? true : undefined),
        `two reattaches after idle streams (opens=${streamOpens.length}) ${err.slice(-300)}`,
      );
      assert.ok(
        streamOpens[1]! - streamOpens[0]! >= 300,
        'waits out the idle budget rather than flapping',
      );
      // An idle stream ends through the error path, so resetting backoff only on
      // a clean end would double this gap every sleep — a laptop that slept a
      // few times would take 30s to come back. Both gaps are one idle budget
      // plus one minimum backoff; a doubled one would be ~1s longer.
      assert.ok(
        streamOpens[2]! - streamOpens[1]! < 1_800,
        `an attached-then-idle epoch resets backoff (gap=${streamOpens[2]! - streamOpens[1]!}ms)`,
      );

      // Heartbeats are traffic. Wait out several idle budgets AND the 1s
      // reconnect backoff — a shorter window would let a dropped connection be
      // still backing off when the assertion runs, and read as healthy.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      assert.equal(streamOpens.length, 3, 'a heartbeating stream is never dropped');
    } finally {
      clearInterval(pinger);
      companion?.kill('SIGKILL');
      for (const res of held) res.destroy();
      stub.close();
      rmSync(companionHome, { recursive: true, force: true });
    }
  });

  it('says to upgrade when the gateway refuses its generation, and stops hammering', async () => {
    // Nothing this process does fixes a refused protocol version, so the hazard
    // is the shape every other failure has: retry at the minimum backoff. That
    // reconnects every second forever, never recovers, never says why, and
    // keeps a laptop busy doing it. Both halves are the test — the sentence the
    // member can act on, and the silence after it.
    const companionHome = mkdtempSync(join(tmpdir(), 'symma-companion-home-'));
    const streamOpens: number[] = [];
    const held: ServerResponse[] = [];
    const stub = createServer((req, res) => {
      if (req.url?.endsWith('/stream')) {
        streamOpens.push(Date.now());
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': open\n\n');
        held.push(res);
        return;
      }
      // Drained before answering, so the companion reads a status rather than a
      // severed socket — the same order the gateway's own 413 uses.
      req.resume();
      res.writeHead(426, { 'content-type': 'text/plain' });
      res.end('companion too old for this gateway');
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const port = (stub.address() as { port: number }).port;

    let companion: ChildProcess | undefined;
    try {
      companion = spawn(
        process.execPath,
        ['--conditions=symma-source', '--import', 'tsx', 'packages/companion/src/index.ts'],
        {
          env: {
            ...process.env,
            HOME: companionHome,
            SYMMA_COMPANION_GATEWAY: `http://127.0.0.1:${port}`,
            SYMMA_COMPANION_TOKEN: 'tok',
            SYMMA_COMPANION_ENDPOINT: 'stale',
            SYMMA_COMPANION_AGENTS: `probe=${process.execPath} -e 0`,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let said = '';
      companion.stdout?.on('data', (c) => (said += String(c)));

      await waitFor(
        async () => (/upgrade: npm i -g symma/.test(said) ? true : undefined),
        `an upgrade instruction — ${said.slice(-300)}`,
      );
      // An attached-then-dropped epoch comes back in about a second (the idle
      // test above pins that), so a second attach inside this window is the
      // regression: only the maximum backoff keeps it down this long.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      assert.equal(
        streamOpens.length,
        1,
        `a refused generation waits out the long backoff — ${said.slice(-300)}`,
      );
    } finally {
      companion?.kill('SIGKILL');
      for (const res of held) res.destroy();
      stub.close();
      rmSync(companionHome, { recursive: true, force: true });
    }
  });

  it('skips an agent whose binary is missing, and finds one PATH hides', async () => {
    // Detection checked credentials and never the binary, so an agent could
    // report ready and then ENOENT at spawn — past onboarding, on first use.
    // The second half is why a plain PATH walk is not enough: a login service
    // gets a minimal PATH, and the binary lives where the login shell says.
    const bin = mkdtempSync(join(tmpdir(), 'symma-bin-'));
    const shim = join(bin, 'ghost-agent');
    writeFileSync(shim, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const fakeShell = join(bin, 'fake-login-shell');
    // Stands in for the user's shell: answers `command -v` from a PATH the
    // companion's own environment does not have.
    // Invoked as `<shell> -lic <script> <argv0> <name>`, so the name is $4 here;
    // inside a real shell's -c script that same name arrives as "$1".
    writeFileSync(fakeShell, `#!/bin/sh\n[ "$4" = ghost-agent ] && echo ${shim}\n`, {
      mode: 0o755,
    });

    // Resolution is logged before the first dial, so read until the outcome is
    // decided rather than waiting out a companion that reconnects forever.
    const run = async (agents: string, env: Record<string, string> = {}): Promise<string> => {
      const child = spawn(
        process.execPath,
        ['--conditions=symma-source', '--import', 'tsx', 'packages/companion/src/index.ts'],
        {
          env: {
            ...process.env,
            HOME: bin,
            PATH: '/usr/bin:/bin',
            SYMMA_COMPANION_GATEWAY: 'http://127.0.0.1:1',
            SYMMA_COMPANION_TOKEN: 'tok',
            SYMMA_COMPANION_ENDPOINT: 'probe',
            SYMMA_COMPANION_AGENTS: agents,
            ...env,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let out = '';
      try {
        await new Promise<void>((resolve) => {
          // Only terminal signals settle this: with no usable agent the
          // companion exits on its own, and `connect failed` means one resolved
          // and it went looking for the gateway. Matching the skip line instead
          // would race the very next line it prints.
          const settle = (chunk: unknown): void => {
            out += String(chunk);
            if (out.includes('connect failed')) resolve();
          };
          child.stdout?.on('data', settle);
          child.stderr?.on('data', settle);
          child.on('close', () => resolve());
        });
      } finally {
        child.kill('SIGKILL');
      }
      return out;
    };

    // No such binary anywhere: skipped with a reason, and with nothing left the
    // companion refuses to attach rather than offering an agent it cannot run.
    const missing = await run(`ghost=ghost-agent`, { SHELL: '' });
    assert.match(missing, /ghost-agent not found on PATH/);
    assert.match(missing, /No usable agents/);

    // Same PATH, but now the login shell knows where it lives.
    const found = await run(`ghost=ghost-agent`, { SHELL: fakeShell });
    assert.doesNotMatch(found, /not found on PATH/);
    assert.doesNotMatch(found, /No usable agents/);

    rmSync(bin, { recursive: true, force: true });
  });
});
