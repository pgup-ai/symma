import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { onFatalSignal } from '../src/signal-cleanup.js';

describe('onFatalSignal', () => {
  it('shares one listener per signal and removes it once the last cleanup deregisters', () => {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    // Per-signal baselines: one signal's count is not a valid expectation for another.
    const before = signals.map((s) => process.listenerCount(s));
    const counts = () => signals.map((s, i) => process.listenerCount(s) - (before[i] ?? 0));

    const first = onFatalSignal(() => {});
    assert.deepEqual(counts(), [1, 1, 1]);

    // A second registration must not stack another listener, or the first
    // handler to re-raise would cancel the others.
    const second = onFatalSignal(() => {});
    assert.deepEqual(counts(), [1, 1, 1]);

    first();
    assert.deepEqual(counts(), [1, 1, 1], 'still one cleanup outstanding');

    second();
    assert.deepEqual(counts(), [0, 0, 0]);
  });
});
