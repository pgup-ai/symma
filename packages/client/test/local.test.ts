import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { AcpAgentSpec } from '@symma/protocol';

import { runLocalAcpPrompt } from '../src/local.ts';

const noLog = (): void => undefined;

// Answers the ACP handshake over stdio, so the spawn/drive/teardown path is
// exercised against a real child rather than a stubbed stream pair.
const AGENT = `
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
    if (m.id === undefined) continue;
    if (m.method === 'session/new') out({ jsonrpc: '2.0', id: m.id, result: { sessionId: 's1' } });
    else if (m.method === 'session/prompt') {
      out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'local ok' } } } });
      out({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
    } else out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
  }
});
`;

describe('runLocalAcpPrompt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symma-local-'));
  const script = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };
  /** Records whether teardown ran, which the caller relies on to reclaim the
   * temp home an agent spec materializes. */
  const specFor = (path: string): { spec: AcpAgentSpec; cleanedUp: () => boolean } => {
    let cleaned = false;
    return {
      spec: {
        id: 'probe',
        bin: process.execPath,
        args: () => [path],
        env: () => ({ env: { ...process.env }, cleanup: () => (cleaned = true) }),
      },
      cleanedUp: () => cleaned,
    };
  };

  it('drives a prompt to its final message and tears the agent down', async () => {
    const { spec, cleanedUp } = specFor(script('ok.mjs', AGENT));
    const text = await runLocalAcpPrompt(
      spec,
      dir,
      'probe/default',
      'review this',
      'review',
      noLog,
    );
    assert.equal(text, 'local ok');
    assert.ok(cleanedUp(), 'temp home reclaimed');
  });

  it('fails with the agent stderr when it exits before responding', async () => {
    const { spec, cleanedUp } = specFor(
      script('crash.mjs', `process.stderr.write('auth expired\\n'); process.exit(3);`),
    );
    await assert.rejects(
      runLocalAcpPrompt(spec, dir, 'probe/default', 'p', 'review', noLog),
      /exited 3 before responding.*auth expired/s,
    );
    assert.ok(cleanedUp(), 'temp home reclaimed on the failure path too');
  });

  it('gives up on a wedged agent at the deadline', async () => {
    // Never reads stdin, never answers: only the wall clock ends this.
    const { spec } = specFor(script('wedged.mjs', `setInterval(() => {}, 1000);`));
    await assert.rejects(
      runLocalAcpPrompt(spec, dir, 'probe/default', 'p', 'review', noLog, 250),
      /prompt timed out/,
    );
  });

  after(() => rmSync(dir, { recursive: true, force: true }));
});
