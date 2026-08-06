import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { EndpointPresence } from '@symma/protocol';

import { bare, waitFor } from './helpers.js';

const AGENT = `process.stdin.resume();
`;

let gateway: ChildProcess | undefined;
let base: string;
let home: string;
let dataDir: string;
let mine: string;
let other: string;
let agentPath: string;
let file: string;
const auth = { authorization: 'Bearer client-tok' };

const endpointNow = async (): Promise<EndpointPresence | undefined> => {
  const listed = (await (
    await fetch(`${base}/api/endpoints`, { headers: auth })
  ).json()) as EndpointPresence[];
  return listed.find((entry) => entry.endpoint === 'persist');
};

const advertises = (count: number): Promise<EndpointPresence> =>
  waitFor(
    async () => {
      const seen = await endpointNow();
      return seen?.online && (seen.workspaces?.length ?? 0) === count ? seen : undefined;
    },
    `online with ${String(count)} workspaces`,
  );

const offline = (): Promise<true> =>
  waitFor(async () => {
    const seen = await endpointNow();
    return seen && !seen.online ? true : undefined;
  }, 'endpoint offline');

/** Boots a companion; no `workspacesVar` is the login-service shape — a unit
 * that carries no environment at all. */
function boot(workspacesVar?: string): ChildProcess {
  const child = spawn(
    process.execPath,
    ['--conditions=symma-source', '--import', 'tsx', 'packages/companion/src/index.ts'],
    {
      env: {
        ...bare(home),
        SYMMA_COMPANION_GATEWAY: base,
        SYMMA_COMPANION_TOKEN: 'endpoint-tok',
        SYMMA_COMPANION_ENDPOINT: 'persist',
        SYMMA_COMPANION_AGENTS: `probe=${process.execPath} ${agentPath}`,
        ...(workspacesVar === undefined ? {} : { SYMMA_COMPANION_WORKSPACES: workspacesVar }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'symma-persist-home-'));
  dataDir = mkdtempSync(join(tmpdir(), 'symma-persist-data-'));
  mine = mkdtempSync(join(tmpdir(), 'symma-persist-mine-'));
  other = mkdtempSync(join(tmpdir(), 'symma-persist-other-'));
  agentPath = join(dataDir, 'probe-agent.mjs');
  writeFileSync(agentPath, AGENT);
  file = join(home, '.local', 'share', 'symma-companion', 'workspaces.json');

  const port = 25000 + Math.floor(Math.random() * 2000);
  base = `http://127.0.0.1:${port}`;
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
        SYMMA_GATEWAY_ENDPOINTS: 'persist:endpoint-tok',
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
});

after(() => {
  gateway?.kill('SIGKILL');
  for (const dir of [home, dataDir, mine, other]) rmSync(dir, { recursive: true, force: true });
});

describe('workspace persistence', () => {
  it('keeps the allowlist across a restart that carries no environment', async () => {
    let companion = boot(`${mine},${other}`);
    try {
      const first = await advertises(2);
      assert.deepEqual(
        first.workspaces!.map((w) => w.label).sort(),
        [basename(mine), basename(other)].sort(),
      );
      // The copy the next boot will read: the member's entries, resolved.
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { workspaces: [mine, other] });

      companion.kill('SIGKILL');
      await offline();

      // The login-service shape: no variable at all. Without the copy this
      // boot advertises nothing, silently — the failure this file pins.
      companion = boot();
      const second = await advertises(2);
      assert.deepEqual(
        second.workspaces!.map((w) => w.id).sort(),
        first.workspaces!.map((w) => w.id).sort(),
        'ids survive too, so a pinned conversation still names its root',
      );

      companion.kill('SIGKILL');
      await offline();

      // The variable stays authoritative when present: it narrows the list
      // and rewrites the copy.
      companion = boot(mine);
      await advertises(1);
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { workspaces: [mine] });
    } finally {
      companion.kill('SIGKILL');
    }
  });

  it('boots past a corrupt copy rather than dying at module scope', async () => {
    // The previous test's kill has to land first, or the poll below reads the
    // dying companion's presence as this boot's.
    await offline();
    writeFileSync(file, 'not json');
    const companion = boot();
    try {
      // Online with nothing advertised: the file was ignored with a log line,
      // not allowed to throw before the companion could attach at all.
      const seen = await waitFor(async () => {
        const now = await endpointNow();
        return now?.online ? now : undefined;
      }, 'online past the corrupt file');
      assert.equal(seen.workspaces, undefined);
    } finally {
      companion.kill('SIGKILL');
      await offline();
    }
  });
});
