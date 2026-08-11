/**
 * The state that carries a member through Slack's OAuth consent and back.
 *
 * Signed rather than stored: it has to survive a round trip through a browser
 * and Slack, and a row per abandoned click is a table nobody prunes. Its own
 * module because `server.ts` starts listening at import, so nothing in there
 * can be tested directly — and this is the half of the flow where being wrong
 * is a member's posting rights filed under somebody else's name.
 *
 * It is not a credential. It proves only that this gateway minted it, and the
 * callback still checks the Slack account that comes back is the member it
 * names.
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
  if (!owner || !at || !(now - Number(at) < LINK_STATE_MS)) return undefined;
  return owner;
}
