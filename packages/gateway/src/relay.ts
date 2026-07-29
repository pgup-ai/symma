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
  /** Assigned from the endpoint's token at attach — never read off `hello`,
   * which is companion-declared and so attacker-controlled (§1). */
  owner: string;
  send: SendLine;
  sessions: Set<string>;
  online: boolean;
  /** Epoch ms this attachment last went offline; carried across a reattach so
   * a member always sees when it was last there. */
  lastSeenAt?: number;
  /** It said goodbye on the way out, rather than simply stopping. */
  quit?: boolean;
  /** Bumped per attach. A restarted companion's old ingest leg can still be
   * draining, so a frame from it must not speak for the attachment that
   * replaced it. */
  generation: number;
}

type ResumeLeg = 'endpointResume' | 'clientResume';

interface Session {
  runId: string;
  endpoint: string;
  /** The caller openSession accepted. Every later touch of this session — the
   * client leg, its frames, its close — is checked against it. */
  owner: string;
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
  let attachments = 0;
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
     * fail loudly instead of lingering as zombies that hold capacity.
     *
     * Returns this attachment's generation, which a later goodbye must present
     * to be believed. */
    attachEndpoint(hello: HelloControl, send: SendLine, owner: string): number {
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
      // `quit` is not carried across: it describes how the last attachment
      // ended, and this one has not.
      const generation = ++attachments;
      endpoints.set(hello.endpoint, {
        hello,
        send,
        owner,
        sessions: carried,
        online: true,
        lastSeenAt: existing?.lastSeenAt,
        generation,
      });
      // A companion may still be running agents for sessions the relay already
      // failed (resume window elapsed while it was gone) — tell it to close them.
      for (const sessionId of hello.sessions ?? []) {
        if (!sessions.has(sessionId)) {
          send(JSON.stringify({ kind: 'close', sessionId, reason: 'session already ended' }));
        }
      }
      return generation;
    },

    /** A companion said it is leaving. Recorded rather than acted on: the leg
     * closing is what detaches it, and this only marks which of the two ways
     * that happened.
     *
     * Scoped to the attachment that sent it. A companion restarted by its login
     * service attaches while its old ingest leg is still draining, and that
     * leg's goodbye would otherwise label the new attachment — so its next
     * crash would read as a deliberate quit. */
    sayGoodbye(endpoint: string, generation: number): void {
      const attachment = endpoints.get(endpoint);
      if (attachment?.generation === generation) attachment.quit = true;
    },
    detachEndpoint(endpoint: string): void {
      const attachment = endpoints.get(endpoint);
      if (!attachment) return;
      attachment.online = false;
      attachment.lastSeenAt = Date.now();
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

    /** Who an attached endpoint belongs to; undefined if it is not attached. */
    endpointOwner(endpoint: string): string | undefined {
      return endpoints.get(endpoint)?.owner;
    },

    /** Undefined while no session by that id is open, which is the normal state
     * when a client connects its leg before sending the open. */
    sessionOwner(sessionId: string): string | undefined {
      return sessions.get(sessionId)?.owner;
    },

    /** Sessions retention must leave alone: their frames are still arriving.
     * Whole keys, not ids — an id alone names a different session under another
     * endpoint, and would shield it from ever expiring. */
    liveSessions(): { endpoint: string; runId: string; sessionId: string }[] {
      return [...sessions.entries()].map(([sessionId, s]) => ({
        endpoint: s.endpoint,
        runId: s.runId,
        sessionId,
      }));
    },

    listEndpoints(owner: string): EndpointPresence[] {
      return [...endpoints.values()]
        .filter((a) => a.owner === owner)
        .map(({ hello, sessions: active, online, lastSeenAt, quit }) => ({
          endpoint: hello.endpoint,
          device: hello.device,
          agents: hello.agents,
          maxSessions: hello.maxSessions,
          activeSessions: active.size,
          online,
          ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
          ...(!online && quit ? { quit: true } : {}),
          ...(hello.publicKey ? { publicKey: hello.publicKey } : {}),
        }));
    },

    /** Route a client's open to its endpoint, or refuse synchronously. Returns
     * whether it was accepted — `sessionRun` cannot answer that, since a
     * `session_in_use` refusal means someone else's session holds the id. */
    openSession(control: OpenControl, clientSend: SendLine, caller: string): boolean {
      const refuse = (code: RefusalCode, reason: string): false => {
        clientSend(
          JSON.stringify({
            kind: 'refused',
            sessionId: control.sessionId,
            code,
            reason,
          } satisfies AckControl),
        );
        return false;
      };
      const attachment = endpoints.get(control.endpoint);
      // Someone else's endpoint is indistinguishable from one that is away:
      // which endpoints exist is not the caller's to learn by probing.
      if (!attachment?.online || attachment.owner !== caller)
        return refuse('offline', 'endpoint offline');
      if (sessions.has(control.sessionId)) return refuse('session_in_use', 'session id in use');
      if (attachment.sessions.size >= attachment.hello.maxSessions)
        return refuse('at_capacity', 'at capacity');
      if (!attachment.hello.agents.some((a) => a.agent === control.agent))
        return refuse('no_such_agent', `agent ${control.agent} not offered`);
      sessions.set(control.sessionId, {
        runId: control.runId,
        endpoint: control.endpoint,
        owner: caller,
        clientSend,
      });
      attachment.sessions.add(control.sessionId);
      attachment.send(JSON.stringify(control));
      return true;
    },

    /** opened/refused from the companion; a refusal frees the slot. Ignored
     * unless the session belongs to this endpoint (no cross-endpoint spoofing). */
    endpointAck(endpoint: string, control: AckControl, line: string): boolean {
      const session = sessions.get(control.sessionId);
      // A companion naming a session it does not hold is ignored, and the
      // caller must learn that: acting on a forged refusal would delete the
      // real owner's row.
      if (session?.endpoint !== endpoint) return false;
      session.clientSend(line);
      if (control.kind === 'refused') {
        sessions.delete(control.sessionId);
        endpoints.get(endpoint)?.sessions.delete(control.sessionId);
      }
      return true;
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
