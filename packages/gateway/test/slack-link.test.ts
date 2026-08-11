import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LINK_STATE_MS, linkState, readLinkState } from '../src/slack-link.js';

const SECRET = 'bot-secret';
const NOW = 1_700_000_000_000;

describe('slack account linking', () => {
  it('reads back the member it was minted for, and only within its window', () => {
    const state = linkState(SECRET, 'owner-1', NOW);
    assert.equal(readLinkState(SECRET, state, NOW), 'owner-1');
    assert.equal(readLinkState(SECRET, state, NOW + LINK_STATE_MS - 1), 'owner-1');
    // A link sitting in a browser history is not a standing offer to hand over
    // posting rights.
    assert.equal(readLinkState(SECRET, state, NOW + LINK_STATE_MS), undefined);
  });

  it('refuses a state it did not mint', () => {
    // The whole point: without the signature check, anyone who can reach the
    // callback names whichever member they like and files their own Slack token
    // under it — every answer that member shares then goes out as the attacker.
    const forged = Buffer.from('owner-2.' + String(NOW)).toString('base64url');
    for (const state of [
      `${forged}.${'A'.repeat(43)}`, // a signature of the right shape
      forged, // and none at all
      linkState('another-gateway', 'owner-2', NOW),
      // A real signature of ours, over a body naming somebody else.
      `${forged}.${linkState(SECRET, 'owner-1', NOW).split('.')[1]!}`,
    ]) {
      assert.equal(readLinkState(SECRET, state, NOW), undefined, JSON.stringify(state));
    }
  });
});
