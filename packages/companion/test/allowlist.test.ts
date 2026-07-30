import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { AckControl, EndpointPresence } from '@symma/protocol';

import { bare, waitFor } from './helpers.js';

/** Writes where it was started, then stays up so the session does. The cwd is
 * the whole assertion: nothing else can show which directory won. */
const AGENT = `import { writeFileSync } from 'node:fs';
writeFileSync('ran-here.txt', process.cwd());
process.stdin.resume();
`;

let gateway: ChildProcess | undefined;
let companion: ChildProcess | undefined;
let base: string;
let home: string;
let dataDir: string;
/** Stands in for the member's checkout: real work, in a directory symma did
 * not create and must never remove. */
let mine: string;
let auth: { authorization: string };

/** Every response body is drained: an unread one holds its socket open, and a
 * held socket keeps this process alive past the last assertion. */
async function open(body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${base}/api/sessions/${String(body.sessionId)}/ingest`, {
    method: 'POST',
    headers: auth,
    body: `${JSON.stringify({ kind: 'open', runId: 'run-ws', endpoint: 'ws', agent: 'probe', ...body })}\n`,
  });
  await res.body?.cancel();
}

/** The `opened` or `refused` control for one open, read off its own client leg. */
async function controlFor(
  kind: 'opened' | 'refused',
  body: Record<string, unknown>,
): Promise<AckControl> {
  const stream = await fetch(
    `${base}/api/sessions/${String(body.sessionId)}/stream?token=client-tok`,
  );
  const reader = stream.body!.getReader();
  const lines: string[] = [];
  void (async () => {
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
  })().catch(() => undefined);
  try {
    await open(body);
    return await waitFor(
      async () =>
        lines
          .map((line) => JSON.parse(line) as AckControl)
          .find((control) => control.kind === kind),
      `${kind} for ${String(body.sessionId)}`,
    );
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'symma-ws-home-'));
  dataDir = mkdtempSync(join(tmpdir(), 'symma-ws-data-'));
  mine = mkdtempSync(join(tmpdir(), 'symma-ws-mine-'));
  writeFileSync(join(mine, 'source.txt'), 'the work they asked about');
  const agentPath = join(dataDir, 'probe-agent.mjs');
  writeFileSync(agentPath, AGENT);

  const port = 24000 + Math.floor(Math.random() * 2000);
  base = `http://127.0.0.1:${port}`;
  auth = { authorization: 'Bearer client-tok' };
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
        SYMMA_GATEWAY_ENDPOINTS: 'ws:endpoint-tok',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  gateway.stdout?.resume();
  gateway.stderr?.resume();
  await waitFor(async () => {
    const res = await fetch(`${base}/healthz`);
    await res.body?.cancel();
    return res.ok ? true : undefined;
  }, 'gateway up');

  companion = spawn(
    process.execPath,
    ['--conditions=symma-source', '--import', 'tsx', 'packages/companion/src/index.ts'],
    {
      env: {
        ...bare(home),
        SYMMA_COMPANION_GATEWAY: base,
        SYMMA_COMPANION_TOKEN: 'endpoint-tok',
        SYMMA_COMPANION_ENDPOINT: 'ws',
        SYMMA_COMPANION_DEVICE: 'test-box',
        SYMMA_COMPANION_AGENTS: `probe=${process.execPath} ${agentPath}`,
        // One real directory and one that is not there, so the skip is covered
        // by the same boot as the advertisement.
        SYMMA_COMPANION_WORKSPACES: `${mine}, /nowhere/at/all`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  companion.stdout?.resume();
  companion.stderr?.resume();
});

after(() => {
  companion?.kill('SIGKILL');
  gateway?.kill('SIGKILL');
  for (const dir of [home, dataDir, mine]) rmSync(dir, { recursive: true, force: true });
});

describe('workspace allowlist', () => {
  it('advertises an opaque id per root, and nothing that is not a directory', async () => {
    const presence = await waitFor(async () => {
      const listed = (await (
        await fetch(`${base}/api/endpoints`, { headers: auth })
      ).json()) as EndpointPresence[];
      return listed.find((entry) => entry.endpoint === 'ws');
    }, 'endpoint presence');

    assert.equal(presence.workspaces?.length, 1, 'the missing directory was skipped, not offered');
    const [only] = presence.workspaces!;
    // §4: ids cross the wire, paths do not. A label is for a member choosing
    // between them, and the machine is already theirs.
    assert.doesNotMatch(only!.id, /[/\\]/, 'the id is not a path');
    assert.equal(only!.id.includes(mine), false);
    assert.equal(only!.label, mine.split('/').pop());
  });

  it('refuses a workspace it never advertised, and a repo on top of one', async () => {
    const presence = (
      (await (await fetch(`${base}/api/endpoints`, { headers: auth })).json()) as EndpointPresence[]
    ).find((entry) => entry.endpoint === 'ws')!;

    // An id nobody offered is refused rather than resolved — the allowlist is
    // the boundary, so there is nothing to fall back to.
    const unknown = await controlFor('refused', {
      sessionId: 'sid-unknown',
      workspace: 'deadbeefdead',
    });
    assert.equal(unknown.code, 'no_such_workspace');

    // And a review checkout must not be cloned on top of someone's working
    // tree; the loser of that would be their uncommitted work.
    const both = await controlFor('refused', {
      sessionId: 'sid-both',
      workspace: presence.workspaces![0]!.id,
      repo: 'https://example.invalid/repo.git',
    });
    assert.match(both.reason ?? '', /cannot both be given/);
  });

  // Last, because proving the shutdown path means ending the companion.
  it('runs in the allowlisted root, and does not delete it on the way out', async () => {
    const presence = (
      (await (await fetch(`${base}/api/endpoints`, { headers: auth })).json()) as EndpointPresence[]
    ).find((entry) => entry.endpoint === 'ws')!;

    const opened = await controlFor('opened', {
      sessionId: 'sid-in-mine',
      workspace: presence.workspaces![0]!.id,
    });
    // The ack carries the checkout path for a repo the companion cloned. An
    // allowlisted root is the member's own, so keeping ids off the wire is
    // undone if the path goes back on it in the reply.
    assert.equal(opened.workspace, undefined, 'no local path came back with the ack');

    // The agent wrote its own cwd, so this is the directory that actually won —
    // not a temp one that happens to look right. Compared through `realpathSync`
    // because macOS hands back `/var` and a child reports `/private/var`.
    await waitFor(
      async () => (existsSync(join(mine, 'ran-here.txt')) ? true : undefined),
      'the agent started inside the allowlisted root',
    );
    assert.equal(readFileSync(join(mine, 'ran-here.txt'), 'utf8'), realpathSync(mine));

    // The dangerous half. `discard` is an `rmSync(recursive, force)` reached
    // from seven places, and a shutdown runs it for every live session — so
    // this is the member's checkout being deleted if ownership is not tracked.
    // Registered before the signal so the ordering needs no reasoning about.
    const closed = new Promise((resolve) => companion?.once('close', resolve));
    companion?.kill('SIGTERM');
    await closed;
    assert.equal(existsSync(mine), true, 'the root itself survived');
    assert.equal(readFileSync(join(mine, 'source.txt'), 'utf8'), 'the work they asked about');
  });
});
