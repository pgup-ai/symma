/**
 * §3's right column: what a member is told about the machine their agent runs
 * on. Every line names what to do next, because "offline" is one word for
 * situations they experience as completely different things — and it sends
 * people to whoever administers symma when the answer was their own lid.
 */
import type { EndpointState, TurnTarget } from '@symma/protocol';

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

/** What a log records when a turn did not run. `unusable` is the machine being
 * there and the turn still not going — nothing advertised to run, or no token. */
export type RefusalReason = Exclude<EndpointState, 'ready'> | 'unpaired' | 'unusable';

/** Whether this turn can run, and what to say when it cannot — one decision, so
 * a caller cannot read "no refusal" as "go" and find it has nothing to go with. */
export type TurnDecision =
  | { run: true; endpoint: string; agent: string; token: string }
  | { run: false; why: string; because: RefusalReason };

export function decideTurn(target: TurnTarget | undefined): TurnDecision {
  if (!target) {
    return {
      run: false,
      because: 'unpaired',
      why: 'You have not paired a machine yet. Run `/connect` and I will send you a code.',
    };
  }
  const device = target.device || 'your machine';
  const unusable = `${device} is not available right now.`;
  if (target.state === 'ready') {
    return target.agent && target.token
      ? { run: true, endpoint: target.endpoint, agent: target.agent, token: target.token }
      : { run: false, because: 'unusable', why: unusable };
  }
  // The union is a compile-time claim about the wire, and a gateway one release
  // ahead is exactly when it stops holding. Refusing is the safe read of a word
  // this build has never heard: nothing here can tell that it is safe to run.
  const line: ((device: string) => string) | undefined = said[target.state];
  return { run: false, because: target.state, why: line ? line(device) : unusable };
}
