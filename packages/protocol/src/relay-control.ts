import { isSafeId } from './ids.js';

export type SendLine = (line: string) => void;

/** Wire generation, bumped when a companion speaking the previous one can no
 * longer be served correctly. */
export const PROTOCOL_VERSION = 1;

/** Whether a gateway serves a companion of this generation: the current one and
 * the one below (§7.1), so an upgrade never has to land atomically across
 * laptops we don't control. Absent is generation 0 — every companion published
 * before `version` existed is exactly that — so nothing is refused until the
 * first bump, which is the point of shipping the field early.
 *
 * A newer one is refused as well. Lines this gateway cannot read are dropped
 * rather than rejected, so a control from a generation it never learned would
 * vanish silently and hang the session instead of failing it. Gateways learn a
 * generation before any companion claims it, so this only fires on a bad
 * deploy order — which is exactly when it should be loud. */
export const servesProtocol = (version = 0): boolean =>
  version >= PROTOCOL_VERSION - 1 && version <= PROTOCOL_VERSION;

export interface EndpointAgent {
  agent: string;
  /** The companion honors a caller-chosen session mode for this agent (§4).
   * Absent — every companion published before the field — reads as "cannot",
   * which is what keeps an old companion a read-only one rather than one that
   * quietly ignores the mode a member picked. */
  modes?: boolean;
}

/** What `GET /api/endpoints` serves: the gateway builds it, a client reads it
 * to decide whether an endpoint can take the session. Lives here for the same
 * reason the controls do — neither side of a wire owns its shape. */
export interface EndpointPresence {
  endpoint: string;
  device: string;
  agents: EndpointAgent[];
  maxSessions: number;
  activeSessions: number;
  online: boolean;
  /** Epoch ms it was last attached; absent until it first attaches. A crash and
   * a closed lid are not told apart — both are "try later" (§3). */
  lastSeenAt?: number;
  /** The last detach was a goodbye rather than a drop — "quit on your Mac"
   * versus "asleep". Absent while online, and absent after a drop. */
  quit?: boolean;
  /** Verify this endpoint's envelopes against it; absent means it signs none. */
  publicKey?: string;
  /** What it will run in, as advertised. The companion advertises and the
   * caller selects (§4), so this is where the choices come from. */
  workspaces?: EndpointWorkspace[];
}

/**
 * What is known of one endpoint, as a single word (§3). `busy` is attached with
 * every session slot taken; `dropped` is a detach recent enough to be coming
 * back on its own, `asleep` is one that is not, and `unstarted` is paired but
 * never once attached. The words a member reads are the caller's to pick — this
 * is only the fact, which is why the two sit on opposite sides of the wire.
 */
export type EndpointState = 'ready' | 'busy' | 'dropped' | 'quit' | 'asleep' | 'unstarted';

/** One endpoint and its state: what a turn should be routed to. */
export interface SelectedEndpoint {
  endpoint: string;
  device: string;
  state: EndpointState;
}

/**
 * What a caller needs to run one turn on the selected endpoint. Both extras are
 * absent unless the machine can take it: there is nothing to hand over for a
 * laptop that is shut, and a refusal should not cost a credential.
 */
export interface TurnTarget extends SelectedEndpoint {
  /** One the endpoint advertised — an unoffered name is refused (§5). */
  agent?: string;
  /** Where the turn will run, chosen from what this endpoint offers and sticky
   * per conversation (§4). Absent is the no-workspace mode: an empty temp
   * directory, for a machine that advertises no roots. */
  workspace?: string;
  /** Its label, so the answer's scope can be shown rather than guessed at. */
  workspaceLabel?: string;
  /** Short-lived and scoped to the member, so the caller can act as them for
   * the length of one turn and no longer. */
  token?: string;
  /** An agent session this conversation can reattach to, offered only when the
   * machine, agent and directory are the ones it was minted under (§4). */
  resume?: string;
  /** The conversation's session mode; absent is read-only. Served only for a
   * named workspace on an endpoint whose hello advertised modes for the agent. */
  mode?: string;
  /** The model this conversation runs on, off the agent's own roster; absent
   * leaves the agent's configured default. */
  model?: string;
}

/**
 * A directory the companion's owner is willing to let an agent run in, named by
 * an opaque id (§4). The path never crosses the wire: the allowlist *is* the
 * local-filesystem boundary, and a remotely-supplied path would be a straight
 * escape out of the temp dir the review path relies on.
 */
export interface EndpointWorkspace {
  id: string;
  /** For whoever is choosing between them — the id is not meant to be read. */
  label: string;
}

export interface HelloControl {
  kind: 'hello';
  endpoint: string;
  device: string;
  agents: EndpointAgent[];
  maxSessions: number;
  /** Roots this companion will run in. Absent from every companion published
   * before the field existed, which reads as "none". */
  workspaces?: EndpointWorkspace[];
  /** Wire generation this companion speaks. Absent from every companion
   * published before the field existed, which is precisely generation 0. */
  version?: number;
  /** Sessions the companion still has live, so a reattach resumes those and
   * fails the rest (a restarted companion sends none). */
  sessions?: string[];
  /** SPKI PEM the companion signs its envelopes with; absent means unsigned. */
  publicKey?: string;
}

export interface OpenControl {
  kind: 'open';
  sessionId: string;
  runId: string;
  endpoint: string;
  agent: string;
  model?: string;
  /** One the endpoint advertised. Absent is the no-workspace mode §4 keeps for
   * general questions: an empty temp directory, as the review path has always
   * had. Never a path — see `EndpointWorkspace`. */
  workspace?: string;
  /** Session mode the caller chose, one the agent offers. Absent is read-only —
   * also all an older companion can be asked for, since this field reaches it
   * only when its hello advertised `modes` for the agent. */
  mode?: string;
  repo?: string;
  ref?: string;
  base?: string;
}

/** Why an open was refused; `reason` stays the human sentence. Whether to retry
 * is the caller's decision, not ours. */
export type RefusalCode =
  'offline' | 'at_capacity' | 'no_such_agent' | 'no_such_workspace' | 'session_in_use';

const REFUSAL_CODES: RefusalCode[] = [
  'offline',
  'at_capacity',
  'no_such_agent',
  'no_such_workspace',
  'session_in_use',
];

export interface AckControl {
  kind: 'opened' | 'refused';
  sessionId: string;
  reason?: string;
  /** Present on `refused`. */
  code?: RefusalCode;
  /** On `opened`: what the client needs to drive this agent — the workspace
   * the companion checked out, plus the agent's session policy. The companion
   * owns the agent spec, so this is the one place that knowledge lives. */
  workspace?: string;
  requirePlanMode?: boolean;
  modelCandidates?: string[];
  /** How this agent's sessions are picked up locally — the command's verb, which
   * a caller completes with the session id. Only agents whose sessions outlive
   * the run have one, and it is what lets a member carry a turn from chat to
   * their own terminal. */
  resumeWith?: string;
}

export interface CloseControl {
  kind: 'close';
  sessionId: string;
  reason?: string;
}

/** Sent by a companion on its way out, so the relay can tell a quit from a
 * laptop that stopped answering (§3). Sleep suspends the process rather than
 * notifying it, so only the deliberate exit can say which happened — and the
 * relay never *expects* one, since a companion too old to send it looks exactly
 * like one that was killed. Absence is the timestamp fallback §7 asks for. */
export interface GoodbyeControl {
  kind: 'goodbye';
  reason?: string;
}

export type RelayControl = HelloControl | OpenControl | AckControl | CloseControl | GoodbyeControl;

const str = (v: unknown): v is string => typeof v === 'string';

/** Every local resume command a spec supplies today. A closed set rather than a
 * shape: `<word> resume` would still let an endpoint name a shell, and this
 * value is rendered to a member as something to paste. One entry per agent that
 * grows a resumable session. */
const RESUME_COMMANDS = new Set(['codex resume']);

/** Parse one control line; undefined for frames and malformed input. */
export function parseRelayControl(line: string): RelayControl | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== 'object') return undefined;
  switch (raw.kind) {
    case 'hello': {
      if (!str(raw.endpoint) || !isSafeId(raw.endpoint) || !str(raw.device)) return undefined;
      if (!Array.isArray(raw.agents)) return undefined;
      const agents: EndpointAgent[] = [];
      for (const entry of raw.agents as Record<string, unknown>[]) {
        if (!entry || !str(entry.agent)) return undefined;
        // Only literal `true`: the flag gates whether a mode is ever sent, so
        // a value that means nothing must read as "cannot".
        agents.push({ agent: entry.agent, ...(entry.modes === true ? { modes: true } : {}) });
      }
      const max = Number(raw.maxSessions);
      if (!Number.isInteger(max) || max < 1) return undefined;
      let sessions: string[] | undefined;
      if (raw.sessions !== undefined) {
        if (!Array.isArray(raw.sessions) || !raw.sessions.every((s) => isSafeId(s)))
          return undefined;
        sessions = raw.sessions as string[];
      }
      // Rejected rather than dropped, like `sessions` above: the ids are the
      // companion's own derivation, so a malformed one is its bug and not
      // something to answer by quietly advertising nothing.
      let workspaces: EndpointWorkspace[] | undefined;
      if (raw.workspaces !== undefined) {
        if (!Array.isArray(raw.workspaces)) return undefined;
        workspaces = [];
        for (const entry of raw.workspaces as Record<string, unknown>[]) {
          if (!entry || !str(entry.id) || !isSafeId(entry.id) || !str(entry.label))
            return undefined;
          workspaces.push({ id: entry.id, label: entry.label });
        }
      }
      // A JSON number or nothing. Strict where `maxSessions` beside it coerces,
      // because `Number(true)` is 1: a gate on compatibility must not be
      // passable by a value that means nothing. Anything else drops to
      // generation 0 rather than failing the hello — the direction an unknown
      // refusal code drops, and the safe one, since 0 is refused first.
      const version =
        typeof raw.version === 'number' && Number.isInteger(raw.version) && raw.version > 0
          ? raw.version
          : undefined;
      return {
        kind: 'hello',
        endpoint: raw.endpoint,
        device: raw.device,
        agents,
        maxSessions: max,
        ...(version ? { version } : {}),
        ...(sessions ? { sessions } : {}),
        ...(workspaces ? { workspaces } : {}),
        ...(str(raw.publicKey) ? { publicKey: raw.publicKey } : {}),
      };
    }
    case 'open': {
      if (!str(raw.sessionId) || !isSafeId(raw.sessionId)) return undefined;
      if (!str(raw.runId) || !isSafeId(raw.runId)) return undefined;
      if (!str(raw.endpoint) || !isSafeId(raw.endpoint) || !str(raw.agent)) return undefined;
      return {
        kind: 'open',
        sessionId: raw.sessionId,
        runId: raw.runId,
        endpoint: raw.endpoint,
        agent: raw.agent,
        ...(str(raw.model) ? { model: raw.model } : {}),
        // Unchecked on purpose: an id is only ever a key into the companion's
        // allowlist, never resolved into a path, so a name it does not know is
        // refused there rather than dropped here into a temp directory the
        // caller never asked for.
        ...(str(raw.workspace) ? { workspace: raw.workspace } : {}),
        // id-safe or dropped: the value becomes a child process env var on the
        // companion, so the parse is where its alphabet is pinned.
        ...(isSafeId(raw.mode) ? { mode: raw.mode } : {}),
        ...(str(raw.repo) ? { repo: raw.repo } : {}),
        ...(str(raw.ref) ? { ref: raw.ref } : {}),
        ...(str(raw.base) ? { base: raw.base } : {}),
      };
    }
    case 'goodbye':
      return { kind: 'goodbye', ...(str(raw.reason) ? { reason: raw.reason } : {}) };
    case 'opened':
    case 'refused':
    case 'close': {
      if (!str(raw.sessionId) || !isSafeId(raw.sessionId)) return undefined;
      const control = { kind: raw.kind, sessionId: raw.sessionId } as AckControl | CloseControl;
      if (str(raw.reason)) control.reason = raw.reason;
      // An unknown code drops, the frame does not: a relay that learns a new one
      // must not make refusals unreadable to an older client.
      if (raw.kind === 'refused' && REFUSAL_CODES.includes(raw.code as RefusalCode)) {
        (control as AckControl).code = raw.code as RefusalCode;
      }
      if (raw.kind === 'opened') {
        const ack = control as AckControl;
        if (str(raw.workspace)) ack.workspace = raw.workspace;
        if (typeof raw.requirePlanMode === 'boolean') ack.requirePlanMode = raw.requirePlanMode;
        if (Array.isArray(raw.modelCandidates) && raw.modelCandidates.every(str)) {
          ack.modelCandidates = raw.modelCandidates as string[];
        }
        // A caller renders this beside a session id as a command a member can
        // paste, so the shape is pinned here rather than trusted: `<cli> resume`
        // and nothing else. A compromised endpoint is shut down and rotated
        // (invariant 3), but it must not get a free line into someone's shell on
        // the way there.
        if (str(raw.resumeWith) && RESUME_COMMANDS.has(raw.resumeWith))
          ack.resumeWith = raw.resumeWith;
      }
      return control;
    }
    default:
      return undefined;
  }
}
