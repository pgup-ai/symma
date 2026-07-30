/**
 * §3's right column: what a member is told about the machine their agent runs
 * on. The gateway supplies the state and stops there — one word for situations
 * a member experiences as completely different things is the whole support
 * burden this exists to split.
 *
 * Every line says what to do next, because "offline" on its own sends someone
 * to whoever administers symma when the answer was to open their own laptop.
 */
import type { EndpointState, SelectedEndpoint } from '@symma/protocol';

/** The device is named mid-sentence throughout: it defaults to empty until a
 * companion attaches and says what it is, so it cannot be relied on to start
 * one. */
const said: Record<EndpointState, (device: string) => string | undefined> = {
  ready: () => undefined,
  // Deliberate, so the fix is theirs and it is one command.
  quit: (device) => `symma is not running on ${device}. Start it there and send this again.`,
  // Inside the resume window, so it is very likely already on its way back.
  // Saying "asleep" here would send someone to a lid that is already open.
  dropped: (device) => `Lost contact with ${device} a moment ago — send this again shortly.`,
  asleep: (device) =>
    `No sign of ${device} right now. Send this again once it is awake and I will pick it up.`,
  // Paired but never once started. Waiting would never end, so say the one
  // thing that ends it.
  unstarted: (device) => `Nothing has ever connected from ${device}. Run \`symma\` on it first.`,
};

/** Why this turn cannot run, in the member's words. Undefined exactly when the
 * state is `ready`, which is what lets the caller read one as the other. */
export function refusal(selected: SelectedEndpoint | undefined): string | undefined {
  if (!selected) {
    return 'You have not paired a machine yet. Run `/connect` and I will send you a code.';
  }
  return said[selected.state](selected.device || 'your machine');
}
