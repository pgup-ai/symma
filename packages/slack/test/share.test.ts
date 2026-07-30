import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleShare, type ShareDeps, type ShareRequest } from '../src/share.js';
import type { Unusable } from '../src/slack-api.js';

const CLICK: ShareRequest = {
  user: 'U-nel',
  channel: 'D-nel',
  messageTs: '300.0',
  text: 'the deploy fails on a missing env var',
  conversation: 'conv-1',
};

function harness(over: { to?: { channel: string; thread: string }; why?: Unusable } = {}) {
  const shared: { channel: string; thread: string; text: string }[] = [];
  const posts: { channel: string; text: string; threadTs?: string }[] = [];
  const deps: ShareDeps = {
    destination: () =>
      Promise.resolve('to' in over ? over.to : { channel: 'C-incidents', thread: '100.0' }),
    share: (channel, thread, text) => {
      shared.push({ channel, thread, text });
      return Promise.resolve(over.why ? { ok: false as const, why: over.why } : { ok: true });
    },
    post: (channel, text, threadTs) => {
      posts.push({ channel, text, ...(threadTs ? { threadTs } : {}) });
      return Promise.resolve(undefined);
    },
  };
  return { deps, shared, posts };
}

describe('share back', () => {
  it('posts to the thread it came from, with the approver named', async () => {
    const { deps, shared, posts } = harness();
    assert.equal(await handleShare(CLICK, deps), 'shared');

    // §5: a channel post is attributable to whoever approved it, never to the
    // bot on its own — the answer arrived because a person pressed a button.
    assert.deepEqual(shared, [
      {
        channel: 'C-incidents',
        thread: '100.0',
        text: '<@U-nel> shared:\n\nthe deploy fails on a missing env var',
      },
    ]);
    assert.match(posts[0]!.text, /Shared to the thread/);
  });

  it('keeps the answer and names what went wrong', async () => {
    // §5: a publication that cannot land is not a lost answer. Each of these is
    // a different thing for the member to do, so one word for all of them would
    // send someone to an admin when the fix was to re-invite the bot.
    const cases = [
      { why: 'archived', says: /archived/ },
      { why: 'removed', says: /not in that channel/ },
      { why: 'locked', says: /read-only/ },
      { why: 'gone', says: /thread is gone/ },
      { why: 'scope', says: /permission/ },
    ] as const;

    for (const { why, says } of cases) {
      const { deps, posts } = harness({ why });
      assert.equal(await handleShare(CLICK, deps), `kept: ${why}`);
      assert.match(posts[0]!.text, says, why);
      // Back in the thread the member is looking at, not at the DM root.
      assert.equal(posts[0]!.threadTs, '300.0');
      assert.match(posts[0]!.text, /Nothing was lost/, why);
    }
  });

  it('says so when there is nowhere to share back to', async () => {
    // A conversation opened in the DM has no source thread, and one that is not
    // this member's answers the same way — the gateway states the destination,
    // so "none" covers both without the bot deciding which.
    const { deps, shared, posts } = harness({ to: undefined });
    assert.equal(await handleShare(CLICK, deps), 'no destination');
    assert.deepEqual(shared, [], 'nothing was published');
    assert.match(posts[0]!.text, /no thread to share this back to/);
  });
});
