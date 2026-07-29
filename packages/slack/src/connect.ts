/**
 * `/connect` — the Slack half of pairing (§2). Until now an operator minted
 * codes by hand; this is the button in front of that.
 *
 * The member's Slack identity is the whole input. It is never asked for, typed,
 * or carried in the command text: Socket Mode delivers `team_id` and `user_id`
 * on an authenticated connection, so they are the trusted assertion of who is
 * asking. A code minted from anything the member could type would let them pair
 * as somebody else.
 */

/** What the gateway said. `not-a-member` is a real answer, not an error: a
 * deactivated member keeps their row, so their `/connect` must fail rather than
 * quietly re-admit them. */
export type MintResult =
  { ok: true; code: string; expiresInMinutes: number } | { ok: false; why: 'not-a-member' };

export type ConnectOutcome = MintResult | { ok: false; why: 'foreign-workspace' | 'unavailable' };

export interface SlashCommand {
  team_id?: unknown;
  user_id?: unknown;
  response_url?: unknown;
}

/**
 * Pinned to the one workspace this bot was installed in. A Slack Connect guest
 * arrives with their own `team_id`, and §6 refuses that rather than guessing:
 * `(team_id, user_id) → owner` is not well defined for someone whose identity
 * belongs to another workspace.
 */
export async function runConnect(
  command: SlashCommand,
  team: string,
  mint: (slackUser: string) => Promise<MintResult>,
): Promise<ConnectOutcome> {
  if (command.team_id !== team || typeof command.user_id !== 'string') {
    return { ok: false, why: 'foreign-workspace' };
  }
  try {
    return await mint(command.user_id);
  } catch {
    return { ok: false, why: 'unavailable' };
  }
}

/**
 * Every outcome reaches a sentence the member can act on. A command that fails
 * silently is the failure mode §3 spends its presence copy avoiding, and the
 * one an operator never hears about.
 */
export function connectMessage(outcome: ConnectOutcome): string {
  if (outcome.ok) {
    return [
      `Run this on the machine you want to reach — your agent, your credentials, your files:`,
      '',
      '```',
      `npm i -g symma && symma pair ${outcome.code}`,
      '```',
      '',
      `The code works once and expires in ${outcome.expiresInMinutes} minutes.`,
      // Minting supersedes, so an earlier code is already dead. Saying so beats
      // letting someone paste the one they copied first and read "expired".
      `Running \`/connect\` again replaces it, so use this one or ask again — not both.`,
    ].join('\n');
  }
  if (outcome.why === 'foreign-workspace') {
    return 'symma only pairs members of the workspace it was installed in, so it cannot pair you from here.';
  }
  if (outcome.why === 'not-a-member') {
    return 'Your account is not active in symma. Ask whoever administers it to add you, then run `/connect` again.';
  }
  return 'Could not reach symma to mint a code. Nothing was created, so running `/connect` again is safe.';
}
