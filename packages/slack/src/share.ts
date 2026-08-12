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
  share: (
    channel: string,
    thread: string,
    text: string,
  ) => Promise<{ ok: true } | { ok: false; why: Unusable }>;
  post: (channel: string, text: string, threadTs?: string) => Promise<unknown>;
  settle: (channel: string, ts: string, text: string) => Promise<void>;
}

export type ShareOutcome = 'shared' | 'no destination' | `kept: ${Unusable}`;

/** What went wrong, in the member's words. §5: a publication that cannot land
 * is not a lost answer, so each of these says the answer is still here. */
const because = (why: Unusable): string =>
  ({
    archived: 'that thread is in an archived channel',
    removed: 'I am not in that channel any more',
    locked: 'that channel is read-only now',
    gone: 'that thread is gone',
    scope: 'I no longer have permission to post there',
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

  // §5 wants a channel post attributable to whoever approved it. The bot is
  // the author, so the message has to say whose approval this was.
  const result = await deps.share(
    to.channel,
    to.thread,
    `<@${request.user}> shared:\n\n${request.text}`,
  );
  if (!result.ok) {
    await deps.post(
      request.channel,
      `Kept this here — ${because(result.why)}. Nothing was lost.`,
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
