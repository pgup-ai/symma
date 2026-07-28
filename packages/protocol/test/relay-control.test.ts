import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseRelayControl, type HelloControl, type OpenControl } from '../src/relay-control.js';

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
