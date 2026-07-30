import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleDm, isMemberDm, type DmDeps } from '../src/dm.js';
import type { ConversationRef } from '../src/mention.js';

const CONVERSATION: ConversationRef = { id: 'conv-1', dmChannel: 'D-nel', rootThread: '200.0' };

function harness(over: { existing?: ConversationRef; turn?: boolean } = {}) {
  const posts: { channel: string; threadTs?: string }[] = [];
  const turns: Record<string, unknown>[] = [];
  const deps: DmDeps = {
    find: () => Promise.resolve(over.existing),
    post: (channel, _text, threadTs) => {
      posts.push({ channel, ...(threadTs ? { threadTs } : {}) });
      return Promise.resolve({ channel, ts: '300.0' });
    },
    turn: (spec) => {
      turns.push(spec);
      return Promise.resolve({
        conversation: over.existing ?? CONVERSATION,
        ...(over.turn === false ? {} : { turn: 'turn-1' }),
      });
    },
  };
  return { deps, posts, turns };
}

describe('dm message', () => {
  it('answers a member, and never the bot itself', () => {
    const member = {
      type: 'message',
      channel_type: 'im',
      user: 'U-nel',
      channel: 'D-nel',
      ts: '1.0',
    };
    assert.equal(isMemberDm(member), true);

    // Our own posts arrive on this same subscription. Answering one is an
    // infinite loop, which is why this is a function and not a condition.
    assert.equal(isMemberDm({ ...member, bot_id: 'B-symma' }), false);
    // Edits, deletes and joins carry a different shape and nothing to answer.
    for (const subtype of ['message_changed', 'message_deleted', 'channel_join']) {
      assert.equal(isMemberDm({ ...member, subtype }), false, subtype);
    }
    // And a channel message is the mention path's business, not this one.
    assert.equal(isMemberDm({ ...member, channel_type: 'channel' }), false);
    for (const missing of ['user', 'channel', 'ts']) {
      assert.equal(isMemberDm({ ...member, [missing]: undefined }), false, missing);
    }
  });

  it('resumes the conversation the thread root names', async () => {
    const { deps, posts, turns } = harness({ existing: CONVERSATION });
    const outcome = await handleDm(
      { user: 'U-nel', channel: 'D-nel', ts: '250.0', threadTs: '200.0', eventId: 'Ev-1' },
      deps,
    );
    assert.equal(outcome, 'resumed');
    // Raft's exact-target rule: the reply goes to the root the member replied
    // under, not to whatever conversation they touched last.
    assert.equal(turns[0]!.rootThread, '200.0');
    assert.deepEqual(posts, [{ channel: 'D-nel', threadTs: '200.0' }]);
  });

  it('opens one for a top-level DM, rooted at that message', async () => {
    // §4: a top-level DM opens a conversation with no source. Its root is the
    // member's own message, which is what their replies will thread under.
    const { deps, turns } = harness();
    assert.equal(
      await handleDm({ user: 'U-nel', channel: 'D-nel', ts: '250.0', eventId: 'Ev-1' }, deps),
      'opened',
    );
    assert.equal(turns[0]!.rootThread, '250.0');
    assert.equal(turns[0]!.sourceChannel, undefined, 'no source to claim');
  });

  it('leaves alone a thread it did not open', async () => {
    // Rooting a conversation mid-thread would answer somewhere the member is not
    // expecting one, under a ts the bot never posted.
    const { deps, posts, turns } = harness();
    assert.equal(
      await handleDm(
        { user: 'U-nel', channel: 'D-nel', ts: '250.0', threadTs: '111.0', eventId: 'Ev-1' },
        deps,
      ),
      'not ours',
    );
    assert.deepEqual(posts, []);
    assert.deepEqual(turns, [], 'and records nothing for a thread that is not ours');
  });

  it('says nothing twice when Slack redelivers', async () => {
    const { deps, posts } = harness({ existing: CONVERSATION, turn: false });
    assert.equal(
      await handleDm(
        { user: 'U-nel', channel: 'D-nel', ts: '250.0', threadTs: '200.0', eventId: 'Ev-1' },
        deps,
      ),
      'already handled',
    );
    assert.deepEqual(posts, [], 'the turn is recorded before the post, so a repeat is silent');
  });
});
