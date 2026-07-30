/**
 * A message in the DM. Replying in a thread resumes the conversation that thread
 * is; a top-level message opens one with no source (§4).
 *
 * No agent runs yet — this records the turn, and either says so or says why the
 * machine it would run on cannot take it (§3). Driving the prompt is the next
 * slice, and a turn that exists is what it will pick up.
 */
import type { EndpointState, SelectedEndpoint } from '@symma/protocol';

import type { ConversationRef } from './mention.js';
import { refusal } from './presence.js';

export interface DmMessage {
  /** The DM channel, always a `D` id — resolved by Slack, not by us. */
  channel: string;
  ts: string;
  /** Absent on a top-level message, which is then its own root. */
  threadTs?: string;
  eventId: string;
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

/** `refused` names which of §3's states stopped it, so a support question is
 * answered by the log line rather than by asking the member what they saw. */
export type DmOutcome =
  | 'resumed'
  | 'opened'
  | 'already handled'
  | `refused: ${Exclude<EndpointState, 'ready'> | 'unpaired'}`;

export interface DmDeps {
  find: (dmChannel: string, rootThread: string) => Promise<ConversationRef | undefined>;
  /** The machine this member's agent would run on, whatever state it is in.
   * Undefined when they have paired none. */
  endpoint: () => Promise<SelectedEndpoint | undefined>;
  turn: (spec: {
    dmChannel: string;
    rootThread: string;
    slackEventId: string;
  }) => Promise<{ conversation: ConversationRef; turn?: string }>;
  post: (
    channel: string,
    text: string,
    threadTs?: string,
  ) => Promise<{ channel: string; ts: string }>;
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

  // Asked after the dedupe gate, so a redelivery costs the gateway nothing.
  const selected = await deps.endpoint();
  const state = selected?.state ?? 'unpaired';
  await deps.post(
    conversation.dmChannel,
    refusal(selected) ??
      'Got it. Your agent is not wired up to answer yet — that lands in the next change.',
    conversation.rootThread,
  );
  if (state !== 'ready') return `refused: ${state}`;
  return existing ? 'resumed' : 'opened';
}
