/**
 * Socket Mode: the bot dials OUT and holds one WebSocket open, so it needs no
 * public URL, no TLS site and no event endpoint (§6).
 *
 * `@slack/socket-mode` owns the connection: the handshake, ping/pong, the
 * `disconnect` frame and reconnect backoff. What stays here is the policy it
 * deliberately leaves to its caller — when to acknowledge, and what to do about
 * a delivery already handled.
 */
import { SocketModeClient } from '@slack/socket-mode';

/** One inbound work item. */
export interface SocketEnvelope {
  envelopeId: string;
  type: string;
  payload: Record<string, unknown>;
}

/** What this uses of `SocketModeClient`, so a test can hand over a stub instead
 * of a live WebSocket. */
export interface SocketLike {
  on(event: 'slack_event', listener: (item: SlackEvent) => void): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<unknown>;
}

/** The SDK's `slack_event` shape, narrowed to what is read here. */
export interface SlackEvent {
  ack: (response?: unknown) => Promise<void>;
  envelope_id?: unknown;
  type?: unknown;
  body?: unknown;
  /** Slack's own count of how many times it has redelivered this. */
  retry_num?: unknown;
}

interface SocketModeOptions {
  appToken: string;
  onEnvelope: (envelope: SocketEnvelope) => Promise<void> | void;
  log: (message: string) => void;
  client?: SocketLike;
}

/** Bounded so a long-lived bot does not keep one entry per envelope forever.
 * Redelivery follows within seconds, so recent is the only window that matters. */
const SEEN_LIMIT = 512;

export function socketMode(options: SocketModeOptions): {
  ready: Promise<void>;
  stop: () => void;
} {
  const { onEnvelope, log } = options;
  const client = options.client ?? new SocketModeClient({ appToken: options.appToken });
  const seen = new Set<string>();

  client.on('slack_event', (item) => {
    const envelopeId = item.envelope_id;
    const type = item.type;
    if (typeof envelopeId !== 'string' || typeof type !== 'string') {
      // Every envelope Slack sends carries both, so this should never fire —
      // which is why it is worth hearing about when it does.
      log('ignoring a frame with no envelope id or type');
      return;
    }

    // Acknowledged before the work, not after: Slack redelivers what is unacked,
    // so a handler slower than that window would earn a second copy of itself.
    // The dedupe below is what makes that safe rather than merely unlikely, and
    // `retry_num` is Slack saying outright that this is one.
    void item.ack().catch((error: unknown) => log(`ack failed: ${String(error)}`));
    if (seen.has(envelopeId)) {
      log(
        `ignoring a redelivered ${type}${item.retry_num ? ` (retry ${String(item.retry_num)})` : ''}`,
      );
      return;
    }
    if (seen.size >= SEEN_LIMIT) seen.delete(seen.values().next().value!);
    seen.add(envelopeId);

    void (async () => {
      try {
        await onEnvelope({
          envelopeId,
          type,
          payload: (item.body ?? {}) as Record<string, unknown>,
        });
      } catch (error) {
        // One member's failed command must not take the socket down with it.
        log(`handling ${type} failed: ${String(error)}`);
      }
    })();
  });

  // The SDK retries anything transient before rejecting, so a rejection here is
  // permanent — a bad token, a deleted app. Handed back because the answer to
  // that is exiting, which is the caller's call, not a connection helper's.
  const ready = client.start().then(() => log('connected to slack'));

  return {
    ready,
    stop: () => {
      void client.disconnect().catch((error: unknown) => log(`disconnect: ${String(error)}`));
    },
  };
}
