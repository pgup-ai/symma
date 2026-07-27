import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseEnvelope, type ObserverEnvelope } from '../src/envelope.js';
import { isSafeId } from '../src/ids.js';

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

  it('rejects a seq that would poison the rest of the session', () => {
    // Raw text on purpose: JSON.stringify turns Infinity into null, so building
    // these through the fixture would pass for the wrong reason.
    const line = (seq: string, ts = '1'): string =>
      `{"v":1,"runId":"r","sessionId":"s","seq":${seq},"ts":${ts},` +
      `"agent":"a","label":"l","dir":"in","frame":{}}`;
    // Past the double range JSON parses to Infinity; the viewer drops anything
    // with `seq <= lastSeq`, so one such line blanks the rest of the session.
    assert.equal(parseEnvelope(line('1e400')), undefined);
    assert.equal(parseEnvelope(line('-1e400')), undefined);
    for (const seq of ['1.5', '-1', '9007199254740992']) {
      assert.equal(parseEnvelope(line(seq)), undefined, seq);
    }
    assert.equal(parseEnvelope(line('0'))?.seq, 0);
    // ts only has to be finite — it is a clock reading, not a cursor.
    assert.equal(parseEnvelope(line('1', '1e400')), undefined);
  });
});
