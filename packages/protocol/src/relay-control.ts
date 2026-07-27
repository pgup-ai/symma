import { isSafeId } from './ids.js';

export type SendLine = (line: string) => void;

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
  /** Verify this endpoint's envelopes against it; absent means it signs none. */
  publicKey?: string;
}

export interface HelloControl {
  kind: 'hello';
  endpoint: string;
  device: string;
  agents: EndpointAgent[];
  maxSessions: number;
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

export interface AckControl {
  kind: 'opened' | 'refused';
  sessionId: string;
  reason?: string;
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

export type RelayControl = HelloControl | OpenControl | AckControl | CloseControl;

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
      return {
        kind: 'hello',
        endpoint: raw.endpoint,
        device: raw.device,
        agents,
        maxSessions: max,
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
    case 'opened':
    case 'refused':
    case 'close': {
      if (!str(raw.sessionId) || !isSafeId(raw.sessionId)) return undefined;
      const control = { kind: raw.kind, sessionId: raw.sessionId } as AckControl | CloseControl;
      if (str(raw.reason)) control.reason = raw.reason;
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
