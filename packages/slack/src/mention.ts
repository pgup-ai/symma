/**
 * A mention becomes a private turn (§4, §5). The channel supplies context and,
 * later, a destination — never an answer: invoking the agent is not consent to
 * publish what it produces, so everything from here happens in the member's DM.
 */
import { threadSnapshot, type ThreadMessage } from './snapshot.js';

/** What the gateway knows; the bot never reaches the database itself. */
export interface ConversationRef {
  id: string;
  dmChannel: string;
  rootThread: string;
  seenThroughTs?: string;
}

export interface MentionDeps {
  find: (sourceChannel: string, sourceThread: string) => Promise<ConversationRef | undefined>;
  turn: (spec: {
    sourceChannel: string;
    sourceThread: string;
    dmChannel: string;
    rootThread: string;
    slackEventId: string;
    seenThroughTs?: string;
  }) => Promise<{ conversation: ConversationRef; turn?: string }>;
  threadReplies: (channel: string, thread: string) => Promise<ThreadMessage[] | undefined>;
  post: (
    channel: string,
    text: string,
    threadTs?: string,
  ) => Promise<{ channel: string; ts: string }>;
  budgetBytes: number;
  log: (message: string) => void;
}

/** What happened, for the log — closed, so a mistyped outcome is a type error. */
export type MentionOutcome =
  'opened' | 'continued' | 'adopted' | 'already handled' | 'unreadable channel';

export interface Mention {
  user: string;
  channel: string;
  /** The thread the mention sits in; a top-level mention is its own thread. */
  threadTs: string;
  eventId: string;
}

/** The DM the member reads first. It states the privacy default up front, since
 * that is the promise §5 makes and the one they have to trust. */
const opening = (snapshot: string, omitted: number): string =>
  [
    'Picked this up from the thread. Working privately — nothing goes back to the channel unless you say so.',
    '',
    snapshot || '_Nothing new in the thread since I last read it._',
    ...(omitted ? ['', `_Context was trimmed to fit: ${omitted} message(s) left out._`] : []),
  ].join('\n');

/**
 * The order is load-bearing. For a conversation that already exists the turn is
 * recorded *before* anything is posted, so a redelivery answers with silence
 * rather than a second message. A first mention has to post first — the DM root
 * is what identifies the conversation — and its redelivery finds the conversation
 * on the next pass and takes the quiet path.
 */
export async function handleMention(mention: Mention, deps: MentionDeps): Promise<MentionOutcome> {
  const existing = await deps.find(mention.channel, mention.threadTs);

  const replies = await deps.threadReplies(mention.channel, mention.threadTs);
  if (!replies) {
    // §4: say so rather than answer from a partial snapshot. Sent to the DM, not
    // the channel, because the refusal is as private as the answer would be.
    await deps.post(
      mention.user,
      'I can add you to this once I can read that channel — invite me to it, then mention me again.',
      existing?.rootThread,
    );
    return 'unreadable channel';
  }

  const snapshot = threadSnapshot(replies, {
    budgetBytes: deps.budgetBytes,
    ...(existing?.seenThroughTs ? { since: existing.seenThroughTs } : {}),
  });

  if (existing) {
    const { turn } = await deps.turn({
      sourceChannel: mention.channel,
      sourceThread: mention.threadTs,
      dmChannel: existing.dmChannel,
      rootThread: existing.rootThread,
      slackEventId: mention.eventId,
      ...(snapshot.seenThroughTs ? { seenThroughTs: snapshot.seenThroughTs } : {}),
    });
    if (!turn) return 'already handled';
    await deps.post(
      existing.dmChannel,
      opening(snapshot.text, snapshot.omitted),
      existing.rootThread,
    );
    return 'continued';
  }

  const root = await deps.post(mention.user, opening(snapshot.text, snapshot.omitted));
  const { conversation, turn } = await deps.turn({
    sourceChannel: mention.channel,
    sourceThread: mention.threadTs,
    dmChannel: root.channel,
    rootThread: root.ts,
    slackEventId: mention.eventId,
    ...(snapshot.seenThroughTs ? { seenThroughTs: snapshot.seenThroughTs } : {}),
  });
  // The gateway adopted a conversation another delivery opened first, so the
  // message just posted is a stray in the member's own DM. Rare enough to leave
  // rather than delete, and saying which thread is live costs one line.
  if (conversation.rootThread !== root.ts) {
    deps.log(`adopted ${conversation.id}; the root just posted is stray`);
    return turn ? 'adopted' : 'already handled';
  }
  return turn ? 'opened' : 'already handled';
}
