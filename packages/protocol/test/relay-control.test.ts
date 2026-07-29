import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseRelayControl,
  PROTOCOL_VERSION,
  servesProtocol,
  type HelloControl,
  type OpenControl,
} from '../src/relay-control.js';

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

describe('relay control parsing', () => {
  it('parses controls strictly and rejects unsafe or malformed input', () => {
    assert.equal(parseRelayControl(JSON.stringify(hello()))?.kind, 'hello');
    // Unknown fields (future resume cursors) are ignored, not rejected.
    assert.equal(
      parseRelayControl(JSON.stringify({ ...hello(), lastSeq: { a: 1 } }))?.kind,
      'hello',
    );
    const parsedOpen = parseRelayControl(JSON.stringify(open({ model: 'kilo/x', ref: 'main' })));
    assert.deepEqual(parsedOpen, { ...open(), model: 'kilo/x', ref: 'main' });
    assert.equal(
      parseRelayControl(JSON.stringify({ kind: 'close', sessionId: 's', reason: 'r' }))?.kind,
      'close',
    );
    for (const bad of [
      'not json',
      JSON.stringify({ kind: 'nope' }),
      JSON.stringify(hello({ endpoint: '../x' })),
      JSON.stringify(hello({ maxSessions: 0 })),
      JSON.stringify(hello({ agents: [{}] as never })),
      JSON.stringify(open({ sessionId: 'a/b' })),
      JSON.stringify(open({ runId: '.hidden' })),
      JSON.stringify({ kind: 'opened' }),
      JSON.stringify({ jsonrpc: '2.0', method: 'session/update' }),
    ]) {
      assert.equal(parseRelayControl(bad), undefined, bad);
    }
  });

  it('reads a generation off hello, and drops one it cannot read', () => {
    const version = (raw: unknown): number | undefined =>
      (parseRelayControl(JSON.stringify(hello({ version: raw as number }))) as HelloControl)
        .version;
    assert.equal(version(2), 2);
    // Coerced like `maxSessions` beside it; a stricter rule for one numeric
    // field would only make the parser inconsistent, and '3' means generation 3.
    assert.equal(version('3'), 3);
    // Absent is generation 0: every companion published before the field
    // existed sends none, and those are exactly what N−1 has to keep serving.
    assert.equal((parseRelayControl(JSON.stringify(hello())) as HelloControl).version, undefined);
    // Unreadable drops to absent rather than failing the hello — the same
    // direction an unknown refusal code drops, and the safe one, since the
    // oldest generation is the first to be refused.
    for (const bad of [1.5, -1, 0, null, {}, 'soon']) {
      assert.equal(version(bad), undefined, JSON.stringify(bad));
    }
  });

  it('serves this generation and the one below it', () => {
    assert.ok(servesProtocol(PROTOCOL_VERSION));
    assert.ok(servesProtocol(PROTOCOL_VERSION - 1));
    assert.ok(!servesProtocol(PROTOCOL_VERSION - 2));
    // Absent is generation 0, so the companions already published — none of
    // which state a version — are served for one more bump rather than cut off
    // at the first, which is the whole reason the field ships before it bites.
    assert.equal(servesProtocol(), servesProtocol(0));
  });

  it('keeps a known refusal code and drops an unknown one', () => {
    const parse = (code: unknown): unknown =>
      (
        parseRelayControl(JSON.stringify({ kind: 'refused', sessionId: 'sid-1', code })) as
          { code?: string } | undefined
      )?.code;
    assert.equal(parse('offline'), 'offline');
    assert.equal(parse('at_capacity'), 'at_capacity');
    // A relay that learns a new code must not make the frame unreadable to a
    // client that has not; the refusal still arrives, just uncoded.
    assert.equal(parse('brand_new_reason'), undefined);
    assert.equal(
      (
        parseRelayControl(JSON.stringify({ kind: 'refused', sessionId: 'sid-1', code: 'nope' })) as
          { kind?: string } | undefined
      )?.kind,
      'refused',
    );
  });
});
