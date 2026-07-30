import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EndpointPresence } from '@symma/protocol';

import { selectEndpoint } from '../src/select-endpoint.js';
import type { PairedEndpoint } from '../src/store.js';

const paired = (id: string, over: Partial<PairedEndpoint> = {}): PairedEndpoint => ({
  id,
  device: id,
  lastSeenAt: null,
  ...over,
});

const attached = (endpoint: string, over: Partial<EndpointPresence> = {}): EndpointPresence => ({
  endpoint,
  device: endpoint,
  agents: [],
  maxSessions: 2,
  activeSessions: 0,
  online: true,
  ...over,
});

const live = (...entries: EndpointPresence[]): Map<string, EndpointPresence> =>
  new Map(entries.map((e) => [e.endpoint, e]));

/** The relay's own classifier is asserted next door. Here it only has to turn
 * on `online`, so what these pin is the ordering rather than the wording. */
const stateOf = (p: EndpointPresence): 'ready' | 'asleep' => (p.online ? 'ready' : 'asleep');

describe('endpoint selection', () => {
  it('has nothing to say about a member who has paired none', () => {
    assert.equal(selectEndpoint([], live(), stateOf), undefined);
  });

  it('tells a machine that has never run from one that is only away', () => {
    // Both are absent from the relay, and they are completely different
    // answers: one ends by opening a lid, the other by running the thing.
    assert.equal(selectEndpoint([paired('fresh')], live(), stateOf)?.state, 'unstarted');
    assert.equal(
      selectEndpoint([paired('used', { lastSeenAt: 1 })], live(), stateOf)?.state,
      'asleep',
    );
  });

  it('prefers the one that can take the turn over the one seen most recently', () => {
    const selected = selectEndpoint(
      [paired('laptop', { lastSeenAt: 1 }), paired('desktop', { lastSeenAt: 9_999 })],
      live(attached('laptop')),
      stateOf,
    );
    assert.equal(selected?.endpoint, 'laptop');
  });

  it('reads a re-attached machine off its row, not the detach it still carries', () => {
    // The relay keeps `lastSeenAt` across a re-attach, so on one that is
    // attached now it holds the previous detach. Ordering on that would hand
    // the turn to the machine that has been up for less time.
    const selected = selectEndpoint(
      [paired('laptop', { lastSeenAt: 500 }), paired('spare', { lastSeenAt: 400 })],
      live(attached('laptop', { lastSeenAt: 1 }), attached('spare')),
      stateOf,
    );
    assert.equal(selected?.endpoint, 'laptop');
  });

  it('names a machine as it calls itself, and as it was paired when it cannot', () => {
    const row = [paired('ep', { device: 'the paired name' })];
    assert.equal(
      selectEndpoint(row, live(attached('ep', { device: 'the live name' })), stateOf)?.device,
      'the live name',
    );
    assert.equal(selectEndpoint(row, live(), stateOf)?.device, 'the paired name');
  });
});
