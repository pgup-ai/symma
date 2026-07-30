import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  socketMode,
  type SlackEvent,
  type SocketEnvelope,
  type SocketLike,
} from '../src/socket-mode.js';

/**
 * Stands in for `SocketModeClient`. The connection itself is the SDK's — what is
 * tested here is the policy it leaves to us: when to acknowledge, and what to do
 * with a delivery already handled.
 */
class FakeClient implements SocketLike {
  acked: string[] = [];
  started = false;
  stopped = false;
  /** Set to make `start()` reject the way a bad app token does. */
  failStart?: Error;
  private listener?: (item: SlackEvent) => void;

  on(_event: 'slack_event', listener: (item: SlackEvent) => void): this {
    this.listener = listener;
    return this;
  }
  start(): Promise<unknown> {
    this.started = true;
    return this.failStart ? Promise.reject(this.failStart) : Promise.resolve({});
  }
  disconnect(): Promise<unknown> {
    this.stopped = true;
    return Promise.resolve();
  }
  deliver(item: Partial<SlackEvent>): void {
    this.listener?.({
      ack: () => {
        this.acked.push(String(item.envelope_id));
        return Promise.resolve();
      },
      ...item,
    } as SlackEvent);
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const envelope = (id: string): Partial<SlackEvent> => ({
  envelope_id: id,
  type: 'slash_commands',
  body: { command: '/connect' },
});

function start(onEnvelope: (e: SocketEnvelope) => Promise<void> | void) {
  const client = new FakeClient();
  const connection = socketMode({ appToken: 'xapp-test', log: () => {}, onEnvelope, client });
  return { client, connection };
}

describe('socket mode', () => {
  it('acks before it starts the work, not after', async () => {
    // Slack redelivers whatever is unacked, so acking after the handler earns a
    // second copy of every command slower than that window — and `/connect`
    // mints, so a second copy is a second credential.
    let release = (): void => {};
    const running = new Promise<void>((resolve) => (release = resolve));
    const { client } = start(() => running);

    client.deliver(envelope('e1'));
    assert.deepEqual(client.acked, ['e1'], 'acked while the handler is still running');
    release();
  });

  it('acks a redelivery but does not do the work twice', async () => {
    const handled: string[] = [];
    const { client } = start((e) => {
      handled.push(e.envelopeId);
    });

    client.deliver(envelope('e1'));
    client.deliver({ ...envelope('e1'), retry_num: 1 });
    await tick();
    // Both acked — an unacked redelivery just comes back again — but the command
    // ran once. Slack's own `retry_num` says the second is a retry; the envelope
    // id is what makes that a decision rather than a hint.
    assert.deepEqual(client.acked, ['e1', 'e1']);
    assert.deepEqual(handled, ['e1']);
  });

  it('survives a frame it cannot use and a handler that throws', async () => {
    // Neither is a reason to drop a connection that is otherwise fine: one bad
    // command must not take every other member's bot down.
    const { client } = start(() => Promise.reject(new Error('boom')));

    client.deliver({ type: 'slash_commands' }); // no envelope id to ack
    client.deliver(envelope('e1'));
    await tick();
    assert.deepEqual(client.acked, ['e1'], 'nothing to ack without an envelope id');
  });

  it('hands a failed start back rather than logging it away', async () => {
    // The SDK retries everything transient before rejecting, so what reaches
    // here is permanent. Swallowed, it would leave a process that is up, green
    // to every health check, and deaf — which is why the caller gets to exit.
    const client = new FakeClient();
    client.failStart = new Error('invalid_auth');
    const connection = socketMode({
      appToken: 'xapp-test',
      log: () => {},
      onEnvelope: () => {},
      client,
    });

    await assert.rejects(() => connection.ready, /invalid_auth/);
  });

  it('starts on construction and disconnects when told', async () => {
    const { client, connection } = start(() => {});
    await tick();
    assert.equal(client.started, true);
    connection.stop();
    await tick();
    assert.equal(client.stopped, true);
  });
});
