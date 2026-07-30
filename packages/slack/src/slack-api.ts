/**
 * The Slack Web API calls the conversation paths need.
 *
 * `@slack/web-api` carries what this layer would otherwise owe Slack itself:
 * pagination cursors, `ok: false` on a 200, a typed error holding Slack's own
 * code, and `Retry-After` on a 429.
 */
import { ErrorCode, WebClient, type WebAPIPlatformError } from '@slack/web-api';

import type { ThreadMessage } from './snapshot.js';

export interface SlackApi {
  /** Oldest first. Undefined when the bot cannot see the channel at all, which
   * §4 wants said out loud rather than answered around. */
  threadReplies: (channel: string, thread: string) => Promise<ThreadMessage[] | undefined>;
  /** The member's DM channel. Asked for rather than assumed: Slack's docs
   * disagree about whether a user id can stand in as a channel. */
  openDm: (user: string) => Promise<string>;
  post: (
    channel: string,
    text: string,
    threadTs?: string,
    /** §5's action on a finished answer. The button carries the conversation and
     * nothing else — where it may publish is the gateway's to state. */
    offerShare?: { conversation: string; destination: string },
  ) => Promise<{ channel: string; ts: string }>;
  /** Publishes into the source thread. Returns why it could not rather than
   * throwing: §5 keeps the answer in the DM and names which of these happened,
   * and a publication that cannot land is not a lost answer. */
  share: (
    channel: string,
    thread: string,
    text: string,
  ) => Promise<{ ok: true } | { ok: false; why: Unusable }>;
}

/** The ways a destination stops being one, as §5 lists them. */
export type Unusable = 'archived' | 'removed' | 'locked' | 'gone' | 'scope';

const UNUSABLE: Record<string, Unusable> = {
  is_archived: 'archived',
  not_in_channel: 'removed',
  channel_not_found: 'gone',
  thread_not_found: 'gone',
  restricted_action: 'locked',
  restricted_action_read_only_channel: 'locked',
  missing_scope: 'scope',
};

/** Threads cap far below this in practice; it is here so a pathological one
 * cannot spin the fetch loop, not as a limit anybody should reach. */
const MAX_PAGES = 20;

/** The one action id the bot listens for, shared by the button and its handler. */
export const SHARE_ACTION = 'share_to_thread';

/** Slack codes that mean "not visible to this bot" rather than "broken". Anything
 * else throws: guessing which is which is how a partial snapshot gets answered. */
const UNREADABLE = new Set(['not_in_channel', 'channel_not_found', 'missing_scope']);

/** Read off the typed error, never off a message — the code is the fact, and a
 * message is prose a version can reword. */
const slackCode = (error: unknown): string | undefined =>
  (error as { code?: string }).code === ErrorCode.PlatformError
    ? (error as WebAPIPlatformError).data.error
    : undefined;

interface RawMessage {
  ts?: unknown;
  user?: unknown;
  text?: unknown;
  files?: { name?: unknown; size?: unknown }[];
}

const read = (raw: RawMessage[]): ThreadMessage[] =>
  raw
    .filter((m): m is RawMessage & { ts: string } => typeof m.ts === 'string')
    .map((m) => ({
      ts: m.ts,
      author: typeof m.user === 'string' ? m.user : 'unknown',
      text: typeof m.text === 'string' ? m.text : '',
      // Named, never fetched: downloading widens both the scope request and the
      // data-lifecycle surface (§10).
      ...(m.files?.length
        ? {
            files: m.files.map((f) => ({
              name: typeof f.name === 'string' ? f.name : 'file',
              ...(typeof f.size === 'number' ? { size: f.size } : {}),
            })),
          }
        : {}),
    }));

/** `fetch` is injectable so a test can answer without a live workspace; the
 * default client keeps the SDK's own retry, which is what handles a 429. */
export function slackApi(token: string, options: { fetch?: typeof fetch } = {}): SlackApi {
  const client = new WebClient(token, options.fetch ? { fetch: options.fetch } : {});
  return {
    async threadReplies(channel, thread) {
      try {
        const raw: RawMessage[] = [];
        let pages = 0;
        // Paged to the end, because `conversations.replies` returns the oldest
        // replies first: stopping at one page and advancing the cursor to its
        // newest would put every later page permanently behind it.
        for await (const page of client.paginate('conversations.replies', {
          channel,
          ts: thread,
          limit: 200,
        })) {
          // Refused rather than truncated, for the same reason: what a cap drops
          // is the newest end, the part the question is most likely about.
          if (++pages > MAX_PAGES) throw new Error('thread too long to read');
          raw.push(...((page as { messages?: RawMessage[] }).messages ?? []));
        }
        return read(raw);
      } catch (error) {
        const code = slackCode(error);
        if (code && UNREADABLE.has(code)) return undefined;
        throw error;
      }
    },
    async openDm(user) {
      const { channel } = await client.conversations.open({ users: user });
      if (!channel?.id) throw new Error('conversations.open returned no channel');
      return channel.id;
    },
    async post(channel, text, threadTs, offerShare) {
      const sent = await client.chat.postMessage({
        channel,
        // Sent alongside the blocks as the notification and accessibility text,
        // which Slack uses wherever it will not render them.
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        ...(offerShare
          ? {
              blocks: [
                { type: 'section', text: { type: 'mrkdwn', text } },
                {
                  type: 'actions',
                  elements: [
                    {
                      type: 'button',
                      action_id: SHARE_ACTION,
                      text: { type: 'plain_text', text: 'Share to thread' },
                      value: offerShare.conversation,
                      // §5 wants the destination previewed before it is
                      // published, and the content is the message this sits on.
                      confirm: {
                        title: { type: 'plain_text', text: 'Share this answer?' },
                        text: {
                          type: 'mrkdwn',
                          text: `It will be posted to ${offerShare.destination}, with your name on it.`,
                        },
                        confirm: { type: 'plain_text', text: 'Share' },
                        deny: { type: 'plain_text', text: 'Keep private' },
                      },
                    },
                  ],
                },
              ],
            }
          : {}),
      });
      if (!sent.channel || !sent.ts) throw new Error('chat.postMessage returned no message');
      return { channel: sent.channel, ts: sent.ts };
    },
    async share(channel, thread, text) {
      try {
        await client.chat.postMessage({ channel, text, thread_ts: thread });
        return { ok: true };
      } catch (error) {
        const why = UNUSABLE[slackCode(error) ?? ''];
        // Only the ways a destination goes bad are answers. Anything else is
        // this bot being broken, which the caller reports as a failure.
        if (!why) throw error;
        return { ok: false, why };
      }
    },
  };
}
