import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SessionModes, TurnTarget } from '@symma/protocol';

import { handleDm, isMemberDm, type DmDeps, type RunSpec } from '../src/dm.js';
import type { ThreadMessage } from '../src/snapshot.js';
import type { ConversationRef } from '../src/mention.js';
import type { MarkState } from '../src/slack-api.js';

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
    /** The thread is still working on the message before this one. */
    busy?: boolean;
    endpoint?: TurnTarget | null;
    answer?: string;
    notices?: string[];
    /** The roster the run came back with, for the picker. */
    modes?: SessionModes;
    fails?: Error;
    /** The DM thread a follow-up is caught up from; `null` is a channel the bot
     * cannot read. */
    history?: ThreadMessage[] | null;
    /** A thread read that throws rather than coming back empty — a page cap, a
     * transient Slack error. */
    historyFails?: Error;
    budgetBytes?: number;
    /** Fails the answer post, which lands after the run is already over. */
    answerPostFails?: Error;
    /** Fails every post, including the one an early exit says its piece with. */
    postFails?: Error;
    /** Where a share would land; absent is a conversation opened in the DM. */
    destination?: { channel: string; thread: string };
  } = {},
) {
  const posts: {
    channel: string;
    text: string;
    threadTs?: string;
    offerShare?: { conversation: string; destination: string };
    notices?: string[];
    modePicker?: { conversation: string; modes: SessionModes };
  }[] = [];
  const turns: Record<string, unknown>[] = [];
  const runs: RunSpec[] = [];
  const marks: { channel: string; ts: string; state: MarkState }[] = [];
  const finished: Record<string, string>[] = [];
  const sheds: string[] = [];
  let asked = 0;
  const askedFor: string[] = [];
  // Absent is a machine that is there; `null` is a member who has paired none,
  // which is a different answer from one whose laptop is shut.
  const selected = over.endpoint === undefined ? READY : over.endpoint;
  const deps: DmDeps = {
    budgetBytes: over.budgetBytes ?? 24_000,
    threadReplies: () =>
      over.historyFails
        ? Promise.reject(over.historyFails)
        : Promise.resolve(over.history === null ? undefined : (over.history ?? [])),
    log: () => {},
    run: (spec) => {
      runs.push(spec);
      return over.fails
        ? Promise.reject(over.fails)
        : Promise.resolve({
            text: over.answer ?? 'the answer',
            notices: over.notices ?? [],
            session: 'acp-1',
            ...(over.modes ? { modes: over.modes } : {}),
          });
    },
    find: () => Promise.resolve(over.existing),
    post: (channel, text, threadTs, offerShare, notices, modePicker) => {
      posts.push({
        channel,
        text,
        ...(threadTs ? { threadTs } : {}),
        ...(offerShare ? { offerShare } : {}),
        ...(notices?.length ? { notices } : {}),
        ...(modePicker ? { modePicker } : {}),
      });
      if (over.postFails) return Promise.reject(over.postFails);
      // The acknowledgement is always first; anything later is the answer.
      return over.answerPostFails && posts.length > 1
        ? Promise.reject(over.answerPostFails)
        : Promise.resolve({ channel, ts: '300.0' });
    },
    destination: () => Promise.resolve(over.destination),
    finish: (conversation, turn, status, ran) => {
      finished.push({ conversation, turn, status, ...ran });
      return Promise.resolve();
    },
    shedMode: (conversation) => {
      sheds.push(conversation);
      return Promise.resolve();
    },
    mark: (channel, ts, state) => {
      marks.push({ channel, ts, state });
      return Promise.resolve();
    },
    turn: (spec) => {
      turns.push(spec);
      return Promise.resolve({
        conversation: over.existing ?? CONVERSATION,
        // Neither refusal carries a turn, which is what the gateway sends and
        // what a harness handing back both would hide.
        ...(over.busy
          ? { refused: 'busy' as const }
          : over.turn === false
            ? { refused: 'duplicate' as const }
            : { turn: 'turn-1' }),
      });
    },
    endpoint: (conversation) => {
      asked += 1;
      askedFor.push(conversation);
      return Promise.resolve(selected ?? undefined);
    },
  };
  return { deps, posts, turns, runs, marks, finished, sheds, askedFor, asked: () => asked };
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

  it('waits rather than running a second turn beside the first', async () => {
    // Two at once fork the agent session the thread is carried on, and neither
    // half then holds the whole conversation.
    const { deps, posts, runs, asked } = harness({ existing: CONVERSATION, busy: true });
    assert.equal(
      await handleDm(
        { channel: 'D-nel', ts: '250.0', threadTs: '200.0', eventId: 'Ev-1', text: 'and now?' },
        deps,
      ),
      'still working',
    );
    assert.match(posts[0]!.text, /Still working on your last one/);
    assert.deepEqual(runs, []);
    // And it costs the gateway no credential to find that out.
    assert.equal(asked(), 0);
  });

  it('closes the turn on every way out, or the thread stays busy forever', async () => {
    const ask = { channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' };
    for (const [why, over, message, status] of [
      ['nothing to ask', {}, { ...ask, text: '  ' }, 'cancelled'],
      ['refused', { endpoint: null }, ask, 'cancelled'],
      ['the run failed', { fails: new Error('gone') }, ask, 'failed'],
    ] as const) {
      const { deps, finished } = harness(over);
      await handleDm(message, deps);
      assert.deepEqual(
        finished.map((f) => f.status),
        [status],
        why,
      );
    }

    // Including when the message saying so does not land: the turn is decided
    // by then, and holding the thread until it goes stale is the worse half.
    const refused = harness({ endpoint: null, postFails: new Error('slack refused it') });
    await assert.rejects(handleDm(ask, refused.deps));
    assert.equal(refused.finished[0]!.status, 'cancelled');

    // And the one that leaves through `announcing`: the answer landed, so the
    // turn is over whether or not the member was told.
    const { deps, finished } = harness({ answerPostFails: new Error('slack refused it') });
    await assert.rejects(handleDm(ask, deps));
    assert.equal(finished[0]!.status, 'completed');
  });

  it('runs the question on the member’s own machine and posts what came back', async () => {
    const { deps, posts, runs } = harness({ answer: 'the deploy fails on a missing env var' });
    assert.equal(
      await handleDm({ channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' }, deps),
      'opened',
    );
    // Their words on their own machine, and the conversation is the run — so a
    // member's thread stays one thing in the journal and viewer.
    assert.deepEqual(runs, [
      {
        conversation: 'conv-1',
        endpoint: 'ep-1',
        agent: 'kilo',
        token: 'tok-1',
        prompt: 'what broke?',
        model: 'kilo/default',
      },
    ]);
    assert.equal(posts.at(-1)!.text, 'the deploy fails on a missing env var');
    // Said up front, not discovered: until `hello.workspaces[]` lands the agent
    // opens in an empty temp dir, which is not what "your own machine" sounds
    // like to someone asking about their repo.
    assert.match(posts[0]!.text, /no access to your files/);
  });

  it('runs in the conversation mode and offers the picker with the answer', async () => {
    const roster: SessionModes = {
      currentModeId: 'agent',
      availableModes: [
        { id: 'read-only', name: 'Read-only' },
        { id: 'agent', name: 'Agent' },
      ],
    };
    const { deps, posts, runs } = harness({
      existing: CONVERSATION,
      endpoint: { ...READY, workspace: 'ws-1', workspaceLabel: 'symma', mode: 'agent' },
      modes: roster,
    });
    await handleDm(
      { channel: 'D-nel', ts: '250.0', threadTs: '200.0', eventId: 'Ev-1', text: 'change it' },
      deps,
    );
    assert.equal(runs[0]!.mode, 'agent');
    // Read back on every turn — the member should never have to remember what
    // tier their own machine is running at.
    assert.match(posts[0]!.text, /in `symma` — `agent` mode/);
    assert.deepEqual(posts[1]!.modePicker, { conversation: 'conv-1', modes: roster });
  });

  it('names read-only for a workspace turn that picked nothing, picker included', async () => {
    const roster: SessionModes = {
      currentModeId: 'read-only',
      availableModes: [{ id: 'read-only' }, { id: 'agent' }],
    };
    const { deps, posts, runs } = harness({
      existing: CONVERSATION,
      endpoint: { ...READY, workspace: 'ws-1', workspaceLabel: 'symma' },
      modes: roster,
    });
    await handleDm(
      { channel: 'D-nel', ts: '250.0', threadTs: '200.0', eventId: 'Ev-1', text: 'look' },
      deps,
    );
    // Absent mode still runs read-only, and the tier is said, not implied.
    assert.equal(runs[0]!.mode, undefined);
    assert.match(posts[0]!.text, /in `symma` — `read-only` mode/);
    // The first workspace turn is exactly where the picker has to appear, or
    // there is no way to ever leave read-only.
    assert.deepEqual(posts[1]!.modePicker, { conversation: 'conv-1', modes: roster });
  });

  it('sheds a mode the agent stopped offering, and says so', async () => {
    const { deps, posts, sheds, finished } = harness({
      existing: CONVERSATION,
      endpoint: { ...READY, workspace: 'ws-1', workspaceLabel: 'symma', mode: 'yolo' },
      fails: new Error('acp:codex slack-conv-1: mode yolo not offered (offers: read-only, agent)'),
    });
    await handleDm(
      { channel: 'D-nel', ts: '250.0', threadTs: '200.0', eventId: 'Ev-1', text: 'go' },
      deps,
    );
    // Without the shed this thread fails every turn from here on: the picker
    // that could fix it only rides answers, and there is no answer.
    assert.deepEqual(sheds, ['conv-1']);
    assert.match(posts[1]!.text, /no longer offers `yolo` mode.*retry read-only/);
    assert.equal(finished[0]!.status, 'failed');
  });

  it('offers no picker outside a named workspace, wherever the roster came from', async () => {
    // A temp-dir session can serve a roster too; rendering a picker for it
    // would offer a mode the companion is guaranteed to refuse.
    const { deps, posts } = harness({
      existing: CONVERSATION,
      modes: { currentModeId: 'read-only', availableModes: [{ id: 'read-only' }] },
    });
    await handleDm(
      { channel: 'D-nel', ts: '250.0', threadTs: '200.0', eventId: 'Ev-1', text: 'hi' },
      deps,
    );
    assert.equal(posts[1]!.modePicker, undefined);
  });

  it('names the model as `provider/model`, which is the only shape that parses', async () => {
    // Every spec runs the string through `parseModelName` and reads the half
    // after the slash, so a bare `default` is refused before any agent sees it —
    // `Invalid model "default"; expected "provider/model"`. The prefix is not
    // read by anything, so the agent's own name is the honest one to use.
    const { deps, runs } = harness();
    await handleDm({ channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' }, deps);

    assert.equal(runs[0]!.model, 'kilo/default');
  });

  it('names the project the answer is about, and runs the turn there', async () => {
    // §4 wants the scope in the DM root rather than guessed at: a member who
    // cannot see which checkout answered cannot tell a stale answer from a
    // wrong one. The id goes to the companion; the label is for them.
    const { deps, posts, runs, askedFor } = harness({
      endpoint: { ...READY, workspace: 'ws-abc123', workspaceLabel: 'symma' },
    });
    await handleDm({ channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' }, deps);

    assert.match(posts[0]!.text, /in `symma`/);
    assert.doesNotMatch(posts[0]!.text, /no access to your files/);
    assert.equal(runs[0]!.workspace, 'ws-abc123');
    // The gateway cannot prefer this thread's project without being told which
    // thread is asking.
    assert.deepEqual(askedFor, ['conv-1']);
  });

  it('does not let a directory name close the span it is shown in', async () => {
    // A label is `basename` of a real directory, and a backtick in one would end
    // the code span early and spill the rest of the sentence into it.
    const { deps, posts } = harness({
      endpoint: { ...READY, workspace: 'ws-1', workspaceLabel: 'we`ird' },
    });
    await handleDm({ channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' }, deps);

    assert.match(posts[0]!.text, /in `weird` — `read-only` mode\./);
    // Two spans — label and mode — each opened and closed; the mode span is
    // safe by the wire's alphabet, so only the label needed stripping.
    assert.equal(posts[0]!.text.split('`').length - 1, 4, 'both spans opened and closed');
  });

  it('catches a follow-up up from the thread, and says what that is worth', async () => {
    // Slack returns the whole thread, so the message being handled is in it too
    // — the same ts the handler was called with.
    const history: ThreadMessage[] = [
      { ts: '200.0', author: 'U-nel', text: 'why is the deploy failing?' },
      { ts: '201.0', author: 'B-symma', text: 'a missing env var' },
      { ts: '250.0', author: 'U-nel', text: 'and now?' },
    ];
    const { deps, posts, runs } = harness({ existing: CONVERSATION, history });
    await handleDm(
      { channel: 'D-nel', ts: '250.0', threadTs: '200.0', eventId: 'Ev-1', text: 'and now?' },
      deps,
    );

    assert.match(posts[0]!.text, /Catching it up from this thread/);
    // Apart from the question, because whether the agent still holds the
    // session is not known until it has been asked — the driver drops one or
    // the other once it does.
    assert.equal(runs[0]!.prompt, 'and now?');
    assert.match(runs[0]!.context!, /why is the deploy failing\?/);
    assert.match(runs[0]!.context!, /transcript, not/);
    // Once, not twice: the thread above contains it and so does the question.
    assert.equal(runs[0]!.context!.match(/and now\?/g)?.length, undefined);
  });

  it('says how much of the thread did not fit', async () => {
    // The budget is a ceiling with an honest account of what it cut (§4) — a
    // member who cannot see that some of it was dropped reads a partial answer
    // as a wrong one.
    const history: ThreadMessage[] = Array.from({ length: 6 }, (_, i) => ({
      ts: `20${i}.0`,
      author: 'U-nel',
      text: `message number ${i}`,
    }));
    const { deps, posts } = harness({ existing: CONVERSATION, history, budgetBytes: 90 });
    await handleDm(
      { channel: 'D-nel', ts: '250.0', threadTs: '200.0', eventId: 'Ev-1', text: 'and now?' },
      deps,
    );
    assert.match(posts[0]!.text, /earlier messages that did not fit/);
  });

  it('answers without history rather than not at all', async () => {
    // A channel the bot cannot read is not a reason to refuse the turn: an
    // answer with no memory beats a member waiting on nothing.
    const { deps, posts, runs } = harness({ existing: CONVERSATION, history: null });
    assert.equal(
      await handleDm(
        { channel: 'D-nel', ts: '250.0', threadTs: '200.0', eventId: 'Ev-1', text: 'and now?' },
        deps,
      ),
      'resumed',
    );
    assert.equal(runs[0]!.prompt, 'and now?');
    assert.doesNotMatch(posts[0]!.text, /Catching it up/);
  });

  it('answers when the thread read throws, not just when it comes back empty', async () => {
    // Invariant 2: catch-up is context, not the answer. `threadReplies` throws
    // past its page cap — which a long conversation is exactly how you reach —
    // and that must not be the thing that stops a member's question running.
    const { deps, posts, runs } = harness({
      existing: CONVERSATION,
      historyFails: new Error('thread too long to read'),
    });
    assert.equal(
      await handleDm(
        { channel: 'D-nel', ts: '250.0', threadTs: '200.0', eventId: 'Ev-1', text: 'and now?' },
        deps,
      ),
      'resumed',
    );
    assert.equal(runs[0]!.prompt, 'and now?');
    assert.equal(posts.at(-1)!.text, 'the answer');
  });

  it('passes the agent’s asides through as asides, not as the answer', async () => {
    const { deps, posts } = harness({
      answer: 'the deploy fails on a missing env var',
      notices: ['Warning: skill descriptions were shortened.'],
    });
    await handleDm({ channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' }, deps);
    const answered = posts.at(-1)!;
    assert.equal(answered.text, 'the deploy fails on a missing env var');
    assert.deepEqual(answered.notices, ['Warning: skill descriptions were shortened.']);
  });

  it('carries a resume the gateway offered, and remembers where the turn ran', async () => {
    const { deps, posts, runs, finished } = harness({
      existing: CONVERSATION,
      endpoint: { ...READY, workspace: 'ws-1', resume: 'acp-0' },
      history: [{ ts: '210.0', author: 'U-nel', text: 'why is the deploy failing?' }],
    });
    await handleDm(
      { channel: 'D-nel', ts: '250.0', threadTs: '200.0', eventId: 'Ev-1', text: 'and now?' },
      deps,
    );
    assert.equal(runs[0]!.resume, 'acp-0');
    // The thread goes too: the offer is not the outcome, and a resume that the
    // agent refuses would otherwise arrive with nothing.
    assert.match(runs[0]!.context!, /why is the deploy failing/);
    assert.match(posts[0]!.text, /Picking up where it left off/);
    // Against what it ran under, since an id means nothing on another machine.
    assert.deepEqual(finished, [
      {
        conversation: 'conv-1',
        status: 'completed',
        turn: 'turn-1',
        session: 'acp-1',
        endpoint: 'ep-1',
        agent: 'kilo',
        workspace: 'ws-1',
      },
    ]);
  });

  it('offers a share only when there is a thread to share back to', async () => {
    // §5: the answer is a private draft and the button is the only way it
    // leaves. One that began in the DM has nowhere to go, so it is offered
    // nothing rather than a button that would refuse itself.
    const from = harness({ destination: { channel: 'C-incidents', thread: '100.0' } });
    await handleDm(
      { channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
      from.deps,
    );
    assert.deepEqual(from.posts.at(-1)!.offerShare, {
      conversation: 'conv-1',
      destination: '<#C-incidents>',
    });

    const own = harness();
    await handleDm(
      { channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
      own.deps,
    );
    assert.equal(own.posts.at(-1)!.offerShare, undefined);
  });

  it('does not spend a laptop on a message with no question in it', async () => {
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

  it('marks the member’s own message for the length of the run', async () => {
    // Slack offers no way to disable the composer and a run takes minutes, so
    // the mark is all that stands between a member and a silence that reads as
    // nothing happening. It goes on their message — the acknowledgement is at
    // '300.0', and marking that would put it where they are not looking.
    const { deps, marks } = harness();
    await handleDm({ channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' }, deps);
    assert.deepEqual(marks, [
      { channel: 'D-nel', ts: '250.0', state: 'working' },
      { channel: 'D-nel', ts: '250.0', state: 'done' },
    ]);
  });

  it('marks anything that goes wrong failed, rather than leaving it running', async () => {
    const states = (marks: { state: MarkState }[]) => marks.map((m) => m.state);
    const ask = { channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' };

    const ran = harness({ fails: new Error('endpoint went away') });
    await handleDm(ask, ran.deps);
    assert.deepEqual(states(ran.marks), ['working', 'failed']);

    // The run landed and Slack refused the answer, so this one leaves through
    // `announcing`. A 👀 that outlives its retry message would be the last
    // thing the member is told about a turn that is already over.
    const posted = harness({ answerPostFails: new Error('slack refused it') });
    await assert.rejects(handleDm(ask, posted.deps));
    assert.deepEqual(states(posted.marks), ['working', 'failed']);
  });

  it('leaves a turn it never ran unmarked', async () => {
    // Everything refused answers in words, immediately — and a ✅ on a message
    // that was turned away is a lie about what happened to it.
    const refused = harness({ endpoint: null });
    await handleDm(
      { channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
      refused.deps,
    );
    assert.deepEqual(refused.marks, []);

    const empty = harness();
    await handleDm({ channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: '  ' }, empty.deps);
    assert.deepEqual(empty.marks, []);
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
      { state: 'busy', outcome: 'refused: busy', says: /already running/ },
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
    // came back. Neither is something the member can act on, so the answer is
    // short — and this must not read as "go" for want of a refusal.
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
