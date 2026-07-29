/**
 * Socket Mode: the bot dials OUT and holds one WebSocket open, so it needs no
 * public URL, no TLS site and no event endpoint (§6). Node's global `WebSocket`
 * and `fetch` are the transport, which is what keeps it dependency-free.
 */

/** One inbound work item. Slack redelivers an envelope that is not acked, which
 * is why `envelope_id` exists and why it is the dedupe key below. */
export interface SocketEnvelope {
  envelopeId: string;
  type: string;
  payload: Record<string, unknown>;
}

/** The slice of `WebSocket` this uses, so a test can hand over a fake without
 * standing up a WebSocket server. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'message' | 'close', listener: (event: { data?: unknown }) => void): void;
}

export interface SocketModeOptions {
  appToken: string;
  onEnvelope: (envelope: SocketEnvelope) => Promise<void> | void;
  log: (message: string) => void;
  /** Opens the next connection. Injected in tests; the default asks Slack for a
   * URL and dials it. Each connection gets a fresh URL — they are single-use
   * and short-lived, so a reconnect cannot reuse the last one. */
  dial?: () => Promise<SocketLike>;
  /** Replaces the reconnect wait so a test does not sleep. */
  wait?: (ms: number) => Promise<void>;
}

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** A dial that never settles is a bot that never reconnects — the loop cannot
 * reach its own retry while it waits on one. */
const DIAL_TIMEOUT_MS = 10_000;
/** Redelivery follows within seconds, so recent is the only window that matters
 * — and a long-lived bot must not keep one entry per envelope forever. */
const SEEN_LIMIT = 512;

async function openConnection(appToken: string): Promise<SocketLike> {
  const res = await fetch('https://slack.com/api/apps.connections.open', {
    method: 'POST',
    headers: { authorization: `Bearer ${appToken}` },
    signal: AbortSignal.timeout(DIAL_TIMEOUT_MS),
  });
  // Slack answers 200 with `ok: false` for a bad token, so the status alone
  // never says whether this worked.
  const body = (await res.json()) as { ok?: boolean; url?: string; error?: string };
  if (!body.ok || !body.url) {
    throw new Error(`apps.connections.open: ${body.error ?? `http ${res.status}`}`);
  }
  return new WebSocket(body.url) as unknown as SocketLike;
}

/**
 * Runs until `stop()`. Reconnects forever: a bot that quietly stops listening
 * looks exactly like a bot nobody is using, and §6's whole architecture is one
 * long-lived outbound socket.
 */
export function socketMode(options: SocketModeOptions): { stop: () => void } {
  const { appToken, onEnvelope, log } = options;
  const dial = options.dial ?? (() => openConnection(appToken));
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const seen = new Set<string>();
  let stopped = false;
  let socket: SocketLike | undefined;

  // Takes the socket the frame arrived on rather than reading the current one:
  // a late frame from a connection we already replaced would otherwise close
  // its successor.
  const receive = (raw: string, from: SocketLike): void => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // A frame we cannot read is not a reason to drop a healthy connection.
      log('ignoring an unparseable frame');
      return;
    }
    if (frame.type === 'hello') return;
    if (frame.type === 'disconnect') {
      // Slack asks for this on refresh and before taking a host down; it is
      // routine, so the reconnect below treats it as a clean end.
      log(`slack asked us to reconnect (${String(frame.reason ?? 'no reason given')})`);
      from.close();
      return;
    }
    const envelopeId = frame.envelope_id;
    const type = frame.type;
    if (typeof envelopeId !== 'string' || typeof type !== 'string') return;

    // Acked before the work, not after: Slack redelivers what is unacked, so a
    // handler slower than its window would earn a second copy of itself. The
    // dedupe below is what makes that safe rather than merely unlikely.
    from.send(JSON.stringify({ envelope_id: envelopeId }));
    if (seen.has(envelopeId)) {
      log(`ignoring a redelivered ${type}`);
      return;
    }
    if (seen.size >= SEEN_LIMIT) seen.delete(seen.values().next().value!);
    seen.add(envelopeId);

    void (async () => {
      try {
        await onEnvelope({
          envelopeId,
          type,
          payload: (frame.payload ?? {}) as Record<string, unknown>,
        });
      } catch (error) {
        // One member's failed command must not take the socket down with it.
        log(`handling ${type} failed: ${String(error)}`);
      }
    })();
  };

  void (async () => {
    let backoff = BACKOFF_MIN_MS;
    while (!stopped) {
      try {
        const next = (socket = await dial());
        // stop() may have run while this was in flight, when there was no
        // socket yet for it to close.
        if (stopped) {
          next.close();
          return;
        }
        backoff = BACKOFF_MIN_MS;
        log('connected to slack');
        await new Promise<void>((resolve) => {
          next.addEventListener('message', (event) => receive(String(event.data), next));
          next.addEventListener('close', () => resolve());
        });
        log('slack connection closed');
      } catch (error) {
        log(`slack connection failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      socket = undefined;
      if (stopped) return;
      await wait(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  })();

  return {
    stop: () => {
      stopped = true;
      socket?.close();
    },
  };
}
