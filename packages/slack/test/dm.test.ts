import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SessionModels, SessionModes, TurnTarget, TurnUsage } from '@symma/protocol';

import { handleDm, isMemberDm, type DmDeps, type RunSpec } from '../src/dm.js';
import type { ThreadMessage } from '../src/snapshot.js';
import type { ConversationRef } from '../src/mention.js';
import type { MarkState } from '../src/slack-api.js';

/** Narration is queued rather than sent where it is reported, so a step is a tick
 * away from the update that shows it. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** What the acknowledgement is left saying once the answer has landed: the
 * scope, without the ellipsis that meant a turn was in flight. */
const atRest = (ack: string): string => ack.replace(/…$/, '');

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
    /** The rosters the run came back with, for the pickers. */
    modes?: SessionModes;
    models?: SessionModels;
    /** The gateway refuses the mode clear. */
    shedFails?: boolean;
    /** How the agent's own CLI picks the session up, when it has a command. */
    resumeWith?: string;
    /** What the agent said the turn cost. */
    usage?: TurnUsage;
    /** Files the agent had no block for, as the driver reports them. */
    unsupported?: { name: string; kind: string }[];
    /** What the agent asked permission for, and what the floor answered. */
    approvals?: { title: string; allowed: boolean }[];
    /** A step the run reports while it is still in flight. */
    narrates?: string;
    /** How long each acknowledgement update takes, by call order. */
    updateDelays?: number[];
    /** The first update throws where it stands rather than rejecting. */
    updateThrows?: boolean;
    /** What a file download hands back; absent is a download that fails. */
    fileBytes?: string;
    fails?: Error;
    /** The DM thread a follow-up is caught up from; `null` is a channel the bot
     * cannot read. */
    history?: ThreadMessage[] | null;
    /** A thread read that throws rather than coming back empty — a page cap, a
     * transient Slack error. */
    historyFails?: Error;
    /** This workspace's host, which pasted links are pinned to. */
    host?: string;
    /** Channels the member could not open for themselves. */
    notMine?: string[];
    /** Not public, but the member is in them — a private channel, a group DM. */
    privateMine?: string[];
    /** Channels the bot cannot see at all, so it can say nothing about who is
     * in them. */
    unseen?: string[];
    /** The membership scan fails — a missing scope, a Slack error. */
    scanFails?: boolean;
    /** The workspace's narration budget is gone, spent by other turns. */
    budgetSpent?: boolean;
    /** The source channel thread a mention came out of, for a conversation whose
     * `source` says where to read it. `null` is one the bot cannot read. */
    channel?: ThreadMessage[] | null;
    /** The gateway refuses to move the cursor. */
    seenFails?: boolean;
    budgetBytes?: number;
    /** Fails the answer post, which lands after the run is already over. */
    answerPostFails?: Error;
    /** Fails every post, including the one an early exit says its piece with. */
    postFails?: Error;
    /** Where a share would land; absent is a conversation opened in the DM. */
    destination?: { channel: string; thread: string };
  } = {},
) {
  let scans = 0;
  let narrations = 0;
  const posts: {
    channel: string;
    text: string;
    threadTs?: string;
    offerShare?: { conversation: string; destination: string };
    notices?: string[];
    pickers?: { conversation: string; modes?: SessionModes; models?: SessionModels };
  }[] = [];
  const turns: Record<string, unknown>[] = [];
  const runs: RunSpec[] = [];
  const marks: { channel: string; ts: string; state: MarkState }[] = [];
  const finished: Record<string, string>[] = [];
  const sheds: string[] = [];
  const updates: { channel: string; ts: string; text: string }[] = [];
  /** Acknowledgement updates in the order Slack finished applying them — not the
   * order they were sent — interleaved with the marks and the turn's close, so
   * what the turn waits on and what it has already finished with can be told
   * apart. */
  const timeline: string[] = [];
  /** `conversation:ts` for every cursor move, so a turn that moved it over an
   * answer nobody got is visible. */
  const moved: string[] = [];
  let fetches = 0;
  let asked = 0;
  const askedFor: string[] = [];
  // Absent is a machine that is there; `null` is a member who has paired none,
  // which is a different answer from one whose laptop is shut.
  const selected = over.endpoint === undefined ? READY : over.endpoint;
  const deps: DmDeps = {
    budgetBytes: over.budgetBytes ?? 24_000,

    host: () => Promise.resolve(over.host ?? 'acme.slack.com'),
    // Every channel a test links to is one the member could open, unless it
    // says otherwise — the refusal has its own test.
    visibility: (channel) =>
      Promise.resolve(
        (over.unseen ?? []).includes(channel)
          ? 'unseen'
          : (over.notMine ?? []).concat(over.privateMine ?? []).includes(channel)
            ? 'private'
            : 'public',
      ),
    conversationsOf: () => {
      scans += 1;
      // Undefined is the scan failing, which is not the member being in nothing.
      return Promise.resolve(over.scanFails ? undefined : new Set(over.privateMine ?? []));
    },
    // Two threads: the DM the conversation lives in, and the channel a mention
    // came out of — which is where a turn reads what it is about.
    threadReplies: (channel) => {
      if (channel !== 'D-nel')
        return Promise.resolve(over.channel === null ? undefined : (over.channel ?? []));
      return over.historyFails
        ? Promise.reject(over.historyFails)
        : Promise.resolve(over.history === null ? undefined : (over.history ?? []));
    },
    seen: (conversation, ts) => {
      moved.push(`${conversation}:${ts}`);
      timeline.push(`seen:${ts}`);
      return over.seenFails ? Promise.reject(new Error('gateway away')) : Promise.resolve();
    },
    log: () => {},
    run: (spec) => {
      runs.push(spec);
      if (over.narrates) spec.onProgress?.(over.narrates);
      return over.fails
        ? Promise.reject(over.fails)
        : Promise.resolve({
            text: over.answer ?? 'the answer',
            notices: over.notices ?? [],
            session: 'acp-1',
            ...(over.modes ? { modes: over.modes } : {}),
            ...(over.models ? { models: over.models } : {}),
            ...(over.resumeWith ? { resumeWith: over.resumeWith } : {}),
            ...(over.usage ? { usage: over.usage } : {}),
            ...(over.unsupported ? { unsupported: over.unsupported } : {}),
            ...(over.approvals ? { approvals: over.approvals } : {}),
          });
    },
    find: () => Promise.resolve(over.existing),
    post: (channel, text, threadTs, offerShare, notices, pickers) => {
      posts.push({
        channel,
        text,
        ...(threadTs ? { threadTs } : {}),
        ...(offerShare ? { offerShare } : {}),
        ...(notices?.length ? { notices } : {}),
        ...(pickers ? { pickers } : {}),
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
      timeline.push(`finish:${status}`);
      return Promise.resolve();
    },
    fetchFile: () => {
      fetches += 1;
      return Promise.resolve(
        over.fileBytes === undefined
          ? { ok: false, status: 404 }
          : { ok: true, bytes: Buffer.from(over.fileBytes) },
      );
    },
    mayNarrate: () => {
      narrations += 1;
      return over.budgetSpent !== true;
    },
    working: (channel, ts, text) => {
      updates.push({ channel, ts, text });
      if (over.updateThrows && updates.length === 1) throw new Error('sync');
      // Settles out of call order when asked to, which is the only way a restore
      // that races the narration rather than queueing behind it is visible.
      const delay = over.updateDelays?.[updates.length - 1] ?? 0;
      return new Promise<void>((resolve) => setTimeout(resolve, delay)).then(() => {
        timeline.push(text);
      });
    },
    shedModel: (conversation) => {
      sheds.push(`model:${conversation}`);
      return over.shedFails ? Promise.reject(new Error('gateway away')) : Promise.resolve();
    },
    shedMode: (conversation) => {
      sheds.push(conversation);
      return over.shedFails ? Promise.reject(new Error('gateway away')) : Promise.resolve();
    },
    mark: (channel, ts, state) => {
      marks.push({ channel, ts, state });
      timeline.push(`mark:${state}`);
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
  return {
    deps,
    scans: () => scans,
    narrations: () => narrations,
    posts,
    turns,
    runs,
    marks,
    finished,
    sheds,
    updates,
    timeline,
    moved,
    askedFor,
    asked: () => asked,
    fetches: () => fetches,
  };
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
    // But an upload is filed under a subtype too, and dropping it would mean a
    // member who DMs a CSV gets no answer and no refusal either.
    assert.equal(isMemberDm({ ...member, subtype: 'file_share' }), true);
    // And a channel message is the mention path's business, not this one.
    assert.equal(isMemberDm({ ...member, channel_type: 'channel' }), false);
    for (const missing of ['user', 'channel', 'ts']) {
      assert.equal(isMemberDm({ ...member, [missing]: undefined }), false, missing);
    }
  });

  it('resumes the conversation the thread root names', async () => {
    const { deps, posts, turns } = harness({ existing: CONVERSATION });
    const outcome = await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'what broke?',
      },
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
      await handleDm(
        { user: 'U-nel', channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
        deps,
      ),
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
        {
          user: 'U-nel',
          channel: 'D-nel',
          ts: '250.0',
          threadTs: '111.0',
          eventId: 'Ev-1',
          text: 'what broke?',
        },
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
        {
          user: 'U-nel',
          channel: 'D-nel',
          ts: '250.0',
          threadTs: '200.0',
          eventId: 'Ev-1',
          text: 'what broke?',
        },
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
        {
          user: 'U-nel',
          channel: 'D-nel',
          ts: '250.0',
          threadTs: '200.0',
          eventId: 'Ev-1',
          text: 'and now?',
        },
        deps,
      ),
      'still working',
    );
    // Which thread, said out loud: the rule is per thread, and the refusal is
    // unreadable to a member who cannot tell what is running or where.
    assert.match(posts[0]!.text, /in this thread/);
    assert.deepEqual(runs, []);
    // And it costs the gateway no credential to find that out.
    assert.equal(asked(), 0);
  });

  it('closes the turn on every way out, or the thread stays busy forever', async () => {
    const ask = {
      user: 'U-nel',
      channel: 'D-nel',
      ts: '250.0',
      eventId: 'Ev-1',
      text: 'what broke?',
    };
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
    const { deps, finished, updates } = harness({
      answerPostFails: new Error('slack refused it'),
      narrates: 'Reading dm.ts',
    });
    await assert.rejects(handleDm(ask, deps));
    assert.equal(finished[0]!.status, 'completed');
    // And the acknowledgement stops saying it is working, for the reason the
    // mark does: it would outlive the message that never arrived.
    assert.doesNotMatch(updates.at(-1)!.text, /Reading dm.ts/);
  });

  it('runs the question on the member’s own machine and posts what came back', async () => {
    const { deps, posts, runs } = harness({ answer: 'the deploy fails on a missing env var' });
    assert.equal(
      await handleDm(
        { user: 'U-nel', channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
        deps,
      ),
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
        onProgress: runs[0]!.onProgress,
      },
    ]);
    assert.equal(typeof runs[0]!.onProgress, 'function', 'the run can narrate itself');
    assert.equal(posts.at(-1)!.text, 'the deploy fails on a missing env var');
    // Said up front, not discovered: until `hello.workspaces[]` lands the agent
    // opens in an empty temp dir, which is not what "your own machine" sounds
    // like to someone asking about their repo.
    assert.match(posts[0]!.text, /cannot see your files/);
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
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'change it',
      },
      deps,
    );
    assert.equal(runs[0]!.mode, 'agent');
    // Read back on every turn — the member should never have to remember what
    // tier their own machine is running at.
    assert.match(posts[0]!.text, /^`symma` · `agent`/);
    assert.deepEqual(posts[1]!.pickers, { conversation: 'conv-1', agent: 'kilo', modes: roster });
  });

  it('runs the picked model and narrates the agent onto its own acknowledgement', async () => {
    const models: SessionModels = {
      currentModelId: 'gpt-5.4-mini[low]',
      availableModels: [{ modelId: 'gpt-5.4-mini[low]' }, { modelId: 'gpt-5.6-sol[high]' }],
    };
    const { deps, posts, runs, updates } = harness({
      existing: CONVERSATION,
      endpoint: {
        ...READY,
        agent: 'codex',
        workspace: 'ws-1',
        workspaceLabel: 'symma',
        model: 'gpt-5.4-mini[low]',
      },
      models,
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'go',
      },
      deps,
    );
    // `provider/model` is the only shape the specs parse, brackets and all.
    assert.equal(runs[0]!.model, 'codex/gpt-5.4-mini[low]');
    // No ellipsis where the acknowledgement is only the scope: nothing is in
    // flight to be about, and the line reads the same after the answer lands as
    // it does now. The narration goes onto this same message, not a second post.
    assert.equal(posts[0]!.text, '`symma` · `read-only`');
    runs[0]!.onProgress!('Reading dm.ts');
    await flush();
    assert.deepEqual(updates, [
      { channel: 'D-nel', ts: '300.0', text: `${posts[0]!.text}\n\n_Reading dm.ts_` },
    ]);
    // Throttled: a turn narrating every file read would spend the rate limit on
    // frames nobody reads.
    runs[0]!.onProgress!('Running git log');
    await flush();
    assert.equal(updates.length, 1);
    assert.deepEqual(posts[1]!.pickers, { conversation: 'conv-1', agent: 'codex', models });
  });

  it('offers the session it is picking up, beside the scope it runs in', async () => {
    // The offer rides the same message as the scope and says "if it still can":
    // whether the agent still holds that session is not known until it is asked.
    const { deps, posts } = harness({
      existing: CONVERSATION,
      endpoint: {
        ...READY,
        workspace: 'ws-1',
        workspaceLabel: 'symma',
        mode: 'agent-full-access',
        resume: 'acp-1',
      },
      resumeWith: 'codex resume',
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'and now?',
      },
      deps,
    );
    assert.equal(
      posts[0]!.text,
      '`symma` · `agent-full-access` Picking up where it left off, if it still can…',
    );
    // The harness records an aside list only when there is one, so an answer with
    // nothing to add carries no key at all.
    assert.equal(posts[1]!.notices, undefined);
  });

  it('spends no update on a turn that never said anything', async () => {
    // The `chat.update` budget is per channel, and most turns answer without
    // narrating: tidying an acknowledgement that was never written on would spend
    // that budget on every answer instead.
    const { deps, updates } = harness({ existing: CONVERSATION });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'go',
      },
      deps,
    );
    assert.deepEqual(updates, []);
  });

  it('keeps the queue alive when an update throws where it stands', async () => {
    // A throw rather than a rejection is what tells whether the queue's `catch`
    // sits on the chain or only on the call: on the call, this leaves the chain
    // rejected, and the cleanup queued behind it never runs at all.
    const { deps, posts, timeline } = harness({
      existing: CONVERSATION,
      narrates: 'Reading dm.ts',
      updateThrows: true,
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'go',
      },
      deps,
    );
    // The restore still ran and still landed: what the throw took out was one
    // step, not the queue behind it.
    assert.equal(timeline.at(-1), atRest(posts[0]!.text));
  });

  it('goes quiet rather than spending a budget other turns are using', async () => {
    // Slack counts `chat.update` per app, so the ceiling belongs in front of
    // every turn at once. A turn that cannot have it says nothing extra — the
    // acknowledgement is already posted, and the answer is what they waited for.
    const { deps, posts, updates, runs } = harness({
      existing: CONVERSATION,
      narrates: 'Reading dm.ts',
      budgetSpent: true,
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'go',
      },
      deps,
    );
    assert.deepEqual(updates, [], 'no narration, and no tidy for one that never happened');
    assert.equal(posts.at(-1)!.text, 'the answer');
    assert.equal(runs.length, 1);
  });

  it('asks the shared budget only for a step its own floor would allow', async () => {
    // Asked after the per-turn interval, not before it: a turn narrating every
    // frame would otherwise drain the workspace's allowance just by being busy,
    // without ever writing a line.
    const { deps, runs, narrations } = harness({ existing: CONVERSATION });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'go',
      },
      deps,
    );
    for (let i = 0; i < 5; i += 1) runs[0]!.onProgress!('Reading dm.ts');
    await flush();
    assert.equal(narrations(), 1, 'five frames inside one interval, one request for budget');
  });

  it('takes the narration back off once the answer is there to read', async () => {
    // Asserted on what Slack finished applying, with the step deliberately the
    // slower of the two: concurrent updates on one message can land either way
    // round, and a restore that lost that race would put the step back.
    const { deps, posts, timeline } = harness({
      existing: CONVERSATION,
      narrates: 'Reading dm.ts',
      updateDelays: [20, 0],
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'go',
      },
      deps,
    );
    assert.deepEqual(
      timeline.filter((entry) => !/^(mark|finish):/.test(entry)),
      [`${posts[0]!.text}\n\n_Reading dm.ts_`, atRest(posts[0]!.text)],
    );
    // Last of everything, the mark and the turn's close included: both happen
    // before this update is waited on, or one Slack sits on would hold the thread
    // against the member's next message.
    assert.equal(timeline.at(-1), atRest(posts[0]!.text));
  });

  it('still says what was missing when the resume it offered was refused', async () => {
    // `driveAcpSession` sends the transcript on exactly the turns whose resume
    // was not honoured, and answers with the session it actually ran in — so the
    // same comparison says whether the warning is about this answer. Refused, it
    // ran on a transcript that was missing a channel, and the member has to be
    // told that after the answer as much as before it.
    const over = {
      existing: { ...CONVERSATION, source: { channel: 'C-incidents', thread: '100.0' } },
      channel: null,
      history: [{ ts: '201.0', author: 'U-nel', text: 'still waiting' }],
      narrates: 'Reading dm.ts',
    };
    const refused = harness({ ...over, endpoint: { ...READY, resume: 'acp-9' } });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'why?',
      },
      refused.deps,
    );
    assert.match(refused.updates.at(-1)!.text, /I cannot read <#C-incidents> just now/);

    // Honoured — the harness answers in `acp-1` — and the transcript went
    // unused, so a warning about it would be about nothing.
    const honoured = harness({ ...over, endpoint: { ...READY, resume: 'acp-1' } });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'why?',
      },
      honoured.deps,
    );
    assert.doesNotMatch(honoured.updates.at(-1)!.text, /I cannot read/);
  });

  it('does not leave a promise standing over a turn that failed', async () => {
    // "Reading `rows.csv`…" above "That run did not finish" is the
    // acknowledgement outliving the turn it was about.
    const { deps, posts, updates } = harness({
      existing: CONVERSATION,
      endpoint: { ...READY, workspace: 'ws-1', workspaceLabel: 'symma' },
      fileBytes: 'a,b\n',
      fails: new Error('gone'),
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'what is in this?',
        files: [
          {
            name: 'rows.csv',
            mimetype: 'text/csv',
            filetype: 'csv',
            size: 4,
            url_private_download: 'https://files/rows.csv',
          },
        ],
      },
      deps,
    );
    assert.match(posts[0]!.text, /Reading `rows.csv`…$/);
    assert.equal(updates.at(-1)!.text, '`symma` · `read-only`');
  });

  it('fetches the thread behind a pasted link, and the fetch survives a resume', async () => {
    // The agent runs on the member's machine with whatever Slack access it has —
    // usually none, occasionally somebody else's workspace. Left unresolved, a
    // pasted link arrives as a bare URL and the answer becomes the agent
    // explaining what it cannot open.
    const url = 'https://acme.slack.com/archives/C0LINKED000/p1786400100000001';
    const { deps, posts, runs } = harness({
      existing: CONVERSATION,
      endpoint: { ...READY, resume: 'acp-1' },
      channel: [{ ts: '1786400100.000001', author: 'Ola', text: 'the trace is in prod-42' }],
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: `continue from <${url}>`,
      },
      deps,
    );
    // In the prompt, never the context: the driver drops context where a resume
    // is honoured — the session already has its thread — but a link pasted into
    // this message is new to that session too.
    assert.match(runs[0]!.prompt, /Behind https.*fetched just now/);
    assert.match(runs[0]!.prompt, /the trace is in prod-42/);
    assert.doesNotMatch(runs[0]!.context ?? '', /prod-42/);
    assert.match(posts[0]!.text, /Reading the thread behind your link/);
  });

  it('runs without a link it cannot read, and says so to both sides', async () => {
    const url = 'https://acme.slack.com/archives/C0FOREIGN00/p1786400100000001';
    const { deps, posts, runs } = harness({ existing: CONVERSATION, channel: null });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: `see <${url}>`,
      },
      deps,
    );
    // The member hears it where the catch-up note lives — in the resting text,
    // since no resume makes it stop being what this answer ran without. The
    // agent hears it as an offer: one with its own Slack access can go where
    // the bot cannot.
    assert.match(posts[0]!.text, /This ran without <https:.*I cannot read it/);
    assert.match(runs[0]!.prompt, /read it yourself if you have Slack access/);
    assert.equal(posts.at(-1)!.text, 'the answer');
  });

  it('does not let the workspace lookup eat the links it is there to check', async () => {
    // `auth.test` is a Slack call like the rest, and it runs before the first
    // link is looked at — unbounded, a degraded Slack spends the whole budget
    // there and every link comes back "too slow".
    const url = 'https://acme.slack.com/archives/C0LINKED000/p1786400100000001';
    const { deps, runs } = harness({
      existing: CONVERSATION,
      channel: [{ ts: '1786400100.000001', author: 'Ola', text: 'the trace is in prod-42' }],
    });
    deps.host = () => new Promise(() => undefined);
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: `continue from <${url}>`,
      },
      deps,
    );
    // The pin comes off, which is what an unknown host already meant — and the
    // link is still fetched, because the access check is what guards it.
    assert.match(runs[0]!.prompt, /the trace is in prod-42/);
  });

  it('spends nothing on a message with no link in it', async () => {
    // Which is nearly every message: the host read is an API call the first
    // time, and no ordinary turn should pay for a feature it is not using.
    let hosts = 0;
    const { deps } = harness({ existing: CONVERSATION });
    deps.host = () => {
      hosts += 1;
      return Promise.resolve('acme.slack.com');
    };
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'what broke?',
      },
      deps,
    );
    assert.equal(hosts, 0);
  });

  it('reads a private channel or group DM the member is in, scanning once', async () => {
    // The other half of the access rule: a public channel is anyone's, and this
    // is the member's own membership — a private channel, a group DM. Without
    // it a link they can plainly open comes back "not a channel you are in".
    const inside = 'https://acme.slack.com/archives/G0GROUPDM00/p1786400100000001';
    const also = 'https://acme.slack.com/archives/C0PRIVATE00/p1786400200000001';
    const { deps, runs, scans } = harness({
      existing: CONVERSATION,
      privateMine: ['G0GROUPDM00', 'C0PRIVATE00'],
      channel: [{ ts: '1786400100.000001', author: 'Ola', text: 'the plan is in prod-42' }],
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: `both <${inside}> and <${also}>`,
      },
      deps,
    );
    assert.match(runs[0]!.prompt, /the plan is in prod-42/);
    // Their list is read once for the message, not once per link: it is the
    // same answer, and every extra read is latency in front of the ack.
    assert.equal(scans(), 1);
  });

  it('does not tell a member they are outside a channel it simply cannot see', async () => {
    // Slack restricts the membership list to conversations the *bot* shares
    // with them, so a private channel it was never invited to is one it can say
    // nothing about — and "you are not in that channel" would be a guess about
    // the one thing they can check themselves, usually wrong.
    const url = 'https://acme.slack.com/archives/C0UNSEEN000/p1786400100000001';
    const { deps, posts } = harness({ existing: CONVERSATION, unseen: ['C0UNSEEN000'] });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: `see <${url}>`,
      },
      deps,
    );
    assert.match(posts[0]!.text, /I cannot read it/);
    assert.doesNotMatch(posts[0]!.text, /not a channel you are in/);
  });

  it('does not call a member outside a channel it failed to ask about', async () => {
    // An empty list says they are in nothing; a failed scan says nobody asked
    // successfully. Reported as the same thing, a missing scope sends them
    // auditing their own memberships.
    const url = 'https://acme.slack.com/archives/C0PRIVATE00/p1786400100000001';
    const { deps, posts } = harness({
      existing: CONVERSATION,
      privateMine: ['C0PRIVATE00'],
      scanFails: true,
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: `see <${url}>`,
      },
      deps,
    );
    assert.match(posts[0]!.text, /I cannot read it/);
    assert.doesNotMatch(posts[0]!.text, /not a channel you are in/);
  });

  it('will not read a member a channel they are not in', async () => {
    // The bot reads with its own token and is in whatever anyone invited it to,
    // so without this any member could paste a link to any channel it can see —
    // another member's private channel, or their DM with the bot — and read it
    // through the agent.
    const url = 'https://acme.slack.com/archives/C0THEIRS000/p1786400100000001';
    const { deps, posts, runs } = harness({
      existing: CONVERSATION,
      notMine: ['C0THEIRS000'],
      channel: [{ ts: '1786400100.000001', author: 'Ola', text: 'their private plans' }],
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: `see <${url}>`,
      },
      deps,
    );
    assert.doesNotMatch(runs[0]!.prompt, /their private plans/);
    assert.match(posts[0]!.text, /not a channel you are in/);
  });

  it('hands the member’s own files to the agent, and names what it could not', async () => {
    const { deps, posts, runs } = harness({ existing: CONVERSATION, fileBytes: 'a,b\n1,2\n' });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'what is in this?',
        files: [
          {
            name: 'rows.csv',
            mimetype: 'text/csv',
            filetype: 'csv',
            size: 8,
            url_private_download: 'https://files/rows.csv',
          },
          { name: 'book.xlsx', mimetype: 'application/vnd.ms-excel', filetype: 'xlsx', size: 20 },
        ],
      },
      deps,
    );
    // The readable one travels as content, not as a filename in a transcript —
    // which is the whole difference from what v1 did.
    assert.deepEqual(runs[0]!.attachments, [
      { name: 'rows.csv', mimeType: 'text/csv', kind: 'text', data: 'a,b\n1,2\n' },
    ]);
    // The moving cue lands on the end of the whole acknowledgement, whatever it
    // turned out to say.
    assert.match(posts[0]!.text, /Reading `rows\.csv`…$/);
    // And the one it could not read is said out loud rather than quietly
    // missing from an answer that used the rest.
    assert.deepEqual(posts[1]!.notices, [
      'Could not read book.xlsx (xlsx is not something I can pass along).',
    ]);
  });

  it('does not spend downloads on a machine that cannot take the turn', async () => {
    const { deps, runs, fetches } = harness({
      existing: CONVERSATION,
      endpoint: { ...READY, state: 'asleep' },
      fileBytes: 'x',
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'read this',
        files: [
          { name: 'a.md', filetype: 'md', size: 1, url_private_download: 'https://files/a.md' },
        ],
      },
      deps,
    );
    // The ordering is the assertion: a fetch hoisted above the endpoint check
    // would pull megabytes for a laptop that was never going to answer.
    assert.equal(fetches(), 0);
    assert.deepEqual(runs, []);
  });

  it('corrects the reading promise even when the run never finished', async () => {
    const { deps, posts } = harness({
      existing: CONVERSATION,
      fileBytes: 'x',
      fails: new Error('agent exited 1'),
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'read these',
        files: [
          { name: 'a.md', filetype: 'md', size: 1, url_private_download: 'https://f/a.md' },
          { name: 'b.xlsx', filetype: 'xlsx', size: 1, url_private_download: 'https://f/b.xlsx' },
        ],
      },
      deps,
    );
    // The acknowledgement promised to read them; a turn that never reached the
    // agent leaves that standing unless the failure says otherwise.
    assert.match(posts[0]!.text, /Reading `a\.md`/);
    assert.deepEqual(posts[1]!.notices, [
      'Could not read b.xlsx (xlsx is not something I can pass along).',
    ]);
  });

  it('says what the turn cost, beside the model that charged it', async () => {
    const { deps, posts } = harness({
      existing: CONVERSATION,
      models: {
        currentModelId: 'gpt-5.6-sol[high]',
        availableModels: [{ modelId: 'gpt-5.6-sol[high]' }],
      },
      // Expensive by what the model had not seen: 108k of this was new to it.
      usage: { totalTokens: 168_237, cachedTokens: 60_008 },
      notices: ['Warning: skills were shortened.'],
      resumeWith: 'codex resume',
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'go',
      },
      deps,
    );
    // Asides in order: the agent's own first, then what it cost, then the
    // handoff back to a terminal. Rounded, because what a member does with a
    // token count is notice a turn that cost ten times the last one.
    assert.deepEqual(posts[1]!.notices, [
      'Warning: skills were shortened.',
      '`gpt-5.6-sol[high]` · 168.2k tokens · 60k cached',
      'Yours in the terminal too: `codex resume acp-1`',
    ]);
  });

  it('names what ran without anyone being asked, and what was refused', async () => {
    const { deps, posts } = harness({
      existing: CONVERSATION,
      approvals: [
        { title: 'Run `git push`', allowed: true },
        // The same call asked about twice, quoted differently — one line, not two.
        { title: 'Run git push', allowed: true },
        { title: 'Write src/index.ts', allowed: false },
      ],
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'go',
      },
      deps,
    );
    assert.deepEqual(posts[1]!.notices, [
      'Went ahead without asking: `Run git push`.',
      'Would not run: `Write src/index.ts`.',
    ]);
  });

  it('counts the rest rather than listing every one of them', async () => {
    // A turn that asked forty times is not a list anyone reads, and one long
    // enough to be clipped is clipped wherever the slice lands — inside a code
    // span as readily as between two names.
    const { deps, posts } = harness({
      existing: CONVERSATION,
      approvals: Array.from({ length: 8 }, (_, i) => ({
        title: `Run cmd${String(i)}`,
        allowed: true,
      })),
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'go',
      },
      deps,
    );
    assert.deepEqual(posts[1]!.notices, [
      'Went ahead without asking: `Run cmd0`, `Run cmd1`, `Run cmd2`, `Run cmd3`, `Run cmd4` and 3 more.',
    ]);
  });

  it('corrects the record when the agent could not take a file it was sent', async () => {
    // The acknowledgement promised the member it was reading them, and only this
    // layer knows how a filename renders here — so the driver names them and
    // this words it, backtick stripped like every other name.
    const { deps, posts } = harness({
      existing: CONVERSATION,
      fileBytes: 'x',
      unsupported: [
        { name: 'we`ird.csv', kind: 'text' },
        { name: 'shot.png', kind: 'image' },
      ],
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'read this',
        files: [
          { name: 'we`ird.csv', filetype: 'csv', size: 1, url_private_download: 'https://f/a.csv' },
        ],
      },
      deps,
    );
    // One sentence per kind: an image and a CSV are refused for different
    // reasons, and naming them together would misdescribe one of them.
    assert.deepEqual(posts[1]!.notices, [
      'we ird.csv did not reach kilo: it takes no text attachments.',
      'shot.png did not reach kilo: it takes no image attachments.',
    ]);
  });

  it('sheds a model from another agent’s roster, which would fail every turn', async () => {
    // `selectModelConfigOption` throws for kilo/devin/claude, so a codex id left
    // stored would fail the thread forever — a failed turn posts no picker.
    const { deps, posts, sheds } = harness({
      existing: CONVERSATION,
      endpoint: { ...READY, model: 'gpt-5.6-sol[high]' },
      fails: new Error(
        'acp:kilo slack-conv-1: model "gpt-5.6-sol[high]" is not offered by the agent; first offers: x',
      ),
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'go',
      },
      deps,
    );
    assert.deepEqual(sheds, ['model:conv-1']);
    assert.match(posts[1]!.text, /no longer offers `gpt-5\.6-sol\[high\]`.*retry with its default/);
  });

  it('says nothing about cost with no total to report, or nothing to report it for', async () => {
    // An invented number is worse than none, and agents other than codex report
    // nothing here at all.
    const { deps, posts } = harness({ existing: CONVERSATION, usage: { cachedTokens: 12 } });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'go',
      },
      deps,
    );
    assert.equal(posts[1]!.notices, undefined);

    // And a question answered out of context that was already there. 120k of
    // repo and instructions, all but 2k of it cached: a bar on the total would
    // call this expensive on the strength of a big `AGENTS.md`, which every turn
    // in that workspace carries whether it did any work or not.
    const cheap = harness({
      existing: CONVERSATION,
      usage: { totalTokens: 120_000, cachedTokens: 118_000 },
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-2',
        text: 'hello',
      },
      cheap.deps,
    );
    assert.equal(cheap.posts[1]!.notices, undefined);
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
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'look',
      },
      deps,
    );
    // Absent mode still runs read-only, and the tier is said, not implied.
    assert.equal(runs[0]!.mode, undefined);
    assert.match(posts[0]!.text, /^`symma` · `read-only`/);
    // The first workspace turn is exactly where the picker has to appear, or
    // there is no way to ever leave read-only.
    assert.deepEqual(posts[1]!.pickers, { conversation: 'conv-1', agent: 'kilo', modes: roster });
  });

  it('sheds a mode the agent stopped offering, and says so', async () => {
    const { deps, posts, sheds, finished } = harness({
      existing: CONVERSATION,
      endpoint: { ...READY, workspace: 'ws-1', workspaceLabel: 'symma', mode: 'yolo' },
      fails: new Error('acp:codex slack-conv-1: mode yolo not offered (offers: read-only, agent)'),
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'go',
      },
      deps,
    );
    // Without the shed this thread fails every turn from here on: the picker
    // that could fix it only rides answers, and there is no answer.
    assert.deepEqual(sheds, ['conv-1']);
    assert.match(posts[1]!.text, /no longer offers `yolo`.*retry with its default/);
    assert.equal(finished[0]!.status, 'failed');
  });

  it('does not claim a clear that failed', async () => {
    const { deps, posts } = harness({
      existing: CONVERSATION,
      endpoint: { ...READY, workspace: 'ws-1', workspaceLabel: 'symma', mode: 'yolo' },
      fails: new Error('acp:codex slack-conv-1: mode yolo not offered (offers: read-only)'),
      shedFails: true,
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'go',
      },
      deps,
    );
    // A stale mode still stored means the retry fails the same way — saying
    // "cleared" here would promise a recovery that did not happen.
    assert.match(posts[1]!.text, /no longer offers `yolo`, and I could not clear it/);
  });

  it('offers no picker outside a named workspace, wherever the roster came from', async () => {
    // A temp-dir session can serve a roster too; rendering a picker for it
    // would offer a mode the companion is guaranteed to refuse.
    const { deps, posts } = harness({
      existing: CONVERSATION,
      modes: { currentModeId: 'read-only', availableModes: [{ id: 'read-only' }] },
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'hi',
      },
      deps,
    );
    assert.equal(posts[1]!.pickers, undefined);
  });

  it('names the model as `provider/model`, which is the only shape that parses', async () => {
    // Every spec runs the string through `parseModelName` and reads the half
    // after the slash, so a bare `default` is refused before any agent sees it —
    // `Invalid model "default"; expected "provider/model"`. The prefix is not
    // read by anything, so the agent's own name is the honest one to use.
    const { deps, runs } = harness();
    await handleDm(
      { user: 'U-nel', channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
      deps,
    );

    assert.equal(runs[0]!.model, 'kilo/default');
  });

  it('names the project the answer is about, and runs the turn there', async () => {
    // §4 wants the scope in the DM root rather than guessed at: a member who
    // cannot see which checkout answered cannot tell a stale answer from a
    // wrong one. The id goes to the companion; the label is for them.
    const { deps, posts, runs, askedFor } = harness({
      endpoint: { ...READY, workspace: 'ws-abc123', workspaceLabel: 'symma' },
    });
    await handleDm(
      { user: 'U-nel', channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
      deps,
    );

    assert.match(posts[0]!.text, /^`symma` ·/);
    assert.doesNotMatch(posts[0]!.text, /cannot see your files/);
    assert.equal(runs[0]!.workspace, 'ws-abc123');
    // The gateway cannot prefer this thread's project without being told which
    // thread is asking.
    assert.deepEqual(askedFor, ['conv-1']);
  });

  it('does not let a directory name break the sentence it is shown in', async () => {
    // A label is `basename` of a real directory: a backtick in one would end the
    // code span early and spill the rest of the sentence into it, and `<!here>`
    // would broadcast once the answer is shared into a channel.
    const { deps, posts } = harness({
      endpoint: { ...READY, workspace: 'ws-1', workspaceLabel: 'we`ird <!here>' },
    });
    await handleDm(
      { user: 'U-nel', channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
      deps,
    );

    assert.match(posts[0]!.text, /^`we ird &lt;!here&gt;` · `read-only`$/);
    // Two spans — label and mode — each opened and closed; the mode span is
    // safe by the wire's alphabet, so only the label needed escaping.
    assert.equal(posts[0]!.text.split('`').length - 1, 4, 'both spans opened and closed');
  });

  it('reads the channel a mention came out of, and only what is unseen', async () => {
    // The thread the question is about lives in the channel, not in a copy of it
    // quoted into the DM — so a turn reads it from Slack, from the cursor.
    const { deps, runs, moved, timeline } = harness({
      existing: {
        ...CONVERSATION,
        source: { channel: 'C-incidents', thread: '100.0' },
        seenThroughTs: '100.0',
      },
      channel: [
        { ts: '100.0', author: 'Nel', text: 'the deploy is failing' },
        { ts: '101.0', author: 'Ola', text: 'here is the trace' },
      ],
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'why?',
      },
      deps,
    );
    assert.match(runs[0]!.context!, /here is the trace/);
    assert.doesNotMatch(runs[0]!.context!, /the deploy is failing/, 'already shown');
    // Moved once the answer is delivered — a cursor past an answer nobody got
    // would filter out exactly what they never saw — and before the turn closes,
    // since closing it is what lets the next one read by that cursor.
    assert.deepEqual(moved, ['conv-1:101.0']);
    assert.deepEqual(
      timeline.filter((entry) => /^(mark|seen|finish):/.test(entry)),
      ['mark:working', 'mark:done', 'seen:101.0', 'finish:completed'],
    );
  });

  it('says so when it cannot read the channel it was asked about', async () => {
    // Nothing copies that thread into the DM any more, so losing access to it
    // loses the question's context — and an answer given without it reads like an
    // answer about it.
    const { deps, posts, runs, updates } = harness({
      existing: { ...CONVERSATION, source: { channel: 'C-incidents', thread: '100.0' } },
      channel: null,
      // So the prompt has something in it: without this the context is absent
      // entirely and asserting what it does not claim would assert nothing.
      history: [{ ts: '201.0', author: 'U-nel', text: 'still waiting' }],
      // And so the acknowledgement is rewritten at all: with nothing in flight
      // there is no update to take the warning off, and the assertion below
      // would hold without the code that keeps it.
      narrates: 'Reading dm.ts',
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'why?',
      },
      deps,
    );
    assert.match(posts[0]!.text, /I cannot read <#C-incidents> just now/);
    assert.match(runs[0]!.context!, /still waiting/, 'the DM still travels');
    assert.doesNotMatch(runs[0]!.context!, /asked in/, 'and nothing claims that thread');
    // And it is still there once the answer is: what the answer was produced
    // without stays true of the answer, unlike the ellipsis beside it.
    assert.match(updates.at(-1)!.text, /I cannot read <#C-incidents> just now/);
    assert.doesNotMatch(updates.at(-1)!.text, /…$/);
  });

  it('leaves the cursor where it was when the answer never landed', async () => {
    const { deps, moved } = harness({
      existing: { ...CONVERSATION, source: { channel: 'C-incidents', thread: '100.0' } },
      channel: [{ ts: '101.0', author: 'Ola', text: 'here is the trace' }],
      answerPostFails: new Error('slack is down'),
    });
    await assert.rejects(
      handleDm(
        {
          user: 'U-nel',
          channel: 'D-nel',
          ts: '250.0',
          threadTs: '200.0',
          eventId: 'Ev-1',
          text: 'why?',
        },
        deps,
      ),
      /slack is down/,
    );
    assert.deepEqual(moved, []);
  });

  it('answers anyway when the cursor will not move', async () => {
    // Fail-open, per the auxiliary rule: a cursor that stuck costs a re-read on
    // the next turn, where failing the turn costs the answer.
    const { deps, posts } = harness({
      existing: { ...CONVERSATION, source: { channel: 'C-incidents', thread: '100.0' } },
      channel: [{ ts: '101.0', author: 'Ola', text: 'here is the trace' }],
      seenFails: true,
    });
    assert.equal(
      await handleDm(
        {
          user: 'U-nel',
          channel: 'D-nel',
          ts: '250.0',
          threadTs: '200.0',
          eventId: 'Ev-1',
          text: 'why?',
        },
        deps,
      ),
      'resumed',
    );
    assert.equal(posts[1]!.text, 'the answer');
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
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'and now?',
      },
      deps,
    );

    assert.match(posts[0]!.text, /Catching it up from the thread/);
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
    // Above the replay label, which is charged against the same ceiling: a budget
    // under it carries no thread at all rather than a trimmed one.
    const { deps, posts } = harness({ existing: CONVERSATION, history, budgetBytes: 280 });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'and now?',
      },
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
        {
          user: 'U-nel',
          channel: 'D-nel',
          ts: '250.0',
          threadTs: '200.0',
          eventId: 'Ev-1',
          text: 'and now?',
        },
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
        {
          user: 'U-nel',
          channel: 'D-nel',
          ts: '250.0',
          threadTs: '200.0',
          eventId: 'Ev-1',
          text: 'and now?',
        },
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
    await handleDm(
      { user: 'U-nel', channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
      deps,
    );
    const answered = posts.at(-1)!;
    assert.equal(answered.text, 'the deploy fails on a missing env var');
    assert.deepEqual(answered.notices, ['Warning: skill descriptions were shortened.']);
  });

  it('carries a resume the gateway offered, and remembers where the turn ran', async () => {
    const { deps, posts, runs, finished } = harness({
      existing: CONVERSATION,
      endpoint: { ...READY, workspace: 'ws-1', resume: 'acp-0' },
      history: [{ ts: '210.0', author: 'U-nel', text: 'why is the deploy failing?' }],
      resumeWith: 'codex resume',
    });
    await handleDm(
      {
        user: 'U-nel',
        channel: 'D-nel',
        ts: '250.0',
        threadTs: '200.0',
        eventId: 'Ev-1',
        text: 'and now?',
      },
      deps,
    );
    assert.equal(runs[0]!.resume, 'acp-0');
    // The thread goes too: the offer is not the outcome, and a resume that the
    // agent refuses would otherwise arrive with nothing.
    assert.match(runs[0]!.context!, /why is the deploy failing/);
    assert.match(posts[0]!.text, /Picking up where it left off/);
    // The run came back on `acp-1`, so the offered `acp-0` is what nothing can
    // pick up now — a refused offer is exactly when the new id has to be said.
    assert.deepEqual(posts[1]!.notices, ['Yours in the terminal too: `codex resume acp-1`']);
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
      { user: 'U-nel', channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
      from.deps,
    );
    assert.deepEqual(from.posts.at(-1)!.offerShare, {
      conversation: 'conv-1',
      destination: '<#C-incidents>',
    });

    const own = harness();
    await handleDm(
      { user: 'U-nel', channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
      own.deps,
    );
    assert.equal(own.posts.at(-1)!.offerShare, undefined);
  });

  it('does not spend a laptop on a message with no question in it', async () => {
    const { deps, posts, runs, asked } = harness();
    assert.equal(
      await handleDm(
        { user: 'U-nel', channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: '   ' },
        deps,
      ),
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
      await handleDm(
        { user: 'U-nel', channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
        deps,
      ),
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
    await handleDm(
      { user: 'U-nel', channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
      deps,
    );
    assert.deepEqual(marks, [
      { channel: 'D-nel', ts: '250.0', state: 'working' },
      { channel: 'D-nel', ts: '250.0', state: 'done' },
    ]);
  });

  it('marks anything that goes wrong failed, rather than leaving it running', async () => {
    const states = (marks: { state: MarkState }[]) => marks.map((m) => m.state);
    const ask = {
      user: 'U-nel',
      channel: 'D-nel',
      ts: '250.0',
      eventId: 'Ev-1',
      text: 'what broke?',
    };

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
      { user: 'U-nel', channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
      refused.deps,
    );
    assert.deepEqual(refused.marks, []);

    const empty = harness();
    await handleDm(
      { user: 'U-nel', channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: '  ' },
      empty.deps,
    );
    assert.deepEqual(empty.marks, []);
  });

  it('has something to post when the run produced nothing', async () => {
    // Slack refuses an empty message, so posting the answer straight through
    // would turn a quiet success into a reported failure.
    const { deps, posts } = harness({ answer: '  ' });
    assert.equal(
      await handleDm(
        { user: 'U-nel', channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
        deps,
      ),
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
          { user: 'U-nel', channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
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
      await handleDm(
        { user: 'U-nel', channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
        deps,
      ),
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
          { user: 'U-nel', channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
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
    await handleDm(
      { user: 'U-nel', channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
      deps,
    );
    assert.match(posts[0]!.text, /from your machine\b/);
  });

  it('sends a member who has paired nothing to /connect', async () => {
    // Not a machine that is away — there is none. Naming a device here would be
    // naming one they never had.
    const { deps, posts } = harness({ endpoint: null });
    assert.equal(
      await handleDm(
        { user: 'U-nel', channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
        deps,
      ),
      'refused: unpaired',
    );
    assert.match(posts[0]!.text, /`\/connect`/);
  });

  it('still records the turn when it refuses', async () => {
    // The event was answered, so a redelivery must not answer it again — the
    // refusal is a reply like any other.
    const { deps, turns } = harness({ endpoint: { ...READY, state: 'asleep' } });
    await handleDm(
      { user: 'U-nel', channel: 'D-nel', ts: '250.0', eventId: 'Ev-1', text: 'what broke?' },
      deps,
    );
    assert.equal(turns.length, 1);
  });
});
