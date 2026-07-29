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
  const deps: MentionDeps = {
    budgetBytes: 10_000,
    log: () => {},
    find: () => Promise.resolve(over.existing),
    threadReplies: () => Promise.resolve('replies' in over ? over.replies : THREAD),
    post: (channel, text, threadTs) => {
      posts.push({ channel, text, ...(threadTs ? { threadTs } : {}) });
      return Promise.resolve({ channel: 'D-nel', ts: '200.0' });
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
  return { deps, posts, turns };
}

describe('app_mention', () => {
  it('opens a private conversation and never answers the channel', async () => {
    const { deps, posts, turns } = harness({});
    assert.equal(await handleMention(MENTION, deps), 'opened');

    // The channel supplied context, not consent (§5). Everything goes to the
    // member — addressed by user id, which Slack resolves to their DM.
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.channel, 'U-nel');
    assert.doesNotMatch(posts[0]!.channel, /^C-/, 'nothing is posted to a channel');
    assert.match(posts[0]!.text, /the deploy is failing/, 'the thread came with it');
    assert.match(posts[0]!.text, /nothing goes back to the channel unless you say so/);

    // The cursor recorded is what the snapshot actually read.
    assert.equal(turns[0]!.seenThroughTs, '101.0');
  });

  it('continues the thread it already has rather than opening a second', async () => {
    const existing = {
      id: 'conv-1',
      dmChannel: 'D-nel',
      rootThread: '200.0',
      seenThroughTs: '100.0',
    };
    const { deps, posts, turns } = harness({ existing });
    assert.equal(await handleMention(MENTION, deps), 'continued');

    // In the DM root the member is already looking at (§4, amended).
    assert.equal(posts[0]!.channel, 'D-nel');
    assert.equal(posts[0]!.threadTs, '200.0');
    // And carrying only the delta: the root was already shown.
    assert.doesNotMatch(posts[0]!.text, /the deploy is failing/);
    assert.match(posts[0]!.text, /here is the trace/);
    assert.equal(turns[0]!.seenThroughTs, '101.0');
  });

  it('says nothing twice when Slack redelivers a mention', async () => {
    // The turn is recorded before anything is posted, so a redelivery that the
    // gateway has already seen produces silence rather than a second message.
    const existing = { id: 'conv-1', dmChannel: 'D-nel', rootThread: '200.0' };
    const { deps, posts, turns } = harness({ existing });
    // The gateway answers with no turn, which is a Slack event it has recorded
    // before.
    deps.turn = (spec) => {
      turns.push(spec);
      return Promise.resolve({ conversation: existing });
    };
    assert.equal(await handleMention(MENTION, deps), 'already handled');
    assert.deepEqual(posts, []);
    assert.equal(turns.length, 1, 'it still asked, which is how it found out');
  });

  it('asks to be invited rather than answering from a channel it cannot read', async () => {
    // §4: when the bot is not in a private channel, say so. Answering from a
    // partial snapshot would look like a complete answer.
    const { deps, posts, turns } = harness({ replies: undefined });
    assert.equal(await handleMention(MENTION, deps), 'unreadable channel');
    assert.equal(posts[0]!.channel, 'U-nel');
    assert.match(posts[0]!.text, /invite me/);
    assert.deepEqual(turns, [], 'and no turn is recorded for work it cannot do');
  });

  it('carries on in the winning thread when two mentions race', async () => {
    // The gateway declined to overwrite a root another delivery posted, so the
    // one just posted is stray. The member is told which thread is live by the
    // reply landing there.
    const { deps } = harness({ rootThread: '999.0' });
    assert.equal(await handleMention(MENTION, deps), 'adopted');
  });
});
