import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readTurnTarget } from '../src/turn-target.js';

describe('turn target', () => {
  it('carries every field the gateway offers, or the turn silently loses one', () => {
    // This shape grew `resume` and the bot dropped it, which cost the whole
    // resume path with nothing failing — so the assertion is the whole object.
    assert.deepEqual(
      readTurnTarget({
        endpoint: 'ep-1',
        device: 'the studio Mac',
        state: 'ready',
        agent: 'codex',
        token: 'tok-1',
        workspace: 'ws-1',
        workspaceLabel: 'symma',
        mode: 'agent',
        model: 'gpt-5.6-sol[high]',
        models: [{ modelId: 'gpt-5.6-sol[high]' }],
        agents: ['codex', 'kilo'],
        resume: 'acp-1',
      }),
      {
        endpoint: 'ep-1',
        device: 'the studio Mac',
        state: 'ready',
        agent: 'codex',
        token: 'tok-1',
        workspace: 'ws-1',
        workspaceLabel: 'symma',
        mode: 'agent',
        model: 'gpt-5.6-sol[high]',
        models: [{ modelId: 'gpt-5.6-sol[high]' }],
        agents: ['codex', 'kilo'],
        resume: 'acp-1',
      },
    );
  });

  it('reads `{}` as a member who has paired nothing', () => {
    assert.equal(readTurnTarget({}), undefined);
    // A device is empty until a companion says what it is, and §3 has copy for
    // that — so it is the one absence that is not "nothing paired".
    assert.deepEqual(readTurnTarget({ endpoint: 'ep-1', state: 'asleep' }), {
      endpoint: 'ep-1',
      device: '',
      state: 'asleep',
    });
  });
});
