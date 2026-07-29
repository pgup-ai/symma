import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { threadSnapshot, type ThreadMessage } from '../src/snapshot.js';

const say = (ts: string, text: string): ThreadMessage => ({ ts, author: 'U-nel', text });
const thread: ThreadMessage[] = [
  say('100.0', 'the deploy is failing'),
  say('101.0', 'first reply'),
  say('102.0', 'second reply'),
  say('103.0', 'third reply'),
];

describe('thread snapshot', () => {
  it('carries the whole thread when it fits, oldest first', () => {
    const snapshot = threadSnapshot(thread, { budgetBytes: 10_000 });
    assert.equal(snapshot.omitted, 0);
    assert.equal(snapshot.seenThroughTs, '103.0');
    assert.match(snapshot.text, /^\[100\.0\] U-nel: the deploy is failing/);
    assert.match(snapshot.text, /third reply$/);
  });

  it('keeps the root and the newest, and says how many it dropped', () => {
    // §4: keep the root plus the most recent, and state exactly what was
    // omitted. A snapshot that quietly loses the middle is worse than a short
    // one, because nothing downstream can tell it happened.
    const room = threadSnapshot([thread[0]!, thread[3]!], { budgetBytes: 10_000 });
    const snapshot = threadSnapshot(thread, { budgetBytes: room.text.length + 1 });
    assert.equal(snapshot.omitted, 2);
    assert.match(snapshot.text, /the deploy is failing/, 'the root survives');
    assert.match(snapshot.text, /third reply/, 'and the newest');
    assert.doesNotMatch(snapshot.text, /first reply/);
    assert.match(snapshot.text, /… 2 earlier replies omitted/);
    // In place, so the gap reads where it happened.
    assert.ok(snapshot.text.indexOf('omitted') < snapshot.text.indexOf('third reply'));
  });

  it('pulls only the delta once the agent has seen part of the thread', () => {
    const snapshot = threadSnapshot(thread, { budgetBytes: 10_000, since: '101.0' });
    assert.equal(snapshot.seenThroughTs, '103.0');
    assert.doesNotMatch(snapshot.text, /the deploy is failing/, 'the root is not re-sent');
    assert.doesNotMatch(snapshot.text, /first reply/, 'nor anything at or before the cursor');
    assert.match(snapshot.text, /second reply/);
  });

  it('leaves the cursor alone when there is nothing new', () => {
    // A mention with no new replies still opens a turn; it just carries no
    // context, and must not claim to have read past where it stopped.
    const snapshot = threadSnapshot(thread, { budgetBytes: 10_000, since: '103.0' });
    assert.deepEqual(snapshot, { text: '', omitted: 0 });
  });

  it('keeps the newest reply even when it alone exceeds the budget', () => {
    // The alternative is advancing the cursor past a message never shown, and a
    // skipped message never comes back.
    const snapshot = threadSnapshot(thread, { budgetBytes: 1, since: '101.0' });
    assert.equal(snapshot.seenThroughTs, '103.0');
    assert.match(snapshot.text, /third reply/);
    assert.equal(snapshot.omitted, 1, 'and says the one it could not fit is missing');
  });

  it('names attached files without fetching them', () => {
    // v1 passes metadata only: downloading widens the scope request and the
    // data-lifecycle surface both (§10).
    const snapshot = threadSnapshot(
      [{ ts: '100.0', author: 'U-nel', text: 'logs attached', files: [{ name: 'trace.log' }] }],
      { budgetBytes: 10_000 },
    );
    assert.match(snapshot.text, /files: trace\.log/);
  });
});
