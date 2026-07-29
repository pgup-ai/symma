import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { socketMode, type SocketEnvelope, type SocketLike } from '../src/socket-mode.js';

/** Stands in for Slack's end of the socket. */
class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', {});
  }
  addEventListener(
    type: 'open' | 'message' | 'close',
    listener: (event: { data?: unknown }) => void,
  ): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  open(): void {
    this.emit('open', {});
  }
  deliver(frame: unknown): void {
    this.deliverRaw(JSON.stringify(frame));
  }
  deliverRaw(data: string): void {
    this.emit('message', { data });
  }
  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as { data?: unknown });
  }
  acks(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { envelope_id: string }).envelope_id);
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const envelope = (id: string): unknown => ({
  envelope_id: id,
  type: 'slash_commands',
  payload: { command: '/connect' },
});

/** Starts the loop over a queue of sockets and waits for the first dial. */
async function start(sockets: FakeSocket[], onEnvelope: (e: SocketEnvelope) => Promise<void>) {
  const dialled: FakeSocket[] = [];
  const waits: number[] = [];
  const connection = socketMode({
    appToken: 'xapp-test',
    log: () => {},
    onEnvelope,
    dial: () => {
      const next = sockets.shift();
      if (!next) throw new Error('dialled more often than the test expected');
      dialled.push(next);
      return Promise.resolve(next);
    },
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  await tick();
  return { connection, dialled, waits };
}

describe('socket mode', () => {
  it('acks before it starts the work, not after', async () => {
    // Slack redelivers whatever is unacked, so acking after the handler earns a
    // second copy of every command slower than that window — and `/connect`
    // mints, so a second copy is a second credential.
    let release = (): void => {};
    const running = new Promise<void>((resolve) => (release = resolve));
    const socket = new FakeSocket();
    await start([socket], () => running);

    socket.deliver(envelope('e1'));
    assert.deepEqual(socket.acks(), ['e1'], 'acked while the handler is still running');
    release();
  });

  it('acks a redelivery but does not do the work twice', async () => {
    const handled: string[] = [];
    const socket = new FakeSocket();
    await start([socket], async (e) => {
      handled.push(e.envelopeId);
    });

    socket.deliver(envelope('e1'));
    socket.deliver(envelope('e1'));
    await tick();
    // Both acked — an unacked redelivery just comes back again — but the
    // command ran once.
    assert.deepEqual(socket.acks(), ['e1', 'e1']);
    assert.deepEqual(handled, ['e1']);
  });

  it('reconnects when slack asks, and stops when we do', async () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const { connection, dialled } = await start([first, second], async () => {});

    // `refresh_requested` is routine — Slack rotates hosts — so it must not
    // read as the bot being finished.
    first.deliver({ type: 'disconnect', reason: 'refresh_requested' });
    await tick();
    assert.equal(first.closed, true, 'the old socket is closed');
    assert.equal(dialled.length, 2, 'and a new one is dialled');

    connection.stop();
    await tick();
    assert.equal(second.closed, true);
    // The queue holds no third socket, so a reconnect here would throw inside
    // the loop rather than fail quietly.
    assert.equal(dialled.length, 2, 'stop() ends the loop rather than reconnecting');
  });

  it('backs off a handshake that never opens', async () => {
    // `new WebSocket` returns while the handshake is still in flight, so
    // resetting the delay on the dial alone would retry a failing handshake
    // every second — against the very endpoint that hands out the URLs.
    const dead = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
    // One spare: every close dials again, and the last dial is what the loop
    // parks on while this asserts.
    const failing = await start([...dead, new FakeSocket()], async () => {});
    for (const socket of dead) {
      socket.close();
      await tick();
    }
    failing.connection.stop();
    assert.deepEqual(failing.waits, [1_000, 2_000, 4_000], 'the delay grows');

    // And one that does open starts again from the floor, so an ordinary
    // reconnect is not punished for an earlier bad patch.
    const good = new FakeSocket();
    const opening = await start([good, new FakeSocket()], async () => {});
    good.open();
    good.close();
    await tick();
    opening.connection.stop();
    assert.deepEqual(opening.waits, [1_000]);
  });

  it('closes a socket that arrives after stop()', async () => {
    // stop() during an in-flight dial had nothing to close, so the connection
    // landed afterwards and the loop sat waiting on a close nobody would send.
    let settle = (_socket: FakeSocket): void => {};
    const dialling = new Promise<FakeSocket>((resolve) => (settle = resolve));
    const late = new FakeSocket();
    const connection = socketMode({
      appToken: 'xapp-test',
      log: () => {},
      onEnvelope: () => {},
      dial: () => dialling,
      wait: () => Promise.resolve(),
    });

    connection.stop();
    settle(late);
    await tick();
    assert.equal(late.closed, true, 'the late socket is closed rather than held open');
  });

  it('survives a frame it cannot read and a handler that throws', async () => {
    // Neither is a reason to drop a connection that is otherwise fine: one bad
    // command must not take every other member's bot down.
    const socket = new FakeSocket();
    await start([socket], () => Promise.reject(new Error('boom')));

    socket.deliver({ type: 'hello' });
    socket.deliverRaw('{ not json');
    socket.deliver(envelope('e1'));
    await tick();
    assert.equal(socket.closed, false);
    assert.deepEqual(socket.acks(), ['e1'], 'hello and junk are not envelopes to ack');
  });
});
