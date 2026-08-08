/**
 * What the gateway said about the machine this turn would run on.
 *
 * Its own module because the bot's `index.ts` listens at import, so nothing in
 * it has a test near it — and this is the shape that grew a field and lost it
 * silently, which is the failure that extraction is for.
 */
import type { TurnTarget } from '@symma/protocol';

/**
 * Read at the boundary rather than cast: `{}` is the gateway saying this member
 * has paired nothing at all.
 *
 * `device` is deliberately not required — it is empty until a companion
 * attaches and says what it is, and the copy already covers that. `agent`,
 * `token` and `resume` arrive only when the machine can take the turn.
 */
export function readTurnTarget(raw: Partial<TurnTarget>): TurnTarget | undefined {
  if (!raw.endpoint || !raw.state) return undefined;
  return {
    endpoint: raw.endpoint,
    device: raw.device ?? '',
    state: raw.state,
    ...(raw.agent ? { agent: raw.agent } : {}),
    ...(raw.token ? { token: raw.token } : {}),
    ...(raw.workspace ? { workspace: raw.workspace } : {}),
    ...(raw.workspaceLabel ? { workspaceLabel: raw.workspaceLabel } : {}),
    ...(raw.mode ? { mode: raw.mode } : {}),
    ...(raw.model ? { model: raw.model } : {}),
    ...(raw.resume ? { resume: raw.resume } : {}),
  };
}
