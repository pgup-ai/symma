/**
 * The state that carries a member through Slack's OAuth consent and back.
 *
 * Signed rather than stored: a row per abandoned click is a table nobody
 * prunes. Its own module because `server.ts` listens at import and so cannot be
 * tested, and this is the half where being wrong is a member's posting rights
 * filed under somebody else's name.
 *
 * Not a credential: it proves only that this gateway minted it, and the
 * callback still checks the account coming back is the member it names.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Ten minutes, like a pairing code: long enough to read a consent screen, and
 * short enough that a link left in a browser history is not a standing offer. */
export const LINK_STATE_MS = 10 * 60_000;

export const linkState = (secret: string, owner: string, at: number): string => {
  const body = Buffer.from(`${owner}.${String(at)}`).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
};

export function readLinkState(secret: string, state: string, now: number): string | undefined {
  const [body, signature, extra] = state.split('.');
  if (!body || !signature || extra !== undefined) return undefined;
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'));
  const offered = Buffer.from(signature);
  // Length first: `timingSafeEqual` throws on a mismatch rather than answering,
  // and a forged state is exactly where that arrives.
  if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) return undefined;
  const [owner, at] = Buffer.from(body, 'base64url').toString().split('.');
  // Both ends of the window: a state minted ahead of this clock would otherwise
  // outlive the ten minutes by however far the two disagree.
  const age = now - Number(at);
  if (!owner || !at || !(age >= 0 && age < LINK_STATE_MS)) return undefined;
  return owner;
}
