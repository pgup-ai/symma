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

const OWNER = 'u-acme-alice';

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
    relay.attachEndpoint(hello(), (line) => toEndpoint.push(line), OWNER);
    relay.openSession(open(), (line) => toClient.push(line), OWNER);
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
    relay.attachEndpoint(hello({ endpoint: 'mine' }), () => {}, OWNER);
    relay.attachEndpoint(hello({ endpoint: 'attacker' }), () => {}, OWNER);
    relay.openSession(open({ endpoint: 'mine' }), (line) => toClient.push(line), OWNER);
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
    relay.openSession(open(), client, OWNER);
    relay.attachEndpoint(hello({ maxSessions: 1 }), () => {}, OWNER);
    relay.openSession(open({ agent: 'ghost' }), client, OWNER);
    relay.openSession(open(), client, OWNER);
    relay.openSession(open({ sessionId: 'sid-1' }), client, OWNER); // duplicate
    relay.openSession(open({ sessionId: 'sid-2' }), client, OWNER); // over capacity
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
    relay.openSession(open({ sessionId: 'sid-3' }), client, OWNER);
    assert.equal(relay.sessionRun('sid-3'), 'run-1');
  });

  it('refuses opens against a detached endpoint until it reattaches', () => {
    const relay = createRelay();
    const refusals: string[] = [];
    const client = (line: string): void => {
      const c = JSON.parse(line) as { kind: string; reason?: string };
      if (c.kind === 'refused') refusals.push(c.reason ?? '');
    };
    relay.attachEndpoint(hello(), () => {}, OWNER);
    relay.detachEndpoint('laptop');
    relay.openSession(open(), client, OWNER);
    assert.deepEqual(refusals, ['endpoint offline']);
    // Reattach clears the offline state.
    relay.attachEndpoint(hello(), () => {}, OWNER);
    relay.openSession(open({ sessionId: 'sid-9' }), client, OWNER);
    assert.equal(relay.sessionRun('sid-9'), 'run-1');
  });

  it('resumes declared sessions on reattach and fails undeclared zombies', () => {
    const failed: string[] = [];
    const relay = createRelay({ onSessionFailed: (sid) => failed.push(sid) });
    relay.attachEndpoint(hello(), () => {}, OWNER);
    relay.openSession(open({ sessionId: 'live' }), () => {}, OWNER);
    relay.openSession(open({ sessionId: 'zombie' }), () => {}, OWNER);
    relay.detachEndpoint('laptop');
    // A restarted companion re-declares only the session it still holds.
    relay.attachEndpoint(hello({ sessions: ['live'] }), () => {}, OWNER);
    assert.deepEqual(failed, ['zombie']);
    assert.equal(relay.sessionRun('live'), 'run-1');
    assert.equal(relay.sessionRun('zombie'), undefined);
  });

  it('tells a reconnecting companion to close sessions the relay already ended', () => {
    const relay = createRelay();
    relay.attachEndpoint(hello(), () => {}, OWNER);
    relay.openSession(open(), () => {}, OWNER);
    relay.closeSession('sid-1', 'resume window elapsed'); // relay drops it
    const sent: string[] = [];
    // The companion reconnects still holding the agent for sid-1.
    relay.attachEndpoint(hello({ sessions: ['sid-1'] }), (line) => sent.push(line), OWNER);
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
    relay.attachEndpoint(hello(), () => {}, OWNER);
    relay.openSession(open(), (line) => toClient.push(line), OWNER);
    relay.openSession(open({ sessionId: 'sid-2' }), () => {}, OWNER);

    relay.detachEndpoint('laptop');
    relay.attachEndpoint(hello(), () => {}, OWNER); // sid survives: reattach in window
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
    relay.attachEndpoint(hello(), () => {}, OWNER);
    relay.openSession(open(), () => {}, OWNER);

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

  it('forwards a companion refusal code untouched', () => {
    // The relay does not author these — the companion does, and the ack is
    // relayed verbatim — so the code has to survive the trip.
    const relay = createRelay();
    const toClient: string[] = [];
    relay.attachEndpoint(hello(), () => {}, OWNER);
    relay.openSession(open(), (line) => toClient.push(line), OWNER);
    const ack = {
      kind: 'refused' as const,
      sessionId: 'sid-1',
      code: 'no_such_agent' as const,
      reason: 'agent kilo not offered',
    };
    relay.endpointAck('laptop', ack, JSON.stringify(ack));
    assert.deepEqual(JSON.parse(toClient.at(-1)!), ack);
  });

  it('tells a quit apart from a drop, and dates both', () => {
    // §3: `online: false` is one word for situations a member experiences as
    // completely different things. A quit is "reopen it on your Mac"; a drop is
    // "asleep — send it again when it's back".
    const relay = createRelay();
    const first = relay.attachEndpoint(hello(), () => {}, OWNER);
    const attached = relay.listEndpoints(OWNER)[0]!;
    assert.equal(attached.online, true);
    assert.equal(attached.quit, undefined, 'nothing to report while it is here');
    assert.equal(attached.lastSeenAt, undefined, 'it has not been gone yet');

    // Dropped: no goodbye reached the relay, which is what a kill, a crash and
    // a closed lid all look like — and the relay does not try to separate them.
    const before = Date.now();
    relay.detachEndpoint('laptop');
    const dropped = relay.listEndpoints(OWNER)[0]!;
    assert.equal(dropped.online, false);
    assert.equal(dropped.quit, undefined);
    assert.ok((dropped.lastSeenAt ?? 0) >= before, 'dated, so "asleep" can say when');

    // Quit: the companion said so on its way out, before its leg closed.
    const second = relay.attachEndpoint(hello(), () => {}, OWNER);
    relay.sayGoodbye('laptop', second);
    assert.equal(relay.listEndpoints(OWNER)[0]!.quit, undefined, 'still here, still ready');
    relay.detachEndpoint('laptop');
    assert.equal(relay.listEndpoints(OWNER)[0]!.quit, true);

    // And a reattach clears it. Asserting that on the live listing would prove
    // nothing — it hides `quit` while online either way — so the check is the
    // failure it actually prevents: this companion is killed rather than quit,
    // and must not inherit the previous exit's word for it.
    relay.attachEndpoint(hello(), () => {}, OWNER);
    const back = relay.listEndpoints(OWNER)[0]!;
    assert.equal(back.online, true);
    assert.ok(back.lastSeenAt !== undefined, 'when it was last away survives the reattach');
    relay.detachEndpoint('laptop');
    assert.equal(
      relay.listEndpoints(OWNER)[0]!.quit,
      undefined,
      'a crash after a quit still reads as a crash',
    );

    // And a goodbye from a leg the companion has already replaced speaks for
    // nobody. Its login service restarts it fast enough that the old ingest is
    // still draining, and taking that frame would label this attachment's next
    // crash as a deliberate quit.
    relay.attachEndpoint(hello(), () => {}, OWNER);
    relay.sayGoodbye('laptop', first);
    relay.detachEndpoint('laptop');
    assert.equal(relay.listEndpoints(OWNER)[0]!.quit, undefined, 'a stale goodbye is ignored');
  });

  it("hides and refuses another owner's endpoint", () => {
    // Every other case here is one tenant, so the ownership branches in
    // openSession and listEndpoints are only exercised by the tenancy suite —
    // which needs Docker. This pins them without it.
    const relay = createRelay();
    const toClient: string[] = [];
    relay.attachEndpoint(hello(), () => {}, OWNER);
    relay.openSession(open(), (line) => toClient.push(line), 'u-someone-else');
    assert.deepEqual(JSON.parse(toClient[0]!), {
      kind: 'refused',
      sessionId: 'sid-1',
      code: 'offline',
      reason: 'endpoint offline',
    });
    assert.deepEqual(relay.listEndpoints('u-someone-else'), []);
    assert.equal(relay.listEndpoints(OWNER).length, 1);
    // And the refusal left no session behind for its owner to trip over.
    assert.equal(relay.sessionOwner('sid-1'), undefined);
  });

  it('reports whether an open and an ack were actually applied', () => {
    // The callers use these to decide whether to touch the database. Asking
    // sessionRun instead answered about whatever session held the id, which on
    // a duplicate is the other owner's — and the answer killed it.
    const relay = createRelay();
    relay.attachEndpoint(hello(), () => {}, OWNER);
    assert.equal(
      relay.openSession(open(), () => {}, OWNER),
      true,
    );
    assert.equal(
      relay.openSession(open(), () => {}, OWNER),
      false,
      'duplicate id refused',
    );
    assert.equal(
      relay.openSession(open({ endpoint: 'ghost' }), () => {}, OWNER),
      false,
      'unknown endpoint refused',
    );

    // A companion naming a session it does not hold is ignored, and says so.
    const ack = { kind: 'refused' as const, sessionId: 'sid-1' };
    assert.equal(relay.endpointAck('someone-else', ack, JSON.stringify(ack)), false);
    assert.equal(relay.sessionOwner('sid-1'), OWNER, 'the real session survives');
    assert.equal(relay.endpointAck('laptop', ack, JSON.stringify(ack)), true);
    assert.equal(relay.sessionOwner('sid-1'), undefined);
  });

  it('leaves live sessions out of what retention may expire', () => {
    const relay = createRelay();
    relay.attachEndpoint(hello(), () => {}, OWNER);
    relay.openSession(open(), () => {}, OWNER);
    assert.deepEqual(relay.liveSessions(), [
      { endpoint: 'laptop', runId: 'run-1', sessionId: 'sid-1' },
    ]);
    relay.closeSession('sid-1', 'done');
    assert.deepEqual(relay.liveSessions(), []);
  });

  it('reports who an attached endpoint belongs to', () => {
    // The gateway checks this before writing a session row, so a caller cannot
    // reserve an id against an endpoint it does not own.
    const relay = createRelay();
    assert.equal(relay.endpointOwner('laptop'), undefined, 'not attached');
    relay.attachEndpoint(hello(), () => {}, OWNER);
    assert.equal(relay.endpointOwner('laptop'), OWNER);
    assert.equal(relay.endpointOwner('someone-elses'), undefined);
  });
});
