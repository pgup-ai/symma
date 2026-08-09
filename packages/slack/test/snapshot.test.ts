import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { threadSnapshot, type ThreadMessage } from '../src/snapshot.js';

const say = (ts: string, text: string): ThreadMessage => ({ ts, author: 'Nel', text });
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
    // A quote of names, not a log of ids and epochs. The `ts` still travels —
    // as `seenThroughTs`, asserted above.
    assert.match(snapshot.text, /^> \*Nel:\* the deploy is failing/);
    assert.match(snapshot.text, /third reply$/);
    assert.doesNotMatch(snapshot.text, /100\.0/);
  });

  it('keeps the root and the newest, and says how many it dropped', () => {
    // §4: keep the root plus the most recent, and state exactly what was
    // omitted. A snapshot that quietly loses the middle is worse than a short
    // one, because nothing downstream can tell it happened.
    // Sized from the two ends plus room for the note that stands in for the
    // middle — the note is reserved out of the budget, so a ceiling measured
    // without it would not fit what it is meant to fit.
    const ends = threadSnapshot([thread[0]!, thread[3]!], { budgetBytes: 10_000 });
    const budgetBytes = Buffer.byteLength(ends.text) + 60;
    const snapshot = threadSnapshot(thread, { budgetBytes });
    assert.equal(snapshot.omitted, 2);
    assert.match(snapshot.text, /the deploy is failing/, 'the root survives');
    assert.match(snapshot.text, /third reply/, 'and the newest');
    assert.doesNotMatch(snapshot.text, /first reply/);
    assert.match(snapshot.text, /… 2 earlier replies omitted/);
    // In place, so the gap reads where it happened.
    assert.ok(snapshot.text.indexOf('omitted') < snapshot.text.indexOf('third reply'));
    // Note included, since reserving for it is the point.
    assert.ok(Buffer.byteLength(snapshot.text) <= budgetBytes);
  });

  it('pulls only the delta once the agent has seen part of the thread', () => {
    const snapshot = threadSnapshot(thread, { budgetBytes: 10_000, since: '101.0' });
    assert.equal(snapshot.seenThroughTs, '103.0');
    assert.doesNotMatch(snapshot.text, /the deploy is failing/, 'the root is not re-sent');
    assert.doesNotMatch(snapshot.text, /first reply/, 'nor anything at or before the cursor');
    assert.match(snapshot.text, /second reply/);
  });

  it('orders the thread itself rather than trusting the caller', () => {
    // The delta branch used to filter without sorting, so an out-of-order page
    // could drop the wrong replies and report a cursor that skipped work.
    // Reversed, not merely shuffled: the filtered subset has to come out
    // descending, or an unsorted filter would happen to yield the right order
    // and the assertion would pass on a broken implementation.
    const jumbled = [...thread].reverse();
    assert.deepEqual(threadSnapshot(jumbled, { budgetBytes: 10_000, since: '101.0' }), {
      text: threadSnapshot(thread, { budgetBytes: 10_000, since: '101.0' }).text,
      seenThroughTs: '103.0',
      omitted: 0,
    });
  });

  it('leaves the cursor alone when there is nothing new', () => {
    // A mention with no new replies still opens a turn; it just carries no
    // context, and must not claim to have read past where it stopped.
    const snapshot = threadSnapshot(thread, { budgetBytes: 10_000, since: '103.0' });
    assert.deepEqual(snapshot, { text: '', omitted: 0 });
  });

  it('trims the newest reply rather than dropping it or blowing the budget', () => {
    // Dropping it would advance the cursor past a message never shown, and a
    // skipped message never comes back. Keeping it whole would put the snapshot
    // past a ceiling that exists partly because Slack will refuse an oversized
    // post — so it is cut, and says it was cut.
    const long = [...thread, { ts: '104.0', author: 'U-nel', text: 'x'.repeat(5_000) }];
    const snapshot = threadSnapshot(long, { budgetBytes: 300, since: '101.0' });
    assert.equal(snapshot.seenThroughTs, '104.0', 'the cursor still reaches it');
    assert.match(snapshot.text, /\[truncated\]/);
    // At or under, not merely near: the trimmed line has to leave room for the
    // newline it gets joined with, or the ceiling is a byte short of one.
    assert.ok(
      Buffer.byteLength(snapshot.text) <= 300,
      `within the ceiling, got ${Buffer.byteLength(snapshot.text)}`,
    );
  });

  it('never returns more than the budget, even when nothing fits', () => {
    // Below the truncation marker there is nothing honest to emit: a bare marker
    // would exceed the budget it was measured against, and an empty line kept in
    // its place would advance the cursor over a message never shown.
    for (const budgetBytes of [0, 1, 8, 16, 40]) {
      const snapshot = threadSnapshot(thread, { budgetBytes });
      assert.ok(
        Buffer.byteLength(snapshot.text) <= budgetBytes,
        `budget ${budgetBytes} produced ${Buffer.byteLength(snapshot.text)} bytes`,
      );
      // And whatever it could not show, it has not claimed to have read.
      if (snapshot.seenThroughTs) assert.ok(snapshot.text.length > 0);
    }
  });

  it('keeps a multi-line message inside the quote', () => {
    // Slack quotes by the line, not by the message, so a pasted stack trace would
    // otherwise leave the transcript halfway through and read as the bot talking.
    const snapshot = threadSnapshot(
      [{ ts: '100.0', author: 'Nel', text: 'it threw:\nline one\nline two' }],
      {
        budgetBytes: 10_000,
      },
    );
    assert.equal(snapshot.text, '> *Nel:* it threw:\n> line one\n> line two');
  });

  it('does not let a display name close the bold it is shown in', () => {
    // Names are escaped where they are resolved, but the `*` is this renderer's
    // own markup — a member called `*Jane*` would close it and bold the rest.
    const snapshot = threadSnapshot([{ ts: '100.0', author: 'C*3PO', text: 'hello there' }], {
      budgetBytes: 10_000,
    });
    assert.equal(snapshot.text, '> *C3PO:* hello there');
  });

  it('names attached files without fetching them', () => {
    // v1 passes metadata only: downloading widens the scope request and the
    // data-lifecycle surface both (§10).
    const snapshot = threadSnapshot(
      [{ ts: '100.0', author: 'Nel', text: 'logs attached', files: [{ name: 'trace.log' }] }],
      { budgetBytes: 10_000 },
    );
    assert.match(snapshot.text, /> files: trace\.log/);
  });
});
