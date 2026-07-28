import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { HelloControl, OpenControl } from '@symma/protocol';

import { createRelay, parseEndpointTokens } from '../src/relay.js';

const hello = (overrides: Partial<HelloControl> = {}): HelloControl => ({
  kind: 'hello',
  endpoint: 'laptop',
  device: 'macbook',
  agents: [{ agent: 'kilo' }],
  maxSessions: 2,
  ...overrides,
});

const open = (overrides: Partial<OpenControl> = {}): OpenControl => ({
  kind: 'open',
  sessionId: 'sid-1',
  runId: 'run-1',
  endpoint: 'laptop',
  agent: 'kilo',
  ...overrides,
});

describe('relay', () => {
  it('parses endpoint token config and drops malformed entries', () => {
    const tokens = parseEndpointTokens(' laptop:tok1, vps:tok2 ,bad entry,:x,noid');
    assert.deepEqual(
      [...tokens.entries()],
      [
        ['laptop', 'tok1'],
        ['vps', 'tok2'],
      ],
    );
    assert.equal(parseEndpointTokens(undefined).size, 0);
  });

  it('pairs sessions, relays both directions, and journals via onLine', () => {
    const journal: string[] = [];
    const relay = createRelay({
      onLine: (sid, run, dir, line) => journal.push(`${sid}/${run}/${dir}/${line}`),
    });
    const toEndpoint: string[] = [];
    const toClient: string[] = [];
    relay.attachEndpoint(hello(), (line) => toEndpoint.push(line));
    relay.openSession(open(), (line) => toClient.push(line));
    assert.equal(JSON.parse(toEndpoint[0]).kind, 'open');
    relay.clientLine('sid-1', 'frame-out');
    relay.endpointLine('laptop', 'sid-1', 'frame-in');
    assert.equal(toEndpoint[1], 'frame-out');
    assert.equal(toClient[0], 'frame-in');
    assert.deepEqual(journal, ['sid-1/run-1/out/frame-out', 'sid-1/run-1/in/frame-in']);
    assert.equal(relay.sessionRun('sid-1'), 'run-1');
    // Unknown sessions are dropped, never crash.
    relay.clientLine('ghost', 'x');
    relay.endpointLine('laptop', 'ghost', 'x');
  });

  it('rejects cross-endpoint frames, acks, and closes (sender must own the session)', () => {
    const relay = createRelay();
    const toClient: string[] = [];
    relay.attachEndpoint(hello({ endpoint: 'mine' }), () => {});
    relay.attachEndpoint(hello({ endpoint: 'attacker' }), () => {});
    relay.openSession(open({ endpoint: 'mine' }), (line) => toClient.push(line));
    // A frame/ack/close from the wrong endpoint reaches nothing.
    relay.endpointLine('attacker', 'sid-1', 'injected');
    relay.endpointAck('attacker', { kind: 'refused', sessionId: 'sid-1' }, 'spoof');
    relay.endpointClose('attacker', 'sid-1', 'hijack');
    assert.deepEqual(toClient, []);
    assert.equal(relay.sessionRun('sid-1'), 'run-1');
    // The owning endpoint still works.
    relay.endpointLine('mine', 'sid-1', 'legit');
    assert.deepEqual(toClient, ['legit']);
  });

  it('refuses offline endpoints, duplicates, capacity, and unknown agents', () => {
    const relay = createRelay();
    const refusals: string[] = [];
    const client = (line: string): void => {
      const control = JSON.parse(line) as { kind: string; reason?: string; code?: string };
      if (control.kind === 'refused') refusals.push(`${control.code}: ${control.reason}`);
    };
    relay.openSession(open(), client);
    relay.attachEndpoint(hello({ maxSessions: 1 }), () => {});
    relay.openSession(open({ agent: 'ghost' }), client);
    relay.openSession(open(), client);
    relay.openSession(open({ sessionId: 'sid-1' }), client); // duplicate
    relay.openSession(open({ sessionId: 'sid-2' }), client); // over capacity
    // The code is what a caller branches on — `offline` and `at_capacity` are
    // worth retrying, the other two are its own bug or config.
    assert.deepEqual(refusals, [
      'offline: endpoint offline',
      'no_such_agent: agent ghost not offered',
      'session_in_use: session id in use',
      'at_capacity: at capacity',
    ]);
    // A companion refusal frees the slot for the next open.
    const ack = { kind: 'refused' as const, sessionId: 'sid-1', reason: 'no auth' };
    relay.endpointAck('laptop', ack, JSON.stringify(ack));
    relay.openSession(open({ sessionId: 'sid-3' }), client);
    assert.equal(relay.sessionRun('sid-3'), 'run-1');
  });

  it('refuses opens against a detached endpoint until it reattaches', () => {
    const relay = createRelay();
    const refusals: string[] = [];
    const client = (line: string): void => {
      const c = JSON.parse(line) as { kind: string; reason?: string };
      if (c.kind === 'refused') refusals.push(c.reason ?? '');
    };
    relay.attachEndpoint(hello(), () => {});
    relay.detachEndpoint('laptop');
    relay.openSession(open(), client);
    assert.deepEqual(refusals, ['endpoint offline']);
    // Reattach clears the offline state.
    relay.attachEndpoint(hello(), () => {});
    relay.openSession(open({ sessionId: 'sid-9' }), client);
    assert.equal(relay.sessionRun('sid-9'), 'run-1');
  });

  it('resumes declared sessions on reattach and fails undeclared zombies', () => {
    const failed: string[] = [];
    const relay = createRelay({ onSessionFailed: (sid) => failed.push(sid) });
    relay.attachEndpoint(hello(), () => {});
    relay.openSession(open({ sessionId: 'live' }), () => {});
    relay.openSession(open({ sessionId: 'zombie' }), () => {});
    relay.detachEndpoint('laptop');
    // A restarted companion re-declares only the session it still holds.
    relay.attachEndpoint(hello({ sessions: ['live'] }), () => {});
    assert.deepEqual(failed, ['zombie']);
    assert.equal(relay.sessionRun('live'), 'run-1');
    assert.equal(relay.sessionRun('zombie'), undefined);
  });

  it('tells a reconnecting companion to close sessions the relay already ended', () => {
    const relay = createRelay();
    relay.attachEndpoint(hello(), () => {});
    relay.openSession(open(), () => {});
    relay.closeSession('sid-1', 'resume window elapsed'); // relay drops it
    const sent: string[] = [];
    // The companion reconnects still holding the agent for sid-1.
    relay.attachEndpoint(hello({ sessions: ['sid-1'] }), (line) => sent.push(line));
    const closes = sent
      .map((line) => JSON.parse(line) as { kind: string; sessionId: string })
      .filter((c) => c.kind === 'close' && c.sessionId === 'sid-1');
    assert.equal(closes.length, 1);
  });

  it('fails sessions loudly past the resume window; reattach cancels', async () => {
    const failed: string[] = [];
    const relay = createRelay({
      resumeWindowMs: 30,
      onSessionFailed: (sid, reason) => failed.push(`${sid}:${reason}`),
    });
    const toClient: string[] = [];
    relay.attachEndpoint(hello(), () => {});
    relay.openSession(open(), (line) => toClient.push(line));
    relay.openSession(open({ sessionId: 'sid-2' }), () => {});

    relay.detachEndpoint('laptop');
    relay.attachEndpoint(hello(), () => {}); // sid survives: reattach in window
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(failed, []);

    relay.detachEndpoint('laptop');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(failed.length, 2);
    assert.match(failed[0], /resume window/);
    assert.equal(JSON.parse(toClient.at(-1)!).kind, 'close');
    assert.equal(relay.sessionRun('sid-1'), undefined);
  });

  it('gives the client leg its own resume window; reattach within it survives', async () => {
    const failed: string[] = [];
    const relay = createRelay({ resumeWindowMs: 40, onSessionFailed: (sid) => failed.push(sid) });
    relay.attachEndpoint(hello(), () => {});
    relay.openSession(open(), () => {});

    // A client blip that reconnects within the window must not fail the session.
    relay.detachClient('sid-1');
    relay.attachClient('sid-1');
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.deepEqual(failed, []);
    assert.equal(relay.sessionRun('sid-1'), 'run-1');

    // A client gone past the window fails it.
    relay.detachClient('sid-1');
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.deepEqual(failed, ['sid-1']);
  });
});
