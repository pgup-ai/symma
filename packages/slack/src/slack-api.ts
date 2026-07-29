/**
 * The two Slack Web API calls the mention path needs. Hand-rolled for the same
 * reason Socket Mode is: `fetch` is the whole transport, and Slack's own docs are
 * the contract.
 */
import type { ThreadMessage } from './snapshot.js';

/** Carries Slack's own error code, so a caller can decide on it rather than
 * reparse a message we formatted. */
class SlackError extends Error {
  constructor(
    readonly code: string,
    method: string,
  ) {
    super(`${method}: ${code}`);
  }
}

/** Slack answers 200 with `ok: false`, so a status is never the whole answer. */
async function call<T>(token: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new SlackError(`http ${res.status}`, method);
  const answer = (await res.json()) as { ok?: boolean; error?: string };
  if (!answer.ok) throw new SlackError(answer.error ?? 'not ok', method);
  return answer as T;
}

/** Threads cap far below this in practice; it is here so a pathological one
 * cannot spin the fetch loop, not as a limit anybody should reach. */
const MAX_PAGES = 20;

interface RawMessage {
  ts?: unknown;
  user?: unknown;
  text?: unknown;
  files?: { name?: unknown; size?: unknown }[];
}

export interface SlackApi {
  /** Oldest first. Undefined when the bot cannot see the channel at all, which
   * §4 wants said out loud rather than answered around. */
  threadReplies: (channel: string, thread: string) => Promise<ThreadMessage[] | undefined>;
  /** Returns the posted message's ts. `channel` may be a user id, which Slack
   * resolves to the DM — so opening one needs no separate call. */
  post: (
    channel: string,
    text: string,
    threadTs?: string,
  ) => Promise<{ channel: string; ts: string }>;
}

/** Slack codes that mean "not visible to this bot" rather than "broken". Anything
 * else throws: guessing which is which is how a partial snapshot gets answered. */
const UNREADABLE = new Set(['not_in_channel', 'channel_not_found', 'missing_scope']);

export function slackApi(token: string): SlackApi {
  return {
    async threadReplies(channel, thread) {
      try {
        // Paged to the end, because `conversations.replies` returns the *oldest*
        // replies first: stopping at one page and advancing the cursor to its
        // newest would put every later page permanently behind the cursor, so
        // they could never enter a snapshot and nothing would say so.
        const raw: RawMessage[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const answer = await call<{
            messages?: RawMessage[];
            response_metadata?: { next_cursor?: string };
          }>(token, 'conversations.replies', {
            channel,
            ts: thread,
            limit: 200,
            ...(cursor ? { cursor } : {}),
          });
          raw.push(...(answer.messages ?? []));
          cursor = answer.response_metadata?.next_cursor || undefined;
          if (!cursor) break;
        }
        // Only reachable on a thread past MAX_PAGES × 200 replies, where what is
        // missing is the newest end — the part that matters most.
        if (cursor) throw new SlackError('thread too long to read', 'conversations.replies');
        return raw
          .filter((m): m is RawMessage & { ts: string } => typeof m.ts === 'string')
          .map((m) => ({
            ts: m.ts,
            author: typeof m.user === 'string' ? m.user : 'unknown',
            text: typeof m.text === 'string' ? m.text : '',
            ...(m.files?.length
              ? {
                  files: m.files.map((f) => ({
                    name: typeof f.name === 'string' ? f.name : 'file',
                    ...(typeof f.size === 'number' ? { size: f.size } : {}),
                  })),
                }
              : {}),
          }));
      } catch (error) {
        if (error instanceof SlackError && UNREADABLE.has(error.code)) return undefined;
        throw error;
      }
    },
    async post(channel, text, threadTs) {
      const sent = await call<{ channel: string; ts: string }>(token, 'chat.postMessage', {
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      return { channel: sent.channel, ts: sent.ts };
    },
  };
}
