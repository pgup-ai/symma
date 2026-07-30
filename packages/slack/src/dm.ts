/**
 * A message in the DM. Replying in a thread resumes the conversation that thread
 * is; a top-level message opens one with no source (§4).
 *
 * No agent runs yet — this records the turn and says so. Driving the prompt is
 * the next slice, and a turn that exists is what it will pick up.
 */
import type { ConversationRef } from './mention.js';

export interface DmMessage {
  user: string;
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

export type DmOutcome = 'resumed' | 'opened' | 'already handled' | 'not ours';

export interface DmDeps {
  find: (dmChannel: string, rootThread: string) => Promise<ConversationRef | undefined>;
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
 * A top-level message is its own root, which is what the member's replies then
 * thread under. A reply in a thread the bot did not open is left alone: rooting
 * a conversation mid-thread would answer where nobody is expecting one, under a
 * ts the bot never posted.
 */
export async function handleDm(message: DmMessage, deps: DmDeps): Promise<DmOutcome> {
  const rootThread = message.threadTs ?? message.ts;
  const existing = await deps.find(message.channel, rootThread);
  if (!existing && message.threadTs) return 'not ours';

  const { conversation, turn } = await deps.turn({
    dmChannel: message.channel,
    rootThread,
    slackEventId: message.eventId,
  });
  // Recorded before anything is posted, so a Slack redelivery answers with
  // silence rather than a second acknowledgement.
  if (!turn) return 'already handled';

  await deps.post(
    conversation.dmChannel,
    'Got it. Your agent is not wired up to answer yet — that lands in the next change.',
    conversation.rootThread,
  );
  return existing ? 'resumed' : 'opened';
}
