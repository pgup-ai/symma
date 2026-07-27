import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { VIEWER_HTML } from '../src/viewer.js';

describe('viewer render batching', () => {
  it('applies a replay burst once per animation frame, not once per frame', () => {
    // A finished review replays ~24k frames at once. Writing each straight to
    // the DOM forced a layout per frame, since pinned() measures before the
    // mutation and scrolls after it.
    assert.match(VIEWER_HTML, /pendingFrame = requestAnimationFrame\(flushPending\)/);
    // One measure and one scroll per flush, wrapping the batch rather than each item.
    assert.match(
      VIEWER_HTML,
      /pinned\(function \(\) \{\s*for \(var i = 0; i < batch\.length; i\+\+\)/,
    );
  });

  it('keeps buffered text ahead of anything appended after it', () => {
    assert.match(VIEWER_HTML, /function append\(node\) \{ flushPending\(\);/);
    assert.match(VIEWER_HTML, /function closeStreams\(\) \{ flushPending\(\);/);
  });

  it('caps a block so appending stays proportional to the chunk', () => {
    // textContent += on one growing element makes a long transcript quadratic.
    assert.match(VIEWER_HTML, /textContent\.length > MAX_BLOCK/);
  });
});
