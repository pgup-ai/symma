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
}

/**
 * What is known of one endpoint, as a single word (§3). `dropped` is a detach
 * recent enough to still be coming back on its own and `asleep` is one that is
 * not; `unstarted` is paired but never once attached, which reads to a member
 * as nothing like a shut lid. The words they see are the caller's to pick —
 * this is only the fact, which is why the two sit on opposite sides of the wire.
 */
export type EndpointState = 'ready' | 'dropped' | 'quit' | 'asleep' | 'unstarted';

/** The endpoint a turn should go to, once something has chosen between them. */
export interface SelectedEndpoint {
  endpoint: string;
  device: string;
  state: EndpointState;
}

export interface HelloControl {
  kind: 'hello';
  endpoint: string;
  device: string;
  agents: EndpointAgent[];
  maxSessions: number;
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
  repo?: string;
  ref?: string;
  base?: string;
}

/** Why an open was refused; `reason` stays the human sentence. Whether to retry
 * is the caller's decision, not ours. */
export type RefusalCode = 'offline' | 'at_capacity' | 'no_such_agent' | 'session_in_use';

const REFUSAL_CODES: RefusalCode[] = ['offline', 'at_capacity', 'no_such_agent', 'session_in_use'];

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
        agents.push({ agent: entry.agent });
      }
      const max = Number(raw.maxSessions);
      if (!Number.isInteger(max) || max < 1) return undefined;
      let sessions: string[] | undefined;
      if (raw.sessions !== undefined) {
        if (!Array.isArray(raw.sessions) || !raw.sessions.every((s) => isSafeId(s)))
          return undefined;
        sessions = raw.sessions as string[];
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
      }
      return control;
    }
    default:
      return undefined;
  }
}
