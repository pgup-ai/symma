/**
 * The bot. Holds one outbound WebSocket to Slack and no agent credentials, and
 * spawns nothing (§6). One command, deliberately: model, provider, directory
 * and shell controls are all support and security surface, and this workflow
 * has not earned any of them yet.
 */
import { connectMessage, runConnect, type MintResult } from './connect.js';
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

/** Asks the gateway, which owns the member lookup and the code. The bot never
 * reaches the database: `(team, user) → owner` is the check §6 marks as the
 * entire security model, and it belongs on the side that can enforce it. */
function mintThrough(
  gateway: string,
  token: string,
  team: string,
): (slackUser: string) => Promise<MintResult> {
  return async (slackUser) => {
    const res = await fetch(`${gateway}/api/slack/pair`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ team, user: slackUser }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 403) return { ok: false, why: 'not-a-member' };
    if (!res.ok) throw new Error(`gateway said ${res.status}`);
    return { ok: true, ...((await res.json()) as { code: string; expiresInMinutes: number }) };
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

const mint = mintThrough(gateway, gatewayToken, team);

const connection = socketMode({
  appToken,
  log,
  onEnvelope: async (envelope) => {
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
