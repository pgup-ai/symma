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
  ) => Promise<{ channel: string; ts: string }>;
}

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
        // Paged to the end, because `conversations.replies` returns the oldest
        // replies first: stopping at one page and advancing the cursor to its
        // newest would put every later page permanently behind it.
        for await (const page of client.paginate('conversations.replies', {
          channel,
          ts: thread,
          limit: 200,
        })) {
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
    async post(channel, text, threadTs) {
      const sent = await client.chat.postMessage({
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      if (!sent.channel || !sent.ts) throw new Error('chat.postMessage returned no message');
      return { channel: sent.channel, ts: sent.ts };
    },
  };
}
