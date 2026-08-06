import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { readJournalLines } from '@symma/gateway';

import { checkEndpointReady, runRemotePrompt } from '../src/remote.js';

const noLog = (): void => undefined;

// Answers the ACP handshake and returns a review payload, so the transport is
// exercised over the real gateway + companion rather than a stub stream pair.
const REVIEW_AGENT = `
let buf = '';
let mode = 'read-only';
process.stdin.setEncoding('utf8');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const REVIEW = () => JSON.stringify({
  summary: 'remote review ok',
  cwd: process.cwd(),
  mode,
  findings: [{ path: 'src/a.ts', line: 1, severity: 'P2', title: 'remote finding', body: 'b' }],
  addressedPriorComments: [],
});
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    if (m.method === 'session/new') out({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'a1', modes: { currentModeId: 'read-only', availableModes: [{ id: 'read-only' }, { id: 'agent', name: 'Agent' }] } } });
    else if (m.method === 'session/set_mode') { mode = m.params.modeId; out({ jsonrpc: '2.0', id: m.id, result: {} }); }
    else if (m.method === 'session/prompt') {
      out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'a1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REVIEW() } } } });
      out({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
    } else out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
  }
});
`;

async function waitFor<T>(probe: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('remote acp prompt', () => {
  it('runs a prompt through gateway + companion and journals the session', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'symma-remote-'));
    // The companion writes a signing key under HOME on startup; give it a
    // throwaway one, or the suite leaves real key material in the developer's
    // own ~/.local/share and reuses it across runs.
    const companionHome = mkdtempSync(join(tmpdir(), 'symma-companion-home-'));
    const agentPath = join(dataDir, 'review-agent.mjs');
    writeFileSync(agentPath, REVIEW_AGENT);
    // A root the companion will allowlist, so this test can ask for it by id.
    const mine = mkdtempSync(join(tmpdir(), 'symma-remote-mine-'));
    const port = 24000 + Math.floor(Math.random() * 2000);
    const base = `http://127.0.0.1:${port}`;
    let gateway: ChildProcess | undefined;
    let companion: ChildProcess | undefined;
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
            SYMMA_GATEWAY_ENDPOINTS: 'box:endpoint-tok',
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
      companion = spawn(
        process.execPath,
        ['--conditions=symma-source', '--import', 'tsx', 'packages/companion/src/index.ts'],
        {
          env: {
            ...process.env,
            HOME: companionHome,
            SYMMA_COMPANION_GATEWAY: base,
            SYMMA_COMPANION_TOKEN: 'endpoint-tok',
            SYMMA_COMPANION_ENDPOINT: 'box',
            SYMMA_COMPANION_AGENTS: `probe=${process.execPath} ${agentPath}`,
            SYMMA_COMPANION_WORKSPACES: mine,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      await waitFor(async () => {
        const listed = (await (
          await fetch(`${base}/api/endpoints`, { headers: { authorization: 'Bearer client-tok' } })
        ).json()) as { endpoint: string; online: boolean }[];
        return listed.find((entry) => entry.endpoint === 'box' && entry.online);
      }, 'endpoint presence');

      // Preflight: ready for the offered agent, loud for anything it can't serve.
      const config = { gateway: base, token: 'client-tok', endpoint: 'box', runId: 'run-remote' };
      assert.equal((await checkEndpointReady(config, 'probe')).freeSessions, 2, 'idle: all free');
      await assert.rejects(() => checkEndpointReady(config, 'kilo'), /does not offer agent "kilo"/);
      await assert.rejects(
        () => checkEndpointReady({ ...config, endpoint: 'ghost' }, 'probe'),
        /is offline/,
      );
      await assert.rejects(
        () => checkEndpointReady({ ...config, token: 'wrong' }, 'probe'),
        /rejected the endpoint listing/,
      );

      // Drives the transport itself: the agent's final message must come back
      // verbatim. Parsing it into findings is the reviewer's job, not this one's.
      const text = await runRemotePrompt(
        { ...config, agent: 'probe' },
        'probe/default',
        'PR CONTEXT',
        'review',
        noLog,
      );
      assert.match(text, /remote review ok/);
      // No workspace asked for, so the agent got the empty temp directory the
      // review path has always had. Parsed rather than matched: a path is not a
      // regex, and `\` on win32 would make one that is not the path.
      const ranIn = (payload: string): string => (JSON.parse(payload) as { cwd: string }).cwd;
      assert.notEqual(ranIn(text), realpathSync(mine));

      // Named by id, the same prompt runs in the member's own directory. This
      // is the whole of what `workspace` buys, and the agent reporting its own
      // cwd is the only thing that can show it.
      const offered = (await (
        await fetch(`${base}/api/endpoints`, { headers: { authorization: 'Bearer client-tok' } })
      ).json()) as { endpoint: string; workspaces?: { id: string }[] }[];
      const id = offered.find((e) => e.endpoint === 'box')!.workspaces![0]!.id;
      const inMine = await runRemotePrompt(
        { ...config, agent: 'probe', runId: 'run-in-mine', workspace: id },
        'probe/default',
        'PR CONTEXT',
        'review',
        noLog,
      );
      assert.equal(ranIn(inMine), realpathSync(mine));

      // The member's pick travels the same wire: the open carries it, the
      // driver sets it on the session, and the roster comes back for whoever
      // renders the picker.
      let roster: unknown;
      const moded = await runRemotePrompt(
        {
          ...config,
          agent: 'probe',
          runId: 'run-moded',
          workspace: id,
          mode: 'agent',
          onModes: (modes) => (roster = modes),
        },
        'probe/default',
        'PR CONTEXT',
        'review',
        noLog,
      );
      assert.equal((JSON.parse(moded) as { mode: string }).mode, 'agent');
      assert.deepEqual(roster, {
        currentModeId: 'agent',
        availableModes: [{ id: 'read-only' }, { id: 'agent', name: 'Agent' }],
      });

      // The reply above already proves the round trip; what only this test
      // covers is that it was journaled under the client's run id, one session
      // per prompt, with the client's own frames marked outbound.
      const runDir = (await (await fetch(`${base}/api/runs?token=client-tok`)).json()) as {
        runId: string;
        sessions: string[];
      }[];
      const run = runDir.find((entry) => entry.runId === 'run-remote');
      assert.ok(run && run.sessions.length === 1, 'one journaled session for the prompt');
      const lines = readJournalLines(dataDir, 'run-remote', run!.sessions[0]).map(
        (line) => JSON.parse(line) as { dir: string; frame: { method?: string } },
      );
      assert.ok(lines.some((l) => l.dir === 'out' && l.frame.method === 'session/prompt'));
    } finally {
      companion?.kill('SIGKILL');
      gateway?.kill('SIGKILL');
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(companionHome, { recursive: true, force: true });
      rmSync(mine, { recursive: true, force: true });
    }
  });
});
