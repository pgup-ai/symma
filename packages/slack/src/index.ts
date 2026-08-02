/**
 * The bot. Holds one outbound WebSocket to Slack and no agent credentials, and
 * spawns nothing (§6). One command, deliberately: model, provider, directory
 * and shell controls are all support and security surface, and this workflow
 * has not earned any of them yet.
 */
import { runRemotePrompt } from '@symma/client';
import type { TurnTarget } from '@symma/protocol';

import { connectMessage, runConnect, type MintResult } from './connect.js';
import { handleDm, isMemberDm, type RunSpec } from './dm.js';
import { handleShare } from './share.js';
import { handleMention, type ConversationRef } from './mention.js';
import { slackApi, SHARE_ACTION } from './slack-api.js';
import { readTurnTarget } from './turn-target.js';
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

const api = slackApi(botToken, { log });

/**
 * Runs a handler and makes sure the member hears about it either way.
 *
 * The envelope is acked before the handler runs, so Slack will not redeliver and
 * a throw would leave them waiting on nothing. Shared rather than repeated: the
 * mention path grew this after a review and the DM path was written without it,
 * which is one copy going stale immediately.
 */
async function announcing(user: string, what: string, run: () => Promise<string>): Promise<void> {
  try {
    log(`${what}: ${await run()}`);
  } catch (error) {
    log(`${what} failed: ${String(error)}`);
    await api
      .openDm(user)
      .then((dm) => api.post(dm, 'That did not get through — say it again and I will retry.'))
      .catch(() => log('could not tell them it failed either'));
  }
}

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
      ask<{ conversation: ConversationRef; turn?: string; refused?: 'duplicate' | 'busy' }>(
        '/api/slack/turn',
        { user, ...spec },
      ),
    endpoint: async (conversation: string) =>
      readTurnTarget(await ask<Partial<TurnTarget>>('/api/slack/endpoint', { user, conversation })),
    run: async ({
      conversation,
      endpoint,
      agent,
      token,
      prompt,
      workspace,
      model,
      resume,
      context,
    }: RunSpec) => {
      const notices: string[] = [];
      let session = '';
      const text = await runRemotePrompt(
        // One run per conversation, so the journal and viewer group a member's
        // thread rather than scattering it a session at a time.
        {
          gateway,
          token,
          endpoint,
          agent,
          runId: conversation,
          onNotice: (notice) => notices.push(notice),
          onSession: (id) => (session = id),
          ...(resume ? { resume } : {}),
          ...(context ? { context } : {}),
          ...(workspace ? { workspace } : {}),
        },
        model,
        prompt,
        `slack-${conversation}`,
        log,
      );
      return { text, notices, session };
    },
    finish: async (
      conversation: string,
      turn: string,
      status: 'completed' | 'failed' | 'cancelled',
      ran?: { session: string; endpoint: string; agent: string; workspace?: string },
    ) => {
      // The answer is posted by the time this runs, so a gateway that is slow
      // or gone must cost the next turn its history and nothing else — `send`
      // rejects on a timeout, and an uncaught one here would tell the member
      // their turn failed after they had read it.
      await send('/api/slack/turn/done', { user, conversation, turn, status, ...ran })
        .then((res) => {
          if (!res.ok) throw new Error(String(res.status));
        })
        .catch((error: unknown) => {
          log(`could not close ${turn} for ${conversation}: ${String(error)}`);
        });
    },
    destination: async (conversation: string) => {
      // `{}` is the gateway saying this conversation began in the DM, or is not
      // this member's — neither is something the bot decides for itself.
      const { channel, thread } = await ask<{ channel?: string; thread?: string }>(
        '/api/slack/share',
        { user, conversation },
      );
      return channel && thread ? { channel, thread } : undefined;
    },
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
        await announcing(user, `dm in ${channel}`, () =>
          handleDm(
            {
              channel,
              ts: dm.ts as string,
              ...(typeof dm.thread_ts === 'string' ? { threadTs: dm.thread_ts } : {}),
              eventId,
              text: typeof dm.text === 'string' ? dm.text : '',
            },
            {
              find: deps.findDm,
              turn: deps.turn,
              post: deps.post,
              endpoint: deps.endpoint,
              run: deps.run,
              finish: deps.finish,
              mark: api.mark,
              threadReplies: deps.threadReplies,
              destination: deps.destination,
              budgetBytes,
              log,
            },
          ),
        );
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
      await announcing(mention.user, `mention in ${mention.channel}`, () =>
        handleMention(mention, depsFor(mention.user)),
      );
      return;
    }
    if (envelope.type === 'interactive') {
      const { user, channel, message, actions } = envelope.payload as {
        user?: { id?: unknown };
        channel?: { id?: unknown };
        message?: { ts?: unknown; text?: unknown; thread_ts?: unknown };
        actions?: { action_id?: unknown; value?: unknown }[];
      };
      const conversation = actions?.find((a) => a.action_id === SHARE_ACTION)?.value;
      const who = user?.id;
      const where = channel?.id;
      const messageTs = message?.ts;
      // The answer is posted into the conversation's root, so the payload's
      // `thread_ts` is that root. A message that is not threaded is its own.
      const thread = typeof message?.thread_ts === 'string' ? message.thread_ts : messageTs;
      // The answer comes off the message the button sits on, so what is shared
      // is exactly what the member was looking at when they pressed it.
      const text = message?.text;
      if (
        typeof conversation !== 'string' ||
        typeof who !== 'string' ||
        typeof where !== 'string' ||
        typeof messageTs !== 'string' ||
        typeof thread !== 'string' ||
        typeof text !== 'string'
      ) {
        return;
      }
      await announcing(who, 'share', () =>
        handleShare(
          { user: who, channel: where, messageTs, thread, text, conversation },
          {
            destination: depsFor(who).destination,
            share: api.share,
            post: api.post,
            settle: api.settle,
          },
        ),
      );
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

// Exit rather than log: a bot left up on a permanent connection failure looks
// healthy to everything except the members it is ignoring.
connection.ready.catch((error: unknown) => {
  console.error(`[symma-slack] cannot connect to slack: ${String(error)}`);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    connection.stop();
    process.exit(0);
  });
}

log(`listening for /connect in ${team}`);
