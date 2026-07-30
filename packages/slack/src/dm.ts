/**
 * A message in the DM. Replying in a thread resumes the conversation that thread
 * is; a top-level message opens one with no source (§4).
 *
 * The turn is recorded, then run on the member's own machine — or refused in
 * §3's words when that machine cannot take it. Each turn is its own ACP session
 * for now: §4's resume lands next, and a follow-up says plainly that it is
 * starting fresh rather than passing an empty session off as a resume.
 */
import type { TurnTarget } from '@symma/protocol';

import type { ConversationRef } from './mention.js';
import { decideTurn, type RefusalReason } from './presence.js';
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
  | 'nothing to ask'
  | 'failed'
  | `refused: ${RefusalReason}`;

/** One prompt on one machine, in one of the directories it offers. No model:
 * §5's override is still whatever the agent defaults to. */
export interface RunSpec {
  conversation: string;
  endpoint: string;
  agent: string;
  token: string;
  prompt: string;
  /** Absent for a machine that advertises no roots — the agent then opens in an
   * empty temp directory, which the acknowledgement says out loud. */
  workspace?: string;
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
  }) => Promise<{ conversation: ConversationRef; turn?: string }>;
  /** Drives one prompt to its answer on the member's machine. Rejects rather
   * than returning a failure, so the transport's own errors arrive intact. */
  run: (spec: RunSpec) => Promise<string>;
  /** The DM thread itself, which is the durable transcript a follow-up is
   * caught up from. Undefined when the bot cannot read the channel. */
  threadReplies: (channel: string, thread: string) => Promise<ThreadMessage[] | undefined>;
  /** The same ceiling a mention's context runs under (§4). */
  budgetBytes: number;
  post: (
    channel: string,
    text: string,
    threadTs?: string,
  ) => Promise<{ channel: string; ts: string }>;
  log: (message: string) => void;
}

/**
 * What a replacement session is told about the turns before it, and what the
 * member is told about that. §4 will not have an empty session passed off as a
 * resume: the messages survive, the tool state does not, and both are said.
 *
 * The member's own message is dropped — Slack already has it, and the prompt
 * carries it once on its own. An unreadable thread catches nothing up rather
 * than failing the turn: an answer without history beats no answer.
 */
async function catchUp(
  message: DmMessage,
  conversation: ConversationRef,
  deps: DmDeps,
): Promise<{ context: string; said: string } | undefined> {
  const replies = await deps.threadReplies(conversation.dmChannel, conversation.rootThread);
  const earlier = (replies ?? []).filter((reply) => reply.ts !== message.ts);
  const snapshot = threadSnapshot(earlier, { budgetBytes: deps.budgetBytes });
  if (!snapshot.text) return undefined;
  return {
    context: [
      'Earlier in this conversation, most recent last. This is a transcript, not',
      'a session you can still reach — files you opened and commands you ran are',
      'gone, so re-read anything you need.',
      '',
      snapshot.text,
    ].join('\n'),
    said:
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

  const { conversation, turn } = await deps.turn({
    dmChannel: message.channel,
    rootThread,
    slackEventId: message.eventId,
  });
  // Recorded before anything is posted, so a Slack redelivery answers with
  // silence rather than a second acknowledgement.
  if (!turn) return 'already handled';

  // A file with no caption is an ordinary message with an empty prompt. Caught
  // before the ask below, so it neither mints a token nor starts a run.
  if (!message.text.trim()) {
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
    await deps.post(conversation.dmChannel, decision.why, conversation.rootThread);
    return `refused: ${decision.because}`;
  }

  // §4's third rung. The session that answered last is gone — `runRemotePrompt`
  // closes it — and no agent here advertises `session/load`, so a follow-up is
  // caught up from the durable transcript instead. That transcript is the DM
  // thread: the same messages the member can scroll, under the same byte
  // ceiling a mention's context runs under.
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
  await deps.post(
    conversation.dmChannel,
    [scope, caught?.said].filter(Boolean).join(' '),
    conversation.rootThread,
  );

  let answer: string;
  try {
    answer = await deps.run({
      conversation: conversation.id,
      endpoint: decision.endpoint,
      agent: decision.agent,
      token: decision.token,
      prompt: caught ? `${caught.context}\n\n${message.text}` : message.text,
      ...(decision.workspace ? { workspace: decision.workspace } : {}),
    });
  } catch (error) {
    // Posted into the thread they are watching rather than left to the socket's
    // catch, which answers at the DM root where this reply is not.
    deps.log(`run failed: ${String(error)}`);
    await deps.post(
      conversation.dmChannel,
      'That run did not finish. Send it again and I will retry.',
      conversation.rootThread,
    );
    return 'failed';
  }

  // Slack refuses an empty message, so a quiet run would be reported as failed.
  await deps.post(
    conversation.dmChannel,
    answer.trim() || 'That finished without producing an answer.',
    conversation.rootThread,
  );
  return existing ? 'resumed' : 'opened';
}
