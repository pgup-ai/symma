import assert from 'node:assert/strict';
import { generateSigningKeys, verifyEnvelope, type ObserverEnvelope } from '@symma/protocol';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
        if (streamOpens.length >= 2) {
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
        async () => (streamOpens.length >= 2 ? true : undefined),
        `reattach after an idle stream (opens=${streamOpens.length}) ${err.slice(-300)}`,
      );
      assert.ok(
        streamOpens[1]! - streamOpens[0]! >= 300,
        'waits out the idle budget rather than flapping',
      );

      // Heartbeats are traffic. Wait out several idle budgets AND the 1s
      // reconnect backoff — a shorter window would let a dropped connection be
      // still backing off when the assertion runs, and read as healthy.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      assert.equal(streamOpens.length, 2, 'a heartbeating stream is never dropped');
    } finally {
      clearInterval(pinger);
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
