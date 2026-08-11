/**
 * §5's share-back: a finished answer going to the thread it was asked from,
 * because the member said so.
 *
 * "Invoking the agent is not consent to publish its response" is the whole
 * point of the section, so nothing here happens without the click.
 */
import type { Unusable } from './slack-api.js';

/** The click, narrowed to what this reads. */
export interface ShareRequest {
  user: string;
  /** The DM channel and the message the button sits on. */
  channel: string;
  messageTs: string;
  /** The conversation's root, off the payload. Slack says not to reply to a
   * reply's ts, and the DM thread is the transcript a follow-up is caught up
   * from — an outcome outside it is one the next turn never sees. */
  thread: string;
  /** The answer itself, off the message the button is attached to. */
  text: string;
  /** All the button carried — where it may go is the gateway's answer. */
  conversation: string;
}

export interface ShareDeps {
  /** Where this conversation may publish, per the gateway. Undefined when it
   * has nowhere to go back to, or is not this member's. */
  destination: (conversation: string) => Promise<{ channel: string; thread: string } | undefined>;
  /** The member's own Slack token, when they have linked their account.
   * Undefined is ordinary, not a failure — the bot posts with their name in
   * front of it, as it always did. */
  asMember: () => Promise<string | undefined>;
  /** Forgets a token Slack has stopped honouring, so the next share does not
   * spend a refused call on it and the home tab stops claiming they post as
   * themselves. Fails open: the share has already landed by then. */
  unlink: () => Promise<void>;
  share: (
    channel: string,
    thread: string,
    text: string,
    asMember?: string,
  ) => Promise<{ ok: true } | { ok: false; why: Unusable }>;
  post: (channel: string, text: string, threadTs?: string) => Promise<unknown>;
  settle: (channel: string, ts: string, text: string) => Promise<void>;
}

export type ShareOutcome = 'shared' | 'no destination' | `kept: ${Unusable}`;

/** What went wrong, in the member's words. §5: a publication that cannot land
 * is not a lost answer, so each of these says the answer is still here.
 *
 * Two of them change subject with the author. Posting as the member, Slack is
 * refusing *them* — and "I am not in that channel" would send them looking at
 * the bot's membership for a problem with their own. */
const because = (why: Unusable, asMember: boolean): string =>
  ({
    archived: 'that thread is in an archived channel',
    removed: asMember ? 'you are not in that channel' : 'I am not in that channel any more',
    locked: 'that channel is read-only now',
    gone: 'that thread is gone',
    scope: asMember
      ? 'Slack would not let me post as you there'
      : 'I no longer have permission to post there',
    // Only reachable if the fallback below were ever removed, since the post it
    // retries with carries no token. Answered rather than left to fall through
    // to the sentence saying it was shared.
    author: 'Slack would not take your sign-in',
  })[why];

export async function handleShare(request: ShareRequest, deps: ShareDeps): Promise<ShareOutcome> {
  const to = await deps.destination(request.conversation);
  if (!to) {
    // Covers a conversation opened in the DM and one that is not theirs alike:
    // the button should not have been there either way, so this says what is
    // true rather than which of the two it was.
    await deps.post(request.channel, 'There is no thread to share this back to.', request.thread);
    return 'no destination';
  }

  // §5 wants a channel post attributable to whoever approved it. With their own
  // token Slack records exactly that, so the message needs no sentence saying
  // whose it is; without one the bot is the author and has to say.
  const asBot = `<@${request.user}> shared:\n\n${request.text}`;
  let author = await deps.asMember();
  let result = await deps.share(to.channel, to.thread, author ? request.text : asBot, author);
  // Their token stopped working — revoked, or an install replaced. The bot can
  // still publish, and an answer they approved is worth more than the name on
  // it. Forgotten as well, or every later share pays for the same refusal and
  // the home tab goes on saying they post as themselves.
  if (!result.ok && result.why === 'author') {
    await deps.unlink().catch(() => undefined);
    // The retry is the bot's, so whatever it is refused for is about the bot —
    // telling them *they* are not in the channel would be the wrong subject.
    author = undefined;
    result = await deps.share(to.channel, to.thread, asBot);
  }
  if (!result.ok) {
    await deps.post(
      request.channel,
      `Kept this here — ${because(result.why, Boolean(author))}. Nothing was lost.`,
      request.thread,
    );
    // The button stays: the destination is what failed, and fixing it makes
    // pressing again the right thing to do.
    return `kept: ${result.why}`;
  }
  // Gone on success, though. Pressing twice would put the same answer in a
  // public thread twice, which is the one mistake here everyone can see.
  await deps.settle(
    request.channel,
    request.messageTs,
    `${request.text}\n\n_Shared to the thread._`,
  );
  await deps.post(request.channel, 'Shared to the thread.', request.thread);
  return 'shared';
}
