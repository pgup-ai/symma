import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SelectedEndpoint } from '@symma/protocol';

import { handleDm, isMemberDm, type DmDeps } from '../src/dm.js';
import type { ConversationRef } from '../src/mention.js';

const CONVERSATION: ConversationRef = { id: 'conv-1', dmChannel: 'D-nel', rootThread: '200.0' };
const READY: SelectedEndpoint = { endpoint: 'ep-1', device: 'the studio Mac', state: 'ready' };

function harness(
  over: { existing?: ConversationRef; turn?: boolean; endpoint?: SelectedEndpoint | null } = {},
) {
  const posts: { channel: string; text: string; threadTs?: string }[] = [];
  const turns: Record<string, unknown>[] = [];
  let asked = 0;
  // Absent is a machine that is there; `null` is a member who has paired none,
  // which is a different answer from one whose laptop is shut.
  const selected = over.endpoint === undefined ? READY : over.endpoint;
  const deps: DmDeps = {
    find: () => Promise.resolve(over.existing),
    post: (channel, text, threadTs) => {
      posts.push({ channel, text, ...(threadTs ? { threadTs } : {}) });
      return Promise.resolve({ channel, ts: '300.0' });
    },
    turn: (spec) => {
      turns.push(spec);
      return Promise.resolve({
        conversation: over.existing ?? CONVERSATION,
        ...(over.turn === false ? {} : { turn: 'turn-1' }),
      });
    },
    endpoint: () => {
      asked += 1;
      return Promise.resolve(selected ?? undefined);
    },
  };
  return { deps, posts, turns, asked: () => asked };
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
      { channel: 'D-nel', ts: '250.0', threadTs: '200.0', eventId: 'Ev-1' },
      deps,
    );
    assert.equal(outcome, 'resumed');
    // Raft's exact-target rule: the reply goes to the root the member replied
    // under, not to whatever conversation they touched last.
    assert.equal(turns[0]!.rootThread, '200.0');
    assert.deepEqual(
      posts.map(({ channel, threadTs }) => ({ channel, threadTs })),
      [{ channel: 'D-nel', threadTs: '200.0' }],
    );
  });

  it('opens one for a top-level DM, rooted at that message', async () => {
    // §4: a top-level DM opens a conversation with no source. Its root is the
    // member's own message, which is what their replies will thread under.
    const { deps, turns } = harness();
    assert.equal(
      await handleDm({ channel: 'D-nel', ts: '250.0', eventId: 'Ev-1' }, deps),
      'opened',
    );
    // The whole spec, not one absent key: asserting `sourceChannel === undefined`
    // on a field the handler never sets could not have failed.
    assert.deepEqual(turns[0], {
      dmChannel: 'D-nel',
      rootThread: '250.0',
      slackEventId: 'Ev-1',
    });
  });

  it('answers a reply whose root it has not seen yet', async () => {
    // Slack delivers concurrently, so a reply sent straight after its root can
    // arrive while that root is still being opened. Ignoring it would drop a real
    // message, and being ignored is the one answer a member cannot see.
    const { deps, posts, turns } = harness();
    assert.equal(
      await handleDm({ channel: 'D-nel', ts: '250.0', threadTs: '111.0', eventId: 'Ev-1' }, deps),
      'opened',
    );
    // Rooted at the thread, so it joins whatever that root becomes rather than
    // starting a second conversation beside it.
    assert.equal(turns[0]!.rootThread, '111.0');
    assert.equal(posts.length, 1);
  });

  it('says nothing twice when Slack redelivers', async () => {
    const { deps, posts, asked } = harness({ existing: CONVERSATION, turn: false });
    assert.equal(
      await handleDm({ channel: 'D-nel', ts: '250.0', threadTs: '200.0', eventId: 'Ev-1' }, deps),
      'already handled',
    );
    assert.deepEqual(posts, [], 'the turn is recorded before the post, so a repeat is silent');
    assert.equal(asked(), 0, 'and it costs the gateway nothing to find that out');
  });

  it('names the machine and what to do when it is not there', async () => {
    // §3: "asleep" and "never started" are one word to the relay and completely
    // different to a member — one ends by opening a lid, the other never ends.
    // The outcome carries which, so a log answers the support question.
    const cases = [
      { state: 'asleep', outcome: 'refused: asleep', says: /awake/ },
      { state: 'quit', outcome: 'refused: quit', says: /not running/ },
      { state: 'dropped', outcome: 'refused: dropped', says: /shortly/ },
      { state: 'unstarted', outcome: 'refused: unstarted', says: /Run `symma`/ },
    ] as const;

    for (const { state, outcome, says } of cases) {
      const { deps, posts } = harness({ endpoint: { ...READY, state } });
      assert.equal(
        await handleDm({ channel: 'D-nel', ts: '250.0', eventId: 'Ev-1' }, deps),
        outcome,
      );
      assert.match(posts[0]!.text, says, state);
      assert.match(posts[0]!.text, /the studio Mac/, `${state} names the machine`);
    }
  });

  it('has words for a machine that never said what it is called', async () => {
    // `device_name` defaults to empty and the row exists from the moment of
    // pairing, so this is the ordinary state of one that has not started — not
    // an edge case, and not somewhere to leave a sentence with a hole in it.
    const { deps, posts } = harness({ endpoint: { ...READY, device: '', state: 'unstarted' } });
    await handleDm({ channel: 'D-nel', ts: '250.0', eventId: 'Ev-1' }, deps);
    assert.match(posts[0]!.text, /from your machine\b/);
  });

  it('sends a member who has paired nothing to /connect', async () => {
    // Not a machine that is away — there is none. Naming a device here would be
    // naming one they never had.
    const { deps, posts } = harness({ endpoint: null });
    assert.equal(
      await handleDm({ channel: 'D-nel', ts: '250.0', eventId: 'Ev-1' }, deps),
      'refused: unpaired',
    );
    assert.match(posts[0]!.text, /`\/connect`/);
  });

  it('still records the turn when it refuses', async () => {
    // The event was answered, so a redelivery must not answer it again — the
    // refusal is a reply like any other.
    const { deps, turns } = harness({ endpoint: { ...READY, state: 'asleep' } });
    await handleDm({ channel: 'D-nel', ts: '250.0', eventId: 'Ev-1' }, deps);
    assert.equal(turns.length, 1);
  });
});
