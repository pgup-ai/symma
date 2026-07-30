/**
 * §3's right column: what a member is told about the machine their agent runs
 * on. Every line names what to do next, because "offline" on its own is one
 * word for situations a member experiences as completely different things —
 * and it sends people to whoever administers symma when the answer was to open
 * their own lid.
 */
import type { EndpointState, SelectedEndpoint } from '@symma/protocol';

/** Named mid-sentence throughout: the device is empty until a companion
 * attaches and says what it is, so it cannot be trusted to open one. */
const said: Record<Exclude<EndpointState, 'ready'>, (device: string) => string> = {
  quit: (device) => `symma is not running on ${device}. Start it there and send this again.`,
  // "Asleep" here would send someone to a lid that is already open.
  dropped: (device) => `Lost contact with ${device} a moment ago — send this again shortly.`,
  asleep: (device) =>
    `No sign of ${device} right now. Send this again once it is awake and I will pick it up.`,
  // Waiting on this one would never end, so say the thing that ends it.
  unstarted: (device) => `Nothing has ever connected from ${device}. Run \`symma\` on it first.`,
};

/** Why this turn cannot run, in the member's words. Undefined when it can. */
export function refusal(selected: SelectedEndpoint | undefined): string | undefined {
  if (!selected) {
    return 'You have not paired a machine yet. Run `/connect` and I will send you a code.';
  }
  if (selected.state === 'ready') return undefined;
  return said[selected.state](selected.device || 'your machine');
}
