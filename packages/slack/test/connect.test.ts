import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { connectMessage, runConnect, type MintResult } from '../src/connect.js';

const TEAM = 'T-home';
const minted: MintResult = { ok: true, code: 'BPB1-9W92-HTZJ-RA19', expiresInMinutes: 10 };
const never = (): Promise<MintResult> => {
  throw new Error('should not have minted');
};

describe('/connect', () => {
  it('mints for a member of the workspace it was installed in', async () => {
    let asked: string | undefined;
    const outcome = await runConnect({ team_id: TEAM, user_id: 'U-nel' }, TEAM, (user) => {
      asked = user;
      return Promise.resolve(minted);
    });
    assert.deepEqual(outcome, minted);
    // Slack's assertion of who is asking, never anything they typed — a code
    // minted from command text would pair them as somebody else.
    assert.equal(asked, 'U-nel');
  });

  it('refuses anyone whose identity belongs to another workspace', async () => {
    // A Slack Connect guest arrives with their own team_id, and
    // `(team_id, user_id) → owner` is not well defined for them (§6).
    for (const command of [
      { team_id: 'T-guest', user_id: 'U-nel' },
      { team_id: TEAM }, // no user id at all
      { team_id: TEAM, user_id: 42 },
      {},
    ]) {
      const outcome = await runConnect(command, TEAM, never);
      assert.deepEqual(outcome, { ok: false, why: 'foreign-workspace' }, JSON.stringify(command));
    }
  });

  it('passes a deactivated member through rather than reading it as an outage', async () => {
    // Their row survives the soft delete, so this is a real answer about them —
    // and it must not tell them to retry, which is what `unavailable` says.
    const outcome = await runConnect({ team_id: TEAM, user_id: 'U-gone' }, TEAM, () =>
      Promise.resolve({ ok: false, why: 'not-a-member' }),
    );
    assert.deepEqual(outcome, { ok: false, why: 'not-a-member' });
  });

  it('turns a gateway failure into an answer, not a silent command', async () => {
    const outcome = await runConnect({ team_id: TEAM, user_id: 'U-nel' }, TEAM, () =>
      Promise.reject(new Error('econnrefused')),
    );
    assert.deepEqual(outcome, { ok: false, why: 'unavailable' });
  });

  it('says something actionable for every outcome', () => {
    const success = connectMessage(minted);
    assert.match(success, /symma pair BPB1-9W92-HTZJ-RA19/, 'the whole command, not just the code');
    assert.match(success, /10 minutes/);
    // Minting supersedes, so a second `/connect` kills the code they may have
    // already copied. Saying so beats letting them paste it and read "expired".
    assert.match(success, /again replaces it/);

    const outcomes = [
      { ok: false, why: 'foreign-workspace' },
      { ok: false, why: 'not-a-member' },
      { ok: false, why: 'unavailable' },
    ] as const;
    const said = outcomes.map(connectMessage);
    for (const [i, message] of said.entries()) {
      assert.doesNotMatch(message, /undefined|\[object/, outcomes[i]!.why);
    }
    // Three distinct sentences, so a branch that falls through to another
    // outcome's copy is caught rather than reading as merely terse.
    assert.equal(new Set(said).size, 3);
    // Only the outage invites a retry: the other two would not change.
    assert.match(connectMessage({ ok: false, why: 'unavailable' }), /again is safe/);
    assert.match(connectMessage({ ok: false, why: 'not-a-member' }), /administers/);
  });
});
