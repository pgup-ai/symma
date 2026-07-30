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
  /** The DM channel and message the button sits on — where the answer is, and
   * where any refusal goes back to. */
  channel: string;
  messageTs: string;
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
}

export type ShareOutcome = 'shared' | 'no destination' | `kept: ${Unusable}`;

/** What went wrong, in the member's words. §5: a publication that cannot land
 * is not a lost answer, so each of these says the answer is still here. */
const because: Record<Unusable, string> = {
  archived: 'that thread is in an archived channel',
  removed: 'I am not in that channel any more',
  locked: 'that channel is read-only now',
  gone: 'that thread is gone',
  scope: 'I no longer have permission to post there',
};

export async function handleShare(request: ShareRequest, deps: ShareDeps): Promise<ShareOutcome> {
  const to = await deps.destination(request.conversation);
  if (!to) {
    // Covers a conversation opened in the DM and one that is not theirs alike:
    // the button should not have been there either way, so this says what is
    // true rather than which of the two it was.
    await deps.post(
      request.channel,
      'There is no thread to share this back to.',
      request.messageTs,
    );
    return 'no destination';
  }

  // Their name on it, not the bot's: §5 wants a channel post attributable to
  // whoever approved it.
  const result = await deps.share(
    to.channel,
    to.thread,
    `<@${request.user}> shared:\n\n${request.text}`,
  );
  if (!result.ok) {
    await deps.post(
      request.channel,
      `Kept this here — ${because[result.why]}. Nothing was lost.`,
      request.messageTs,
    );
    return `kept: ${result.why}`;
  }
  await deps.post(request.channel, 'Shared to the thread.', request.messageTs);
  return 'shared';
}
