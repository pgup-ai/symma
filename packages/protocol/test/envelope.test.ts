import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseEnvelope, type ObserverEnvelope } from '../src/envelope.ts';
import { isSafeId } from '../src/ids.ts';

const envelope = (overrides: Partial<ObserverEnvelope> = {}): ObserverEnvelope => ({
  v: 1,
  runId: 'run-1',
  sessionId: 'review',
  seq: 1,
  ts: 1,
  agent: 'kilo',
  label: 'review',
  dir: 'in',
  frame: { jsonrpc: '2.0', method: 'session/update' },
  ...overrides,
});

describe('observer envelope', () => {
  it('validates envelopes and rejects unsafe ids', () => {
    const good = parseEnvelope(JSON.stringify(envelope()));
    assert.equal(good?.sessionId, 'review');
    // Ids become file paths, so traversal shapes must die at the boundary.
    assert.equal(isSafeId('../etc'), false);
    assert.equal(isSafeId('.hidden'), false);
    assert.equal(isSafeId('a/b'), false);
    assert.equal(isSafeId('run.2026-07-24_01'), true);
    assert.equal(parseEnvelope(JSON.stringify(envelope({ runId: '../x' }))), undefined);
    assert.equal(parseEnvelope(JSON.stringify(envelope({ frame: undefined }))), undefined);
    assert.equal(parseEnvelope('not json'), undefined);
    assert.equal(parseEnvelope(JSON.stringify(envelope({ v: 2 as unknown as 1 }))), undefined);
  });
});
