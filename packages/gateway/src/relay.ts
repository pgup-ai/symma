/**
 * Pairing relay: routes live ACP sessions between clients and outbound-dialed
 * companion endpoints. Pure state machine — transports inject `send`
 * callbacks, storage stays in server.ts — so pairing, presence, capacity, and
 * resume decisions are unit-testable without sockets.
 * Spec: docs/design/m2-acp-gateway.md.
 */
import {
  isSafeId,
  type AckControl,
  type EndpointPresence,
  type CloseControl,
  type HelloControl,
  type OpenControl,
  type RefusalCode,
  type SendLine,
} from '@symma/protocol';

/** `SYMMA_GATEWAY_ENDPOINTS="id:token,id2:token2"` → per-endpoint bearer tokens. */
export function parseEndpointTokens(raw: string | undefined): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const entry of raw?.split(',') ?? []) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    const id = colon === -1 ? '' : trimmed.slice(0, colon);
    const token = colon === -1 ? '' : trimmed.slice(colon + 1);
    if (isSafeId(id) && token) tokens.set(id, token);
  }
  return tokens;
}

interface Attachment {
  hello: HelloControl;
  send: SendLine;
  sessions: Set<string>;
  online: boolean;
}

type ResumeLeg = 'endpointResume' | 'clientResume';

interface Session {
  runId: string;
  endpoint: string;
  clientSend: SendLine;
  // A leg's timer is armed while that peer is disconnected; either firing
  // fails the session past the window. Both legs get the same grace.
  endpointResume?: ReturnType<typeof setTimeout>;
  clientResume?: ReturnType<typeof setTimeout>;
}

export interface RelayOptions {
  resumeWindowMs?: number;
  /** Both directions of every relayed line, for journaling. */
  onLine?: (sessionId: string, runId: string, dir: 'in' | 'out', line: string) => void;
  onSessionFailed?: (sessionId: string, reason: string) => void;
}

export function createRelay(options: RelayOptions = {}) {
  const resumeWindowMs = options.resumeWindowMs ?? 60_000;
  const endpoints = new Map<string, Attachment>();
  const sessions = new Map<string, Session>();

  const disarm = (session: Session, leg: ResumeLeg): void => {
    if (session[leg]) {
      clearTimeout(session[leg]);
      session[leg] = undefined;
    }
  };
  const arm = (sessionId: string, leg: ResumeLeg, reason: string): void => {
    const session = sessions.get(sessionId);
    if (!session || session[leg]) return;
    const timer = setTimeout(() => failSession(sessionId, reason), resumeWindowMs);
    timer.unref?.();
    session[leg] = timer;
  };

  const failSession = (sessionId: string, reason: string): void => {
    const session = sessions.get(sessionId);
    if (!session) return;
    disarm(session, 'endpointResume');
    disarm(session, 'clientResume');
    sessions.delete(sessionId);
    endpoints.get(session.endpoint)?.sessions.delete(sessionId);
    const close = JSON.stringify({ kind: 'close', sessionId, reason } satisfies CloseControl);
    session.clientSend(close);
    endpoints.get(session.endpoint)?.send(close);
    options.onSessionFailed?.(sessionId, reason);
  };

  return {
    /** Companion (re)attached. Sessions the companion still declares resume
     * (cancel their resume timers); any it dropped — e.g. after a restart —
     * fail loudly instead of lingering as zombies that hold capacity. */
    attachEndpoint(hello: HelloControl, send: SendLine): void {
      const existing = endpoints.get(hello.endpoint);
      const declared = new Set(hello.sessions ?? [...(existing?.sessions ?? [])]);
      const carried = new Set<string>();
      for (const sessionId of existing?.sessions ?? []) {
        if (!declared.has(sessionId)) {
          failSession(sessionId, 'endpoint reattached without this session');
          continue;
        }
        carried.add(sessionId);
        const session = sessions.get(sessionId);
        if (session) disarm(session, 'endpointResume');
      }
      endpoints.set(hello.endpoint, { hello, send, sessions: carried, online: true });
      // A companion may still be running agents for sessions the relay already
      // failed (resume window elapsed while it was gone) — tell it to close them.
      for (const sessionId of hello.sessions ?? []) {
        if (!sessions.has(sessionId)) {
          send(JSON.stringify({ kind: 'close', sessionId, reason: 'session already ended' }));
        }
      }
    },

    detachEndpoint(endpoint: string): void {
      const attachment = endpoints.get(endpoint);
      if (!attachment) return;
      attachment.online = false;
      for (const sessionId of attachment.sessions) {
        arm(sessionId, 'endpointResume', 'endpoint gone past resume window');
      }
    },

    /** Client SSE leg dropped — give it the same resume grace as the endpoint
     * side, so a transient blip (or the gateway's own SIGTERM drain) doesn't
     * tear the session down. A reattach within the window cancels it. */
    detachClient(sessionId: string): void {
      arm(sessionId, 'clientResume', 'client gone past resume window');
    },

    attachClient(sessionId: string): void {
      const session = sessions.get(sessionId);
      if (session) disarm(session, 'clientResume');
    },

    listEndpoints(): EndpointPresence[] {
      return [...endpoints.values()].map(({ hello, sessions: active, online }) => ({
        endpoint: hello.endpoint,
        device: hello.device,
        agents: hello.agents,
        maxSessions: hello.maxSessions,
        activeSessions: active.size,
        online,
        ...(hello.publicKey ? { publicKey: hello.publicKey } : {}),
      }));
    },

    /** Route a client's open to its endpoint, or refuse synchronously. */
    openSession(control: OpenControl, clientSend: SendLine): void {
      const refuse = (code: RefusalCode, reason: string): void =>
        clientSend(
          JSON.stringify({
            kind: 'refused',
            sessionId: control.sessionId,
            code,
            reason,
          } satisfies AckControl),
        );
      const attachment = endpoints.get(control.endpoint);
      if (!attachment?.online) return refuse('offline', 'endpoint offline');
      if (sessions.has(control.sessionId)) return refuse('session_in_use', 'session id in use');
      if (attachment.sessions.size >= attachment.hello.maxSessions)
        return refuse('at_capacity', 'at capacity');
      if (!attachment.hello.agents.some((a) => a.agent === control.agent))
        return refuse('no_such_agent', `agent ${control.agent} not offered`);
      sessions.set(control.sessionId, {
        runId: control.runId,
        endpoint: control.endpoint,
        clientSend,
      });
      attachment.sessions.add(control.sessionId);
      attachment.send(JSON.stringify(control));
    },

    /** opened/refused from the companion; a refusal frees the slot. Ignored
     * unless the session belongs to this endpoint (no cross-endpoint spoofing). */
    endpointAck(endpoint: string, control: AckControl, line: string): void {
      const session = sessions.get(control.sessionId);
      if (session?.endpoint !== endpoint) return;
      session.clientSend(line);
      if (control.kind === 'refused') {
        sessions.delete(control.sessionId);
        endpoints.get(endpoint)?.sessions.delete(control.sessionId);
      }
    },

    /** Frame from the companion side, relayed to its session's client. A
     * companion can only reach sessions it owns. */
    endpointLine(endpoint: string, sessionId: string, line: string): void {
      const session = sessions.get(sessionId);
      if (session?.endpoint !== endpoint) return;
      options.onLine?.(sessionId, session.runId, 'in', line);
      session.clientSend(line);
    },

    /** Close initiated by a companion — only for its own sessions. */
    endpointClose(endpoint: string, sessionId: string, reason: string): void {
      if (sessions.get(sessionId)?.endpoint === endpoint) failSession(sessionId, reason);
    },

    /** Frame from the client side, relayed to the owning endpoint. */
    clientLine(sessionId: string, line: string): void {
      const session = sessions.get(sessionId);
      if (!session) return;
      options.onLine?.(sessionId, session.runId, 'out', line);
      endpoints.get(session.endpoint)?.send(line);
    },

    closeSession(sessionId: string, reason = 'closed'): void {
      failSession(sessionId, reason);
    },

    sessionRun(sessionId: string): string | undefined {
      return sessions.get(sessionId)?.runId;
    },
  };
}
