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
import type { TurnTarget } from '@symma/protocol';

import type { ConversationRef } from './mention.js';
import { decideTurn, type RefusalReason } from './presence.js';
import type { MarkState } from './slack-api.js';
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
}

/**
 * Whether a `message` event is a member speaking in their own DM. A function
 * with a test rather than a condition in the handler, because the bot's own
 * posts arrive on this subscription and answering one is an infinite loop.
 * A `subtype` is an edit, a delete or a join: nothing to answer.
 */
export function isMemberDm(event: Record<string, unknown>): boolean {
  return (
    event.type === 'message' &&
    event.channel_type === 'im' &&
    event.bot_id === undefined &&
    event.subtype === undefined &&
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
  /** A session to pick up, and what to catch a fresh one up with instead. Both
   * travel: which applies is not known until the agent has been asked. */
  resume?: string;
  context?: string;
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
  run: (spec: RunSpec) => Promise<{ text: string; notices: string[]; session: string }>;
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
  // Recorded before anything is posted, so a Slack redelivery answers with
  // silence rather than a second acknowledgement.
  if (refused === 'duplicate' || !turn) return 'already handled';
  // A thread is a sequence. Two turns at once fork the agent session that
  // carries it, and neither half then holds the whole conversation — so the
  // second one waits, and is told rather than left wondering.
  if (refused === 'busy') {
    await deps.post(
      conversation.dmChannel,
      'Still working on your last one — send this again when it lands.',
      conversation.rootThread,
    );
    return 'still working';
  }

  // A file with no caption is an ordinary message with an empty prompt. Caught
  // before the ask below, so it neither mints a token nor starts a run.
  if (!message.text.trim()) {
    await deps.post(
      conversation.dmChannel,
      'Send me a question with that and I will pass it to your agent.',
      conversation.rootThread,
    );
    await deps.finish(conversation.id, turn, 'cancelled');
    return 'nothing to ask';
  }

  // Asked after the dedupe gate, so a redelivery costs the gateway nothing —
  // and, since asking mints a token, costs it no credential either.
  const decision = decideTurn(await deps.endpoint(conversation.id));
  if (!decision.run) {
    await deps.post(conversation.dmChannel, decision.why, conversation.rootThread);
    await deps.finish(conversation.id, turn, 'cancelled');
    return `refused: ${decision.because}`;
  }

  // Even when a resume is on offer, because whether the agent still has that
  // session is not known until it has been asked — and arriving without the
  // thread is the half that cannot be recovered from (§4).
  const caught = existing ? await catchUp(message, conversation, deps) : undefined;

  // A run has twenty minutes to answer, so silence that long reads as broken.
  // §4 wants the scope in the DM root rather than guessed at, so the answer
  // says which project it is about — or that it can see no files at all, which
  // is the one thing a member would otherwise assume wrong.
  // A backtick closes the span it is in, so a directory named with one would
  // spill the rest of the sentence into code. Their own machine and their own
  // DM, so this is rendering and not a trust boundary.
  const scope = decision.label
    ? `On it, in \`${decision.label.replaceAll('`', '')}\`.`
    : 'On it. It has no access to your files, so keep the question self-contained.';
  // The offer, not the outcome: the agent has not been asked yet, so this says
  // what will be tried rather than claiming a resume that may not happen.
  const note = decision.resume ? 'Picking up where it left off, if it still can.' : caught?.note;
  await deps.post(
    conversation.dmChannel,
    note ? `${scope} ${note}` : scope,
    conversation.rootThread,
  );

  await deps.mark(message.channel, message.ts, 'working');

  let answer: { text: string; notices: string[]; session: string };
  try {
    answer = await deps.run({
      conversation: conversation.id,
      endpoint: decision.endpoint,
      agent: decision.agent,
      token: decision.token,
      // §5 wants a per-agent default with an override; until the override
      // exists this is the default, and the prefix is what makes it parse.
      model: `${decision.agent}/default`,
      prompt: message.text,
      ...(caught ? { context: caught.context } : {}),
      ...(decision.resume ? { resume: decision.resume } : {}),
      ...(decision.workspace ? { workspace: decision.workspace } : {}),
    });
  } catch (error) {
    // Posted into the thread they are watching rather than left to the socket's
    // catch, which answers at the DM root where this reply is not.
    deps.log(`run failed: ${String(error)}`);
    await deps.finish(conversation.id, turn, 'failed');
    await deps.mark(message.channel, message.ts, 'failed');
    await deps.post(
      conversation.dmChannel,
      'That run did not finish. Send it again and I will retry.',
      conversation.rootThread,
    );
    return 'failed';
  }

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
      answer.notices,
    );
  } catch (error) {
    // The run is over either way, and `announcing` tells them the delivery
    // failed. Leaving the mark saying it is still going would outlive that
    // message and be the last thing they are told.
    await deps.mark(message.channel, message.ts, 'failed');
    await deps.finish(conversation.id, turn, 'completed', {
      session: answer.session,
      endpoint: decision.endpoint,
      agent: decision.agent,
      ...(decision.workspace ? { workspace: decision.workspace } : {}),
    });
    throw error;
  }
  await deps.mark(message.channel, message.ts, 'done');
  await deps.finish(conversation.id, turn, 'completed', {
    session: answer.session,
    endpoint: decision.endpoint,
    agent: decision.agent,
    ...(decision.workspace ? { workspace: decision.workspace } : {}),
  });
  return existing ? 'resumed' : 'opened';
}
