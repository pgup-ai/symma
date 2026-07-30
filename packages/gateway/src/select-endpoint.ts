/**
 * Which of a member's machines a turn should go to — §4's "the companion
 * advertises, the gateway selects".
 *
 * Its own module because `server.ts` listens at import, so nothing there can be
 * reached without a socket and a database in front of it. These rules are worth
 * asserting on their own, and the per-conversation picker §4 wants next lands
 * here beside them.
 */
import type { EndpointPresence, EndpointState, SelectedEndpoint } from '@symma/protocol';

import type { PairedEndpoint } from './store.js';

/** Busy beats away: its slots free up, and a shut laptop does not. */
const rank = (state: EndpointState): number => (state === 'ready' ? 0 : state === 'busy' ? 1 : 2);

export function selectEndpoint(
  paired: PairedEndpoint[],
  live: Map<string, EndpointPresence>,
  stateOf: (presence: EndpointPresence) => EndpointState,
): SelectedEndpoint | undefined {
  const best = paired
    .map((row) => {
      const presence = live.get(row.id);
      return {
        endpoint: row.id,
        // What it calls itself while attached, else what it was called when
        // paired — the row is all there is before it has ever run.
        device: presence?.device || row.device,
        // Absent from the relay only means it has not attached since this
        // gateway started; the row says whether it ever has at all.
        state: presence ? stateOf(presence) : row.lastSeenAt === null ? 'unstarted' : 'asleep',
        // The relay carries `lastSeenAt` across a re-attach, so on one attached
        // now it holds the *previous* detach. The row was stamped at this
        // attach, which is the clock that means "seen".
        seen: (presence?.online ? undefined : presence?.lastSeenAt) ?? row.lastSeenAt ?? 0,
      };
    })
    // One that can take the turn wins, then one that is at least here, then the
    // most recently seen — the answer is about the machine the member last
    // worked on, not one they forgot they paired.
    .sort((a, b) => rank(a.state) - rank(b.state) || b.seen - a.seen)[0];
  return best && { endpoint: best.endpoint, device: best.device, state: best.state };
}
