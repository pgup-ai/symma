import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleMention, type ConversationRef, type MentionDeps } from '../src/mention.js';
import type { ThreadMessage } from '../src/snapshot.js';

const MENTION = { user: 'U-nel', channel: 'C-incidents', threadTs: '100.0', eventId: 'Ev-1' };
const THREAD: ThreadMessage[] = [
  { ts: '100.0', author: 'U-nel', text: 'the deploy is failing' },
  { ts: '101.0', author: 'U-ola', text: 'here is the trace' },
];

interface Posted {
  channel: string;
  text: string;
  threadTs?: string;
}

/** Records what reached Slack and what the gateway was asked. */
function harness(over: {
  existing?: ConversationRef;
  replies?: ThreadMessage[] | undefined;
  rootThread?: string;
}) {
  const posts: Posted[] = [];
  const turns: Record<string, unknown>[] = [];
  const seen: string[] = [];
  const deps: MentionDeps = {
    budgetBytes: 10_000,
    log: () => {},
    find: () => Promise.resolve(over.existing),
    threadReplies: () => Promise.resolve('replies' in over ? over.replies : THREAD),
    post: (channel, text, threadTs) => {
      posts.push({ channel, text, ...(threadTs ? { threadTs } : {}) });
      return Promise.resolve({ channel: 'D-nel', ts: '200.0' });
    },
    seen: (_conversation, ts) => {
      seen.push(ts);
      return Promise.resolve();
    },
    turn: (spec) => {
      turns.push(spec);
      return Promise.resolve({
        conversation: {
          id: 'conv-1',
          dmChannel: 'D-nel',
          rootThread: over.rootThread ?? over.existing?.rootThread ?? '200.0',
        },
        turn: 'turn-1',
      });
    },
  };
  return { deps, posts, turns, seen };
}

describe('app_mention', () => {
  it('opens a private conversation and never answers the channel', async () => {
    const { deps, posts, turns, seen } = harness({});
    assert.equal(await handleMention(MENTION, deps), 'opened');

    // The channel supplied context, not consent (§5). Everything goes to the
    // member — addressed by user id, which Slack resolves to their DM.
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.channel, 'U-nel');
    assert.doesNotMatch(posts[0]!.channel, /^C-/, 'nothing is posted to a channel');
    assert.match(posts[0]!.text, /the deploy is failing/, 'the thread came with it');
    assert.match(posts[0]!.text, /nothing goes back to the channel unless you say so/);

    // The cursor recorded is what the snapshot actually read, and it moves only
    // once the member has it.
    assert.deepEqual(seen, ['101.0']);
    // The turn names the thread it came from, which is what a later share-back
    // has to post into.
    assert.equal(turns[0]!.sourceThread, '100.0');
    assert.equal(turns[0]!.slackEventId, 'Ev-1');
  });

  it('continues the thread it already has rather than opening a second', async () => {
    const existing = {
      id: 'conv-1',
      dmChannel: 'D-nel',
      rootThread: '200.0',
      seenThroughTs: '100.0',
    };
    const { deps, posts, seen } = harness({ existing });
    assert.equal(await handleMention(MENTION, deps), 'continued');

    // In the DM root the member is already looking at (§4, amended).
    assert.equal(posts[0]!.channel, 'D-nel');
    assert.equal(posts[0]!.threadTs, '200.0');
    // And carrying only the delta: the root was already shown.
    assert.doesNotMatch(posts[0]!.text, /the deploy is failing/);
    assert.match(posts[0]!.text, /here is the trace/);
    assert.deepEqual(seen, ['101.0'], 'the cursor moves once the member has it');
  });

  it('says nothing twice when Slack redelivers a mention', async () => {
    // The turn is recorded before anything is posted, so a redelivery that the
    // gateway has already seen produces silence rather than a second message.
    const existing = { id: 'conv-1', dmChannel: 'D-nel', rootThread: '200.0' };
    const { deps, posts, turns, seen } = harness({ existing });
    // The gateway answers with no turn, which is a Slack event it has recorded
    // before.
    deps.turn = (spec) => {
      turns.push(spec);
      return Promise.resolve({ conversation: existing });
    };
    assert.equal(await handleMention(MENTION, deps), 'already handled');
    assert.deepEqual(posts, []);
    assert.deepEqual(seen, [], 'and the cursor stays where it was');
    assert.equal(turns.length, 1, 'it still asked, which is how it found out');
  });

  it('leaves the cursor where it was when the post fails', async () => {
    // The turn is recorded before the post, for redelivery. If the cursor moved
    // with it, a post that failed would mark the thread read and the retry the
    // member is invited to make would filter out exactly what they never saw.
    const existing = { id: 'conv-1', dmChannel: 'D-nel', rootThread: '200.0' };
    const { deps, seen } = harness({ existing });
    deps.post = () => Promise.reject(new Error('slack is down'));
    await assert.rejects(handleMention(MENTION, deps), /slack is down/);
    assert.deepEqual(seen, []);
  });

  it('asks to be invited rather than answering from a channel it cannot read', async () => {
    // §4: when the bot is not in a private channel, say so. Answering from a
    // partial snapshot would look like a complete answer.
    const { deps, posts, turns } = harness({ replies: undefined });
    assert.equal(await handleMention(MENTION, deps), 'unreadable channel');
    assert.equal(posts[0]!.channel, 'U-nel');
    assert.equal(
      posts[0]!.threadTs,
      undefined,
      'no thread ts without a conversation to thread it in',
    );
    assert.match(posts[0]!.text, /invite me/);
    assert.deepEqual(turns, [], 'and no turn is recorded for work it cannot do');

    // With a conversation, the refusal joins it — addressed by its own channel
    // and root, not a user id paired with a thread ts from elsewhere.
    const known = { id: 'conv-1', dmChannel: 'D-nel', rootThread: '200.0' };
    const going = harness({ existing: known, replies: undefined });
    assert.equal(await handleMention(MENTION, going.deps), 'unreadable channel');
    assert.equal(going.posts[0]!.channel, 'D-nel');
    assert.equal(going.posts[0]!.threadTs, '200.0');
  });

  it('carries on in the winning thread when two mentions race', async () => {
    // The gateway declined to overwrite a root another delivery posted, so the
    // one just posted is stray. The member is told which thread is live by the
    // reply landing there.
    const { deps, posts, seen } = harness({ rootThread: '999.0' });
    assert.equal(await handleMention(MENTION, deps), 'adopted');

    // Three messages: the stray root already posted, the correction telling the
    // member it is not the live one, and the work in the thread that is. Without
    // the correction they are left with two threads both claiming to be working.
    assert.equal(posts.length, 3);
    assert.equal(posts[1]!.threadTs, '200.0', 'the correction lands in the stray');
    assert.match(posts[1]!.text, /carry on in the other thread/);
    assert.equal(posts[2]!.threadTs, '999.0', 'and the snapshot in the winner');
    assert.deepEqual(seen, ['101.0']);
  });
});
