import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleMention, type ConversationRef, type MentionDeps } from '../src/mention.js';
import type { ThreadMessage } from '../src/snapshot.js';

/** A reply in an existing thread: the mention's own ts is what a link back
 * should point at, and it is not the thread's first message. */
const MENTION = {
  user: 'U-nel',
  channel: 'C-incidents',
  ts: '101.0',
  threadTs: '100.0',
  eventId: 'Ev-1',
};
/** Names, not ids: `threadReplies` resolves them before a snapshot sees them. */
const THREAD: ThreadMessage[] = [
  { ts: '100.0', author: 'Nel', text: 'the deploy is failing' },
  { ts: '101.0', author: 'Ola', text: 'here is the trace' },
];

/** Slack's shape, but this test's string: what an assertion on it pins is which
 * message the link names, not how Slack spells one. */
const linkTo = (channel: string, ts: string): string =>
  `https://slack.test/archives/${channel}/p${ts}`;

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
  /** `null` is a permalink Slack refused. */
  link?: string | null;
}) {
  const posts: Posted[] = [];
  const links: string[] = [];
  const turns: Record<string, unknown>[] = [];
  const deps: MentionDeps = {
    log: () => {},
    find: () => Promise.resolve(over.existing),
    threadReplies: () => Promise.resolve('replies' in over ? over.replies : THREAD),
    openDm: () => Promise.resolve('D-nel'),
    permalink: (channel, ts) => {
      links.push(ts);
      return Promise.resolve(over.link === null ? undefined : (over.link ?? linkTo(channel, ts)));
    },
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
  return { deps, posts, turns, links };
}

describe('app_mention', () => {
  it('opens a private conversation and never answers the channel', async () => {
    const { deps, posts, turns } = harness({});
    assert.equal(await handleMention(MENTION, deps), 'opened');

    // The channel supplied context, not consent (§5). Everything goes to the
    // member — addressed by user id, which Slack resolves to their DM.
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.channel, 'D-nel', 'the resolved DM, not a user id');
    assert.doesNotMatch(posts[0]!.channel, /^[CU]-/, 'never a channel, never a raw user id');
    assert.match(posts[0]!.text, /nothing goes back to the channel unless you say so/);
    // And no copy of the thread: Slack previews the link, and the agent reads the
    // channel itself when a turn asks it to.
    assert.doesNotMatch(posts[0]!.text, /the deploy is failing/);
    assert.doesNotMatch(posts[0]!.text, /^>/m);
    // A way back: a private conversation about a thread nobody can find is one a
    // member cannot place a week later.
    assert.match(posts[0]!.text, /<#C-incidents>/);
    // Built from the mention's own ts, not the thread's first message: Slack
    // previews whatever the link names, and the ask is what a member wants back.
    assert.ok(
      posts[0]!.text.includes(`<${linkTo(MENTION.channel, MENTION.ts)}|open the thread>`),
      posts[0]!.text,
    );

    // The turn names the thread it came from — what a later share-back posts into,
    // and now also what a turn reads its context from.
    assert.equal(turns[0]!.sourceThread, '100.0');
    assert.equal(turns[0]!.slackEventId, 'Ev-1');
  });

  it('still hands the thread over when Slack will not give it a link', async () => {
    // The link is how a member gets back to the channel, not why the handoff
    // happens.
    const { deps, posts } = harness({ link: null });
    assert.equal(await handleMention(MENTION, deps), 'opened');
    assert.match(posts[0]!.text, /^Picked this up from <#C-incidents>\. Working privately/);
  });

  it('continues the thread it already has rather than opening a second', async () => {
    const existing = {
      id: 'conv-1',
      dmChannel: 'D-nel',
      rootThread: '200.0',
      seenThroughTs: '100.0',
    };
    const { deps, posts } = harness({ existing });
    assert.equal(await handleMention(MENTION, deps), 'continued');

    // In the DM root the member is already looking at (§4, amended), confirming
    // the mention registered. What was added to the channel reaches the agent on
    // the next turn, so there is nothing to relay.
    assert.equal(posts[0]!.channel, 'D-nel');
    assert.equal(posts[0]!.threadTs, '200.0');
    assert.equal(posts[0]!.text, 'Picked that up too — carry on here.');
  });

  it('says nothing twice when Slack redelivers a mention', async () => {
    // The turn is recorded before anything is posted, so a redelivery that the
    // gateway has already seen produces silence rather than a second message.
    const existing = { id: 'conv-1', dmChannel: 'D-nel', rootThread: '200.0' };
    const { deps, posts, turns, links } = harness({ existing });
    // The gateway answers with no turn, which is a Slack event it has recorded
    // before.
    deps.turn = (spec) => {
      turns.push(spec);
      return Promise.resolve({ conversation: existing });
    };
    assert.equal(await handleMention(MENTION, deps), 'already handled');
    assert.deepEqual(posts, []);
    assert.equal(turns.length, 1, 'it still asked, which is how it found out');
    assert.deepEqual(links, [], 'and paid Slack for nothing it was going to post');
  });

  it('asks to be invited rather than answering from a channel it cannot read', async () => {
    // §4: when the bot is not in a private channel, say so. Answering from a
    // partial snapshot would look like a complete answer.
    const { deps, posts, turns } = harness({ replies: undefined });
    assert.equal(await handleMention(MENTION, deps), 'unreadable channel');
    assert.equal(posts[0]!.channel, 'D-nel');
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
    const { deps, posts } = harness({ rootThread: '999.0' });
    assert.equal(await handleMention(MENTION, deps), 'adopted');

    // Three messages: the stray root already posted, the correction telling the
    // member it is not the live one, and the work in the thread that is. Without
    // the correction they are left with two threads both claiming to be working.
    assert.equal(posts.length, 3);
    assert.equal(posts[1]!.threadTs, '200.0', 'the correction lands in the stray');
    assert.match(posts[1]!.text, /carry on in the other thread/);
    assert.equal(posts[2]!.threadTs, '999.0', 'and the work in the winner');
  });
});
