/**
 * A message in the DM. Replying in a thread resumes the conversation that thread
 * is; a top-level message opens one with no source (§4).
 *
 * The turn is recorded, then run on the member's own machine — or refused in
 * §3's words when that machine cannot take it. A follow-up reattaches to the
 * session the last turn ran in when the gateway still offers one, and is caught
 * up from this thread when it does not — both travel, because which applies is
 * not known until the agent has been asked (§4).
 */
import type {
  PromptAttachment,
  SessionModels,
  SessionModes,
  TurnTarget,
  TurnUsage,
} from '@symma/protocol';

import {
  collectAttachments,
  skippedNote,
  type FetchedFile,
  type SlackFile,
} from './attachments.js';

import type { ConversationRef } from './mention.js';
import { decideTurn, type RefusalReason } from './presence.js';
import { plainly, type MarkState } from './slack-api.js';
import { threadSnapshot, type ThreadMessage } from './snapshot.js';

export interface DmMessage {
  /** The DM channel, always a `D` id — resolved by Slack, not by us. */
  channel: string;
  ts: string;
  /** Absent on a top-level message, which is then its own root. */
  threadTs?: string;
  eventId: string;
  /** What they asked, as Slack sent it: `<@U123>` and `<#C123>` stay unresolved,
   * since expanding them is a lookup each and the question is about code. */
  text: string;
  /** What they attached, as Slack described it. Fetched rather than named: an
   * agent told a CSV exists can only say so back. */
  files?: SlackFile[];
}

/**
 * Whether a `message` event is a member speaking in their own DM. A function
 * with a test rather than a condition in the handler, because the bot's own
 * posts arrive on this subscription and answering one is an infinite loop.
 * A `subtype` is an edit, a delete or a join: nothing to answer. `file_share` is
 * the exception — Slack files a member's upload under it, caption and all
 * (docs.slack.dev/reference/events/message/file_share, checked 2026-08), so
 * refusing every subtype would drop the attachment path's own messages in
 * silence: no acknowledgement, no refusal, nothing in the DM at all.
 */
export function isMemberDm(event: Record<string, unknown>): boolean {
  return (
    event.type === 'message' &&
    event.channel_type === 'im' &&
    event.bot_id === undefined &&
    (event.subtype === undefined || event.subtype === 'file_share') &&
    typeof event.user === 'string' &&
    typeof event.channel === 'string' &&
    typeof event.ts === 'string'
  );
}

/** `refused` names why, so a support question is answered by the log line rather
 * than by asking the member what they saw. `failed` is a run that started. */
export type DmOutcome =
  | 'resumed'
  | 'opened'
  | 'already handled'
  | 'still working'
  | 'nothing to ask'
  | 'failed'
  | `refused: ${RefusalReason}`;

/** One prompt on one machine, in one of the directories it offers. */
export interface RunSpec {
  conversation: string;
  endpoint: string;
  agent: string;
  token: string;
  prompt: string;
  /** Absent for a machine that advertises no roots — the agent then opens in an
   * empty temp directory, which the acknowledgement says out loud. */
  workspace?: string;
  /** `provider/model`, always — every spec parses it that way and reads the half
   * after the slash. A bare `default` is refused before any agent sees it. */
  model: string;
  /** The conversation's session mode, as the gateway served it (§4). Absent is
   * read-only. */
  mode?: string;
  /** A session to pick up, and what to catch a fresh one up with instead. Both
   * travel: which applies is not known until the agent has been asked. */
  resume?: string;
  context?: string;
  /** What the agent is doing, for the acknowledgement to show while it runs. */
  onProgress?: (title: string) => void;
  /** The member's own files, already fetched, for the agent to read. */
  attachments?: PromptAttachment[];
}

/** `chat.update` is rate limited per channel, and a turn narrating every file
 * read would spend that budget on frames nobody reads. */
const PROGRESS_MIN_MS = 4_000;

/** How long the answer's own handler will wait on the update that tidies the
 * acknowledgement, for a line the member is not waiting for. Landing late is
 * harmless: nothing else writes that message after the turn that posted it.
 *
 * The Slack implementation bounds the call itself as well, and this stays because
 * `working` is a seam: what is behind it decides how long a `chat.update` may
 * take, and how long this handler is willing to be held is not that layer's
 * decision to make. */
const TIDY_MS = 10_000;

/** A tool-call title on its way into a mrkdwn *italic* span, so an underscore
 * closes it as surely as a backtick does. Clamped, since a title is a label. */
const asStep = (title: string): string =>
  plainly(title).replaceAll('_', ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

/** Rounded: what a member does with a token count is notice a turn that cost
 * ten times the last one. */
const thousands = (tokens: number): string =>
  tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k`;

/** Measured on what was not cached, not on the total: the context a workspace
 * turn carries is re-sent every turn whether it did any work or not, so a total
 * crosses any bar the moment `AGENTS.md` is big, which is every turn. What is
 * new to the model is what the turn actually chewed through — a few thousand for
 * a question answered from context, an order more for one that read the repo. */
const EXPENSIVE_TOKENS = 25_000;

/** The cost beside the model that charged it — the two only mean something
 * together, now that the model is the member's own choice. Absent when the
 * agent reported no total: an invented number is worse than none. Absent for a
 * cheap turn too, since a count on every answer is a number nobody reads and
 * the point of it is noticing the turn that cost ten times the last one. */
function spent(model: string | undefined, usage: TurnUsage | undefined): string[] | undefined {
  if (usage?.totalTokens === undefined) return undefined;
  if (usage.totalTokens - (usage.cachedTokens ?? 0) < EXPENSIVE_TOKENS) return undefined;
  const parts = [
    ...(model ? [`\`${plainly(model)}\``] : []),
    `${thousands(usage.totalTokens)} tokens`,
    ...(usage.cachedTokens ? [`${thousands(usage.cachedTokens)} cached`] : []),
  ];
  return [parts.join(' · ')];
}

/** Which files the agent had no block for, grouped by kind — one sentence per
 * kind, because a rejected image and a rejected CSV are refused for different
 * reasons and naming them together would misdescribe one of them. */
function unsupportedNote(agent: string, files?: { name: string; kind: string }[]): string[] {
  const byKind = new Map<string, string[]>();
  for (const file of files ?? []) {
    byKind.set(file.kind, [...(byKind.get(file.kind) ?? []), plainly(file.name)]);
  }
  return [...byKind].map(
    ([kind, names]) =>
      `${names.join(', ')} did not reach ${agent}: it takes no ${kind} attachments.`,
  );
}

/** What the answer can offer to change for the next turn, or nothing. */
function pickers(
  conversation: string,
  agent: string,
  answer: { modes?: SessionModes; models?: SessionModels },
  inWorkspace: boolean,
):
  | { conversation: string; agent: string; modes?: SessionModes; models?: SessionModels }
  | undefined {
  const offer = {
    ...(answer.modes && inWorkspace ? { modes: answer.modes } : {}),
    ...(answer.models ? { models: answer.models } : {}),
  };
  return Object.keys(offer).length ? { conversation, agent, ...offer } : undefined;
}

export interface DmDeps {
  find: (dmChannel: string, rootThread: string) => Promise<ConversationRef | undefined>;
  /** The machine this member's agent would run on, whatever state it is in, and
   * what it takes to drive it. Undefined when they have paired none. */
  endpoint: (conversation: string) => Promise<TurnTarget | undefined>;
  turn: (spec: {
    dmChannel: string;
    rootThread: string;
    slackEventId: string;
  }) => Promise<{ conversation: ConversationRef; turn?: string; refused?: 'duplicate' | 'busy' }>;
  /** Drives one prompt to its answer on the member's machine. Rejects rather
   * than returning a failure, so the transport's own errors arrive intact.
   * `notices` is what the agent said about itself rather than about the
   * question, kept apart so the answer is not read as carrying it. `session` is
   * where it ran, for the next turn in this thread to pick up. */
  run: (spec: RunSpec) => Promise<{
    text: string;
    notices: string[];
    session: string;
    /** How the member picks this session up in their own terminal, when the
     * agent has such a command. */
    resumeWith?: string;
    modes?: SessionModes;
    models?: SessionModels;
    /** What the turn cost, when the agent said. */
    usage?: TurnUsage;
    /** Files the agent advertised no block for, for this layer to word. */
    unsupported?: { name: string; kind: string }[];
  }>;
  /** Clears the conversation's stored mode. Called when a turn failed because
   * the agent no longer offers it — the picker that could fix it only rides
   * answers, so without this the thread would fail every turn from here on. */
  shedMode: (conversation: string) => Promise<void>;
  /** The same for the model: ids belong to an agent's roster, so a pick made
   * under one can throw under another and would repeat until it is cleared. */
  shedModel: (conversation: string) => Promise<void>;
  /** Downloads one of the member's Slack files. */
  fetchFile: (url: string, maxBytes: number) => Promise<FetchedFile>;
  /** Rewrites the acknowledgement while the run is out, so a long turn shows
   * it is still moving. Fails open, like every hint here. */
  working: (channel: string, ts: string, text: string) => Promise<void>;
  /** Ends the turn, and remembers the session it ran in when there was one —
   * against what it ran under, since an id means nothing on another machine,
   * agent or directory. Every path that opened a turn calls this, including the
   * ones that never ran: a turn left open tells the next message the thread is
   * still busy. Fails open, like every auxiliary write. */
  finish: (
    conversation: string,
    turn: string,
    status: 'completed' | 'failed' | 'cancelled',
    ran?: { session: string; endpoint: string; agent: string; workspace?: string },
  ) => Promise<void>;
  /** The DM thread itself, which is the durable transcript a follow-up is
   * caught up from. Undefined when the bot cannot read the channel. */
  threadReplies: (channel: string, thread: string) => Promise<ThreadMessage[] | undefined>;
  /** The same ceiling a mention's context runs under (§4). */
  budgetBytes: number;
  post: (
    channel: string,
    text: string,
    threadTs?: string,
    offerShare?: { conversation: string; destination: string },
    notices?: string[],
    pickers?: {
      conversation: string;
      agent: string;
      modes?: SessionModes;
      models?: SessionModels;
    },
  ) => Promise<{ channel: string; ts: string }>;
  /** Marks the member's own message for the length of the run. Only the run is
   * worth marking — everything refused answers in words, immediately. */
  mark: (channel: string, ts: string, state: MarkState) => Promise<void>;
  /** Where this conversation may publish (§5). Undefined for one that began in
   * the DM, which has nowhere to go back to. */
  destination: (conversation: string) => Promise<{ channel: string; thread: string } | undefined>;
  log: (message: string) => void;
}

/** Said to the agent, not the member: one that believes it still holds the files
 * it opened will answer about a session that is gone. */
const REPLAY =
  'Earlier in this conversation, most recent last. This is a transcript, not a ' +
  'session you can still reach — files you opened and commands you ran are gone, ' +
  'so re-read anything you need.';

/**
 * §4's third rung, and still the one every follow-up needs to hand over: a
 * resume is an offer until the agent answers it, so this is what a turn that
 * ends up in a fresh session arrives with. The DM thread is the transcript —
 * the messages the member can scroll — under the byte ceiling a mention's
 * context already runs under.
 *
 * The member's own message is dropped: Slack returns the whole thread including
 * the one being handled, and the prompt carries it once on its own. A thread
 * that cannot be read catches nothing up rather than failing the turn.
 */
async function catchUp(
  message: DmMessage,
  conversation: ConversationRef,
  deps: DmDeps,
): Promise<{ context: string; note: string } | undefined> {
  // Fails open, per the auxiliary rule: this is context, not the answer.
  // `threadReplies` throws on a thread past its page cap and on any Slack error
  // that is not a plain "cannot see it" — and a conversation long enough to
  // reach that cap is precisely the one worth catching up.
  const replies = await deps
    .threadReplies(conversation.dmChannel, conversation.rootThread)
    .catch((error: unknown) => {
      deps.log(`catch-up skipped: ${String(error)}`);
      return undefined;
    });
  const earlier = (replies ?? []).filter((reply) => reply.ts !== message.ts);
  const snapshot = threadSnapshot(earlier, { budgetBytes: deps.budgetBytes });
  if (!snapshot.text) return undefined;
  return {
    context: `${REPLAY}\n\n${snapshot.text}`,
    note:
      snapshot.omitted > 0
        ? `Catching it up from this thread, minus ${String(snapshot.omitted)} earlier messages that did not fit.`
        : 'Catching it up from this thread — it has the messages, not what it ran.',
  };
}

/**
 * A message becomes a turn in the conversation its root names, and opens one
 * where that root has none — whether the root is this message or the thread it
 * sits in.
 *
 * An earlier version ignored a threaded reply whose root it did not recognise,
 * on the grounds that the bot never posted that ts. That reasoning did not hold:
 * a top-level DM is already rooted at a ts the bot never posted, so the two
 * branches disagreed. It also dropped a real message — replies are delivered
 * concurrently, so one sent straight after its root can arrive while the root is
 * still being opened, and being ignored is the one answer a member cannot see.
 */
export async function handleDm(message: DmMessage, deps: DmDeps): Promise<DmOutcome> {
  const rootThread = message.threadTs ?? message.ts;
  const existing = await deps.find(message.channel, rootThread);

  const { conversation, turn, refused } = await deps.turn({
    dmChannel: message.channel,
    rootThread,
    slackEventId: message.eventId,
  });
  // A thread is a sequence. Two turns at once fork the agent session that
  // carries it, and neither half then holds the whole conversation — so the
  // second one waits, and is told rather than left wondering. Before the guard
  // below, which a refusal also trips: neither kind carries a turn.
  if (refused === 'busy') {
    await deps.post(
      conversation.dmChannel,
      'Still working on your last one — send this again when it lands.',
      conversation.rootThread,
    );
    return 'still working';
  }
  // Recorded before anything is posted, so a Slack redelivery answers with
  // silence rather than a second acknowledgement.
  if (!turn) return 'already handled';

  // A file with no caption is an ordinary message with an empty prompt. Caught
  // before the ask below, so it neither mints a token nor starts a run.
  if (!message.text.trim()) {
    // Closed before the post, not after: this turn is already decided, and a
    // Slack error here would otherwise hold the thread until it went stale.
    await deps.finish(conversation.id, turn, 'cancelled');
    await deps.post(
      conversation.dmChannel,
      'Send me a question with that and I will pass it to your agent.',
      conversation.rootThread,
    );
    return 'nothing to ask';
  }

  // Asked after the dedupe gate, so a redelivery costs the gateway nothing —
  // and, since asking mints a token, costs it no credential either.
  const decision = decideTurn(await deps.endpoint(conversation.id));
  if (!decision.run) {
    await deps.finish(conversation.id, turn, 'cancelled');
    await deps.post(conversation.dmChannel, decision.why, conversation.rootThread);
    return `refused: ${decision.because}`;
  }

  // Even when a resume is on offer, because whether the agent still has that
  // session is not known until it has been asked — and arriving without the
  // thread is the half that cannot be recovered from (§4).
  const caught = existing ? await catchUp(message, conversation, deps) : undefined;

  // Fetched before the run so a refusal is one aside rather than a failed turn,
  // and after the endpoint check so a shut laptop costs no downloads.
  const attached = message.files?.length
    ? await collectAttachments(message.files, deps.fetchFile)
    : [];
  const attachments = attached.flatMap((entry) => (entry.ok ? [entry.file] : []));

  // A run has twenty minutes to answer, so silence that long reads as broken.
  // §4 wants the scope in the DM root rather than guessed at, so the turn that
  // decides it names the project and the mode — an absent mode included, since
  // read-only is the floor's truth for a workspace turn that never picked one.
  // Only that turn: a resume is offered only where this thread's machine, agent
  // and directory are all still the ones it was minted under, so a follow-up
  // would be repeating the root, and the picker under every answer carries the
  // mode. Having no workspace is the exception that repeats — nothing else tells
  // a member their question has to stand on its own.
  //
  // Through `plainly` like every other name in this message: a backtick closes
  // the span it sits in, and a `<` opens an entity that renders as a mention
  // once the answer is shared into a channel. Their own machine and their own
  // DM, so this is rendering and not a trust boundary.
  const scope = !decision.label
    ? 'On it. It has no access to your files, so keep the question self-contained.'
    : decision.resume
      ? 'On it.'
      : `On it, in \`${plainly(decision.label)}\` — \`${decision.mode ?? 'read-only'}\` mode.`;
  // The offer, not the outcome: the agent has not been asked yet, so this says
  // what will be tried rather than claiming a resume that may not happen.
  const note = decision.resume ? 'Picking up where it left off, if it still can.' : caught?.note;
  // Named up front: a member who attached three files and sees two read should
  // learn it now, not from an answer that quietly used one.
  const reading = attachments.length
    ? `Reading ${attachments.map((file) => `\`${plainly(file.name)}\``).join(', ')}.`
    : undefined;
  // The trailing ellipsis is the standing "still going" cue, so it belongs on
  // the end of whatever the acknowledgement turned out to be — not on the scope
  // sentence, which a resume note or a file list then follows.
  const ack = `${[scope, note, reading].filter(Boolean).join(' ').replace(/\.$/, '')}…`;
  const acked = await deps.post(conversation.dmChannel, ack, conversation.rootThread);

  await deps.mark(message.channel, message.ts, 'working');

  // The agent's own narration, rewritten onto the acknowledgement it already
  // posted — Slack gives a bot no typing indicator, so the message is the only
  // place a long turn can show it is still moving. Throttled because
  // `chat.update` is rate-limited and a busy turn narrates far faster than
  // anyone reads; fails open, since this is a hint and not the answer.
  //
  // Queued rather than concurrent: two updates in flight on one message can land
  // in either order, and the cleanup below losing that race would leave a step
  // sitting above the answer — the thing it is there to take away.
  let lastShown = 0;
  let updating = Promise.resolve();
  const narrate = (title: string): void => {
    const now = Date.now();
    if (now - lastShown < PROGRESS_MIN_MS) return;
    lastShown = now;
    // Caught on the chain and not on the call, so a `working` that throws where
    // it stands rather than rejecting cannot leave `updating` rejected — every
    // link after it, the cleanup included, would be skipped and the step would
    // stay exactly where this is meant to take it from.
    updating = updating
      .then(() => deps.working(acked.channel, acked.ts, `${ack}\n\n_${asStep(title)}_`))
      .catch(() => undefined);
  };

  let answer: {
    text: string;
    notices: string[];
    session: string;
    resumeWith?: string;
    modes?: SessionModes;
    models?: SessionModels;
    usage?: TurnUsage;
    unsupported?: { name: string; kind: string }[];
  };
  try {
    answer = await deps.run({
      conversation: conversation.id,
      endpoint: decision.endpoint,
      agent: decision.agent,
      token: decision.token,
      // §5 wants a per-agent default with an override; until the override
      // exists this is the default, and the prefix is what makes it parse.
      // The member's pick when they have made one, else the agent's own
      // default. The prefix is what makes it parse either way.
      model: `${decision.agent}/${decision.model ?? 'default'}`,
      prompt: message.text,
      onProgress: narrate,
      ...(caught ? { context: caught.context } : {}),
      ...(decision.resume ? { resume: decision.resume } : {}),
      ...(decision.workspace ? { workspace: decision.workspace } : {}),
      ...(decision.mode ? { mode: decision.mode } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
  } catch (error) {
    // Posted into the thread they are watching rather than left to the socket's
    // catch, which answers at the DM root where this reply is not.
    deps.log(`run failed: ${String(error)}`);
    // A stored pick the agent's roster dropped would repeat forever otherwise:
    // nothing that fails a turn can offer the picker that would fix it. Matched
    // on each failure's exact shape, since "agent X not offered" is a different
    // refusal from either of these.
    const failed = String(error);
    const staleMode = decision.mode !== undefined && /: mode \S+ not offered \(/.test(failed);
    const staleModel =
      decision.model !== undefined && /: model "[^"]+" is not offered by the agent/.test(failed);
    const unoffered = staleMode || staleModel;
    // Tracked, not assumed: a clear that failed leaves the stale mode in
    // place, and claiming recovery would promise a retry that fails the same
    // way. Fail-open on the write itself — the turn's outcome stands either way.
    // Whichever drifted is what the member is told about, and what gets cleared.
    const dropped = staleMode ? decision.mode : decision.model;
    const shed =
      unoffered &&
      (await (staleMode ? deps.shedMode : deps.shedModel)(conversation.id).then(
        () => true,
        () => false,
      ));
    await deps.finish(conversation.id, turn, 'failed');
    await deps.mark(message.channel, message.ts, 'failed');
    await deps.post(
      conversation.dmChannel,
      unoffered
        ? shed
          ? `The agent no longer offers \`${dropped}\`, so I cleared it. Send it again and I will retry with its default.`
          : `The agent no longer offers \`${dropped}\`, and I could not clear it. Send it again and I will keep trying.`
        : 'That run did not finish. Send it again and I will retry.',
      conversation.rootThread,
      undefined,
      // The acknowledgement named the files it fetched, and a turn that never
      // reached the agent leaves that promise standing — so what could not be
      // read is said here too, where the member is deciding whether to resend.
      skippedNote(attached),
    );
    return 'failed';
  }

  const ran = {
    session: answer.session,
    endpoint: decision.endpoint,
    agent: decision.agent,
    ...(decision.workspace ? { workspace: decision.workspace } : {}),
  };
  // §5: the answer is a private draft, and the button is the only way it leaves.
  // Nowhere to go back to means no button, rather than one that would refuse
  // itself when pressed.
  try {
    const to = await deps.destination(conversation.id);
    // Slack refuses an empty message, so a quiet run would be reported as failed.
    await deps.post(
      conversation.dmChannel,
      answer.text.trim() || 'That finished without producing an answer.',
      conversation.rootThread,
      to ? { conversation: conversation.id, destination: `<#${to.channel}>` } : undefined,
      // The handoff back to the terminal, as an aside rather than in the answer:
      // the session the turn ran in is listed by the agent's own CLI, and this
      // is the one line that turns "it ran somewhere" into somewhere reachable.
      [
        ...answer.notices,
        ...skippedNote(attached),
        // The agent took the turn but not the file: said here because the
        // acknowledgement already promised the member it was being read.
        ...unsupportedNote(decision.agent, answer.unsupported),
        ...(spent(answer.models?.currentModelId, answer.usage) ?? []),
        // The command is a closed set at the parse boundary; the session id is
        // the agent's own string and is not.
        // A mismatch is the agent having minted a fresh session rather than taking
        // the one offered, which is the only time this thread has an id it was
        // not already given. Same test the driver sends the transcript on.
        ...(answer.resumeWith && answer.session !== decision.resume
          ? [`\`${answer.resumeWith} ${plainly(answer.session)}\``]
          : []),
      ],
      // The picker renders the agent's own roster, so it exists exactly where
      // the agent serves one — and only inside a named workspace, the one
      // place a mode means anything (§4).
      // Both rosters ride the answer, but a mode only means something inside a
      // named workspace — where the model is a preference anywhere. Nothing to
      // render means no payload at all, rather than a conversation id with no
      // picker to carry.
      pickers(conversation.id, decision.agent, answer, decision.workspace !== undefined),
    );
  } catch (error) {
    // The run is over either way, and `announcing` tells them the delivery
    // failed. Leaving the mark saying it is still going would outlive that
    // message and be the last thing they are told.
    await deps.mark(message.channel, message.ts, 'failed');
    await deps.finish(conversation.id, turn, 'completed', ran);
    throw error;
  }
  await deps.mark(message.channel, message.ts, 'done');
  await deps.finish(conversation.id, turn, 'completed', ran);
  // Slack cannot fold the narration away the way a terminal does, so once the
  // answer is here the last step is only in the way. Queued behind the narration
  // it is undoing, and left until after the turn is closed: a `chat.update` Slack
  // is slow to take would otherwise hold the turn open, and a member's next
  // message would be refused for a line nobody is waiting on. Guarded so a turn
  // that never narrated spends no update, and fail-open like `narrate`.
  // Waited on to a deadline, not indefinitely — see `TIDY_MS`.
  if (lastShown) {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      updating.then(() => deps.working(acked.channel, acked.ts, ack)).catch(() => undefined),
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, TIDY_MS);
        // Two different jobs on the same handle: `unref` so waiting on a line
        // nobody reads cannot be the last thing holding a process open, and the
        // clear below so a deadline that lost its race is not left pending — one
        // handle per narrated turn adds up under traffic.
        deadline.unref();
      }),
    ]);
    clearTimeout(deadline);
  }
  return existing ? 'resumed' : 'opened';
}
