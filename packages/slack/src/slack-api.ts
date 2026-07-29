/**
 * The two Slack Web API calls the mention path needs. Hand-rolled for the same
 * reason Socket Mode is: `fetch` is the whole transport, and Slack's own docs are
 * the contract.
 */
import type { ThreadMessage } from './snapshot.js';

/** Slack answers 200 with `ok: false`, so a status is never the whole answer. */
async function call<T>(token: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${method}: http ${res.status}`);
  const answer = (await res.json()) as { ok?: boolean; error?: string };
  if (!answer.ok) throw new Error(`${method}: ${answer.error ?? 'not ok'}`);
  return answer as T;
}

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

/** Errors that mean "not visible to this bot" rather than "broken": the bot is
 * not in the channel, or was never granted the scope. Anything else throws,
 * because guessing which is which is how a partial snapshot gets answered. */
const UNREADABLE = new Set(['not_in_channel', 'channel_not_found', 'missing_scope']);

export function slackApi(token: string): SlackApi {
  return {
    async threadReplies(channel, thread) {
      try {
        const { messages } = await call<{ messages?: RawMessage[] }>(
          token,
          'conversations.replies',
          { channel, ts: thread, limit: 200 },
        );
        return (messages ?? [])
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
        if (UNREADABLE.has(String(error).replace(/^.*: /, ''))) return undefined;
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
