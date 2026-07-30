import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TurnTarget } from '@symma/protocol';

import { handleDm, isMemberDm, type DmDeps, type RunSpec } from '../src/dm.js';
import type { ConversationRef } from '../src/mention.js';

const CONVERSATION: ConversationRef = { id: 'conv-1', dmChannel: 'D-nel', rootThread: '200.0' };
const READY: TurnTarget = {
  endpoint: 'ep-1',
  device: 'the studio Mac',
  state: 'ready',
  agent: 'kilo',
  token: 'tok-1',
};

function harness(
  over: {
    existing?: ConversationRef;
    turn?: boolean;
    endpoint?: TurnTarget | null;
    answer?: string;
    fails?: Error;
  } = {},
) {
  const posts: { channel: string; text: string; threadTs?: string }[] = [];
  const turns: Record<string, unknown>[] = [];
  const runs: RunSpec[] = [];
  let asked = 0;
  // Absent is a machine that is there; `null` is a member who has paired none,
  // which is a different answer from one whose laptop is shut.
  const selected = over.endpoint === undefined ? READY : over.endpoint;
  const deps: DmDeps = {
    log: () => {},
    run: (spec) => {
      runs.push(spec);
      return over.fails ? Promise.reject(over.fails) : Promise.resolve(over.answer ?? 'the answer');
    },
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
  return { deps, posts, turns, runs, asked: () => asked };
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
      { channel: 'D-nel', ts: '250.0', threadTs: '200.0', eventId: 'Ev-1', text: 'what broke?' },
      deps,
    );
    assert.equal(outcome, 'resumed');
    // Raft's exact-target rule: the reply goes to the root the member replied
    // under, not to whatever conversation they touched last.
    assert.equal(turns[0]!.rootThread, '200.0');
    assert.deepEqual(
      posts.map((p) => `${p.channel}/${String(p.threadTs)}`),
      ['D-nel/200.0', 'D-nel/200.0'],
      'the acknowledgement and the answer both land under that root',
    );
  });

  it('opens one for a top-level DM, rooted at that message', async () => {
    // §4: a top-level DM opens a conversation with no source. Its root is the
    // member's own message, which is what their replies will thread under.
    const { deps, turns } = harness();
    assert.equal(
      await handleDm({ channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' }, deps),
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
      await handleDm(
        { channel: 'D-nel', ts: '250.0', threadTs: '111.0', eventId: 'Ev-1', text: 'what broke?' },
        deps,
      ),
      'opened',
    );
    // Rooted at the thread, so it joins whatever that root becomes rather than
    // starting a second conversation beside it.
    assert.equal(turns[0]!.rootThread, '111.0');
    assert.equal(posts.length, 2, 'acknowledged, then answered');
  });

  it('says nothing twice when Slack redelivers', async () => {
    const { deps, posts, asked } = harness({ existing: CONVERSATION, turn: false });
    assert.equal(
      await handleDm(
        { channel: 'D-nel', ts: '250.0', threadTs: '200.0', eventId: 'Ev-1', text: 'what broke?' },
        deps,
      ),
      'already handled',
    );
    assert.deepEqual(posts, [], 'the turn is recorded before the post, so a repeat is silent');
    assert.equal(asked(), 0, 'and it costs the gateway nothing to find that out');
  });

  it('runs the question on the member’s own machine and posts what came back', async () => {
    const { deps, posts, runs } = harness({ answer: 'the deploy fails on a missing env var' });
    assert.equal(
      await handleDm({ channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' }, deps),
      'opened',
    );
    // Their words, their machine, their credentials — and the conversation is
    // the run, so a member's thread stays one thing in the journal and viewer.
    assert.deepEqual(runs, [
      {
        conversation: 'conv-1',
        endpoint: 'ep-1',
        agent: 'kilo',
        token: 'tok-1',
        prompt: 'what broke?',
      },
    ]);
    assert.equal(posts.at(-1)!.text, 'the deploy fails on a missing env var');
  });

  it('tells a follow-up that it is starting fresh', async () => {
    // §4 would rather say so than pass an empty session off as a resume. Until
    // `session/load` lands, the honest version of "resumed" is a sentence.
    const { deps, posts } = harness({ existing: CONVERSATION });
    await handleDm(
      { channel: 'D-nel', ts: '250.0', threadTs: '200.0', eventId: 'Ev-1', text: 'and now?' },
      deps,
    );
    assert.match(posts[0]!.text, /its own session/);

    const first = harness();
    await handleDm(
      { channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
      first.deps,
    );
    assert.doesNotMatch(first.posts[0]!.text, /its own session/, 'nothing to have forgotten yet');
  });

  it('does not spend a laptop on a message with no question in it', async () => {
    // A file with no caption is an ordinary Slack message and an empty prompt.
    const { deps, posts, runs, asked } = harness();
    assert.equal(
      await handleDm({ channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: '   ' }, deps),
      'nothing to ask',
    );
    assert.deepEqual(runs, []);
    assert.equal(asked(), 0, 'and mints no token to find that out');
    assert.match(posts[0]!.text, /Send me a question/);
  });

  it('says a run failed in the thread that was waiting on it', async () => {
    // The socket's own catch answers at the DM root, which is not where this
    // member is looking — so silence in the thread is what they would get.
    const { deps, posts } = harness({ fails: new Error('endpoint went away') });
    assert.equal(
      await handleDm({ channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' }, deps),
      'failed',
    );
    assert.match(posts.at(-1)!.text, /did not finish/);
    assert.equal(posts.at(-1)!.threadTs, '200.0');
  });

  it('has something to post when the run produced nothing', async () => {
    // Slack refuses an empty message, so posting the answer straight through
    // would turn a quiet success into a reported failure.
    const { deps, posts } = harness({ answer: '  ' });
    assert.equal(
      await handleDm({ channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' }, deps),
      'opened',
    );
    assert.match(posts.at(-1)!.text, /without producing an answer/);
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
        await handleDm(
          { channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
          deps,
        ),
        outcome,
      );
      assert.match(posts[0]!.text, says, state);
      assert.match(posts[0]!.text, /the studio Mac/, `${state} names the machine`);
    }
  });

  it('refuses a machine that is there but has nothing to run', async () => {
    // Ready and still unusable: the companion advertised no agent, or no token
    // came back. Neither is something the member can act on, so the honest
    // answer is short — and it must not read as "go" for want of a refusal.
    const bare: TurnTarget = { endpoint: 'ep-1', device: 'the studio Mac', state: 'ready' };
    const { deps, posts, runs } = harness({ endpoint: bare });
    assert.equal(
      await handleDm({ channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' }, deps),
      'refused: unusable',
    );
    assert.deepEqual(runs, []);
    assert.match(posts[0]!.text, /not available right now/);
  });

  it('refuses a state this build has never heard of', async () => {
    // A gateway one release ahead. The union is a compile-time claim about the
    // wire, so the cast is the point: a deploy skew is when it stops holding,
    // and throwing here would take out every DM until the bot caught up.
    const ahead = { ...READY, state: 'hibernating' } as unknown as TurnTarget;
    const { deps, posts } = harness({ endpoint: ahead });
    assert.equal(
      String(
        await handleDm(
          { channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
          deps,
        ),
      ),
      'refused: hibernating',
    );
    assert.match(posts[0]!.text, /not available right now/);
  });

  it('has words for a machine that never said what it is called', async () => {
    // `device_name` defaults to empty and the row exists from the moment of
    // pairing, so this is the ordinary state of one that has not started — not
    // an edge case, and not somewhere to leave a sentence with a hole in it.
    const { deps, posts } = harness({ endpoint: { ...READY, device: '', state: 'unstarted' } });
    await handleDm({ channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' }, deps);
    assert.match(posts[0]!.text, /from your machine\b/);
  });

  it('sends a member who has paired nothing to /connect', async () => {
    // Not a machine that is away — there is none. Naming a device here would be
    // naming one they never had.
    const { deps, posts } = harness({ endpoint: null });
    assert.equal(
      await handleDm({ channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' }, deps),
      'refused: unpaired',
    );
    assert.match(posts[0]!.text, /`\/connect`/);
  });

  it('still records the turn when it refuses', async () => {
    // The event was answered, so a redelivery must not answer it again — the
    // refusal is a reply like any other.
    const { deps, turns } = harness({ endpoint: { ...READY, state: 'asleep' } });
    await handleDm({ channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' }, deps);
    assert.equal(turns.length, 1);
  });
});
