/**
 * The bot. Holds one outbound WebSocket to Slack and no agent credentials, and
 * spawns nothing (§6). One command, deliberately: model, provider, directory
 * and shell controls are all support and security surface, and this workflow
 * has not earned any of them yet.
 */
import { connectMessage, runConnect, type MintResult } from './connect.js';
import { handleDm, isMemberDm } from './dm.js';
import { handleMention, type ConversationRef } from './mention.js';
import { slackApi } from './slack-api.js';
import { socketMode } from './socket-mode.js';

const log = (message: string): void => {
  console.log(`[symma-slack] ${message}`);
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    // Loud and specific at boot, rather than a bot that connects and then fails
    // every command with something a member has to report before anyone knows.
    console.error(`[symma-slack] ${name} is not set; the bot cannot start without it.`);
    process.exit(1);
  }
  return value;
}

/**
 * Every call the bot makes to the gateway: one door, the shared secret, and the
 * team it speaks for. The bot never reaches the database — `(team, user) → owner`
 * is the check §6 calls the whole security model, and it belongs on the side that
 * can enforce it.
 *
 * `send` hands back the response because pairing reads a status: a 403 there is
 * an answer about the member, not an outage. `ask` covers everything else.
 */
function gatewayClient(base: string, token: string, team: string) {
  const send = (path: string, body: Record<string, unknown>): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ team, ...body }),
      signal: AbortSignal.timeout(10_000),
    });
  return {
    send,
    ask: async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
      const res = await send(path, body);
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      return (await res.json()) as T;
    },
  };
}

async function reply(responseUrl: string, text: string): Promise<void> {
  // Ephemeral without exception. A pairing code is a credential, and `/connect`
  // can be run in any channel the app is in — an in_channel reply would put one
  // in front of everybody who can read it.
  const res = await fetch(responseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', text }),
    signal: AbortSignal.timeout(10_000),
  });
  // Slack answers 200 with an error body for some failures, but a non-2xx is
  // unambiguous: the member saw nothing while the log above said `minted`.
  // Thrown so the socket's handler catch turns it into a line an operator reads.
  if (!res.ok) throw new Error(`slack refused the reply: ${res.status}`);
}

const appToken = required('SYMMA_SLACK_APP_TOKEN');
const team = required('SYMMA_SLACK_TEAM');
const gateway = required('SYMMA_GATEWAY').replace(/\/+$/, '');
const gatewayToken = required('SYMMA_SLACK_GATEWAY_TOKEN');

const botToken = required('SYMMA_SLACK_BOT_TOKEN');
// A ceiling on injected context, not a tuning knob: §4 requires a hard budget
// and an honest account of what it left out.
const budgetBytes = Number(process.env.SYMMA_SLACK_BUDGET_BYTES) || 24_000;

const { send, ask } = gatewayClient(gateway, gatewayToken, team);

const mint = async (slackUser: string): Promise<MintResult> => {
  const res = await send('/api/slack/pair', { user: slackUser });
  // A real answer about this member, not an outage: their account is not active.
  if (res.status === 403) return { ok: false, why: 'not-a-member' };
  if (!res.ok) throw new Error(`/api/slack/pair: ${res.status}`);
  return { ok: true, ...((await res.json()) as { code: string; expiresInMinutes: number }) };
};

const api = slackApi(botToken);

/** Everything either path needs, bound to the member's Slack id — the trusted
 * assertion of who is asking, and the same one `/connect` pairs on. */
const depsFor = (user: string) => {
  // Both lookups read the same shape back and differ only in the key they ask
  // by. Read at the boundary rather than cast: an empty object is the gateway
  // saying this thread has no conversation, which is the ordinary first mention
  // and also a DM thread the bot did not open.
  const lookup = async (
    path: string,
    by: Record<string, string>,
  ): Promise<ConversationRef | undefined> => {
    const { id, dmChannel, rootThread, seenThroughTs } = await ask<Partial<ConversationRef>>(path, {
      user,
      ...by,
    });
    if (!id || !dmChannel || !rootThread) return undefined;
    return { id, dmChannel, rootThread, ...(seenThroughTs ? { seenThroughTs } : {}) };
  };
  return {
    budgetBytes,
    log,
    threadReplies: api.threadReplies,
    openDm: api.openDm,
    post: api.post,
    find: (sourceChannel: string, sourceThread: string) =>
      lookup('/api/slack/conversation', { sourceChannel, sourceThread }),
    findDm: (dmChannel: string, rootThread: string) =>
      lookup('/api/slack/dm', { dmChannel, rootThread }),
    turn: (spec: Record<string, unknown>) =>
      ask<{ conversation: ConversationRef; turn?: string }>('/api/slack/turn', { user, ...spec }),
    seen: async (conversation: string, seenThroughTs: string) => {
      await ask('/api/slack/seen', { user, conversation, seenThroughTs });
    },
  };
};

const connection = socketMode({
  appToken,
  log,
  onEnvelope: async (envelope) => {
    if (envelope.type === 'events_api') {
      const { event_id: eventId, event } = envelope.payload as {
        event_id?: unknown;
        event?: {
          type?: unknown;
          user?: unknown;
          channel?: unknown;
          ts?: unknown;
          thread_ts?: unknown;
        };
      };
      if (event?.type === 'message') {
        const dm = event as Record<string, unknown>;
        if (typeof eventId !== 'string' || !isMemberDm(dm)) return;
        const user = dm.user as string;
        const channel = dm.channel as string;
        const deps = depsFor(user);
        const outcome = await handleDm(
          {
            user,
            channel,
            ts: dm.ts as string,
            ...(typeof dm.thread_ts === 'string' ? { threadTs: dm.thread_ts } : {}),
            eventId,
          },
          { find: deps.findDm, turn: deps.turn, post: deps.post },
        );
        log(`dm in ${channel}: ${outcome}`);
        return;
      }
      if (event?.type !== 'app_mention') return;
      if (
        typeof eventId !== 'string' ||
        typeof event.user !== 'string' ||
        typeof event.channel !== 'string' ||
        typeof event.ts !== 'string'
      ) {
        return;
      }
      const mention = {
        user: event.user,
        channel: event.channel,
        // A mention that starts a thread is its own thread.
        threadTs: typeof event.thread_ts === 'string' ? event.thread_ts : event.ts,
        eventId,
      };
      try {
        log(`mention in ${event.channel}: ${await handleMention(mention, depsFor(event.user))}`);
      } catch (error) {
        // The envelope was acked before this ran, so Slack will not redeliver and
        // a throw would leave the member waiting on nothing. Telling them costs
        // one message and is the only definite outcome available; a durable queue
        // is the fuller answer and is not built.
        log(`mention in ${event.channel} failed: ${String(error)}`);
        await api
          .openDm(event.user)
          .then((dm) =>
            api.post(dm, 'That did not get through — mention me again and I will retry.'),
          )
          .catch(() => log('could not tell them it failed either'));
      }
      return;
    }
    if (envelope.type !== 'slash_commands') return;
    const command = envelope.payload as { command?: unknown; response_url?: unknown };
    if (command.command !== '/connect') return;
    // Slack signs this URL and it is the only place the answer belongs — not a
    // channel inferred from the payload, and not a DM we would have to guess at.
    if (typeof command.response_url !== 'string') return;
    const outcome = await runConnect(envelope.payload, team, mint);
    await reply(command.response_url, connectMessage(outcome));
    // After the reply, so the line means the member was told rather than that
    // the gateway answered. A failed delivery throws instead, which the
    // socket's handler catch reports.
    log(`/connect: ${outcome.ok ? 'minted' : outcome.why}`);
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    connection.stop();
    process.exit(0);
  });
}

log(`listening for /connect in ${team}`);
