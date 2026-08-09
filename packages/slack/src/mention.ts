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
  }) => Promise<{ conversation: ConversationRef; turn?: string }>;
  /** Called only once the member has been shown that far — a turn that fails to
   * deliver must not leave the thread marked read. */
  seen: (conversation: string, seenThroughTs: string) => Promise<void>;
  threadReplies: (channel: string, thread: string) => Promise<ThreadMessage[] | undefined>;
  openDm: (user: string) => Promise<string>;
  /** A link back to the source thread; undefined is one Slack would not give. */
  permalink: (channel: string, ts: string) => Promise<string | undefined>;
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
 * that is the promise §5 makes and the one they have to trust — and which thread
 * it is about, since a conversation lifted out of a channel is otherwise a quote
 * with no way back. `<#C…>` is Slack's own channel link, so it reads as whatever
 * the channel is called now rather than what it was called today. */
const opening = (
  snapshot: string,
  omitted: number,
  source: { channel: string; link?: string },
): string =>
  [
    `Picked this up from <#${source.channel}>${source.link ? ` — <${source.link}|open the thread>` : ''}. Working privately — nothing goes back to the channel unless you say so.`,
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
    // Addressed the way the rest of the path addresses an existing conversation —
    // its own channel and root — rather than pairing a user id with a thread ts
    // that belongs to a channel we did not name.
    await deps.post(
      existing?.dmChannel ?? (await deps.openDm(mention.user)),
      'I can add you to this once I can read that channel — invite me to it, then mention me again.',
      existing?.rootThread,
    );
    return 'unreadable channel';
  }

  const snapshot = threadSnapshot(replies, {
    budgetBytes: deps.budgetBytes,
    ...(existing?.seenThroughTs ? { since: existing.seenThroughTs } : {}),
  });

  const shown = async (conversation: string): Promise<void> => {
    if (snapshot.seenThroughTs) await deps.seen(conversation, snapshot.seenThroughTs);
  };

  // Once, not per post: the three openings below are one thread's.
  const link = await deps.permalink(mention.channel, mention.threadTs);
  const source = { channel: mention.channel, ...(link ? { link } : {}) };

  if (existing) {
    const { turn } = await deps.turn({
      sourceChannel: mention.channel,
      sourceThread: mention.threadTs,
      dmChannel: existing.dmChannel,
      rootThread: existing.rootThread,
      slackEventId: mention.eventId,
    });
    if (!turn) return 'already handled';
    await deps.post(
      existing.dmChannel,
      opening(snapshot.text, snapshot.omitted, source),
      existing.rootThread,
    );
    await shown(existing.id);
    return 'continued';
  }

  const dm = await deps.openDm(mention.user);
  const root = await deps.post(dm, opening(snapshot.text, snapshot.omitted, source));
  const { conversation, turn } = await deps.turn({
    sourceChannel: mention.channel,
    sourceThread: mention.threadTs,
    dmChannel: root.channel,
    rootThread: root.ts,
    slackEventId: mention.eventId,
  });
  // A concurrent mention opened this thread's conversation first, so the message
  // just posted is a stray claiming work is happening in a thread nothing will
  // answer in. Correcting it there is the only place the member is looking.
  if (conversation.rootThread !== root.ts) {
    deps.log(`adopted ${conversation.id}; correcting the stray root`);
    await deps.post(
      root.channel,
      'Started twice — carry on in the other thread, which is where I am working.',
      root.ts,
    );
    if (!turn) return 'already handled';
    await deps.post(
      conversation.dmChannel,
      opening(snapshot.text, snapshot.omitted, source),
      conversation.rootThread,
    );
    await shown(conversation.id);
    return 'adopted';
  }
  if (!turn) return 'already handled';
  await shown(conversation.id);
  return 'opened';
}
