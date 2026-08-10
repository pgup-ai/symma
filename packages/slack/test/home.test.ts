import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TurnTarget } from '@symma/protocol';

import { homeBlocks, modelPrompt } from '../src/home.js';
import { DEFAULT_MODEL_ACTION } from '../src/slack-api.js';

const paired: TurnTarget = {
  endpoint: 'e1',
  device: 'ann-box',
  state: 'ready',
  agent: 'codex',
  workspaceLabel: 'symma',
  models: [{ modelId: 'gpt-5.6-sol[high]', name: 'sol' }],
};

const selects = (blocks: Record<string, unknown>[]): Record<string, unknown>[] =>
  blocks.filter((block) => block.type === 'actions').flatMap((block) => block.elements as never[]);

const text = (blocks: Record<string, unknown>[]): string => JSON.stringify(blocks);

describe('the surfaces with no thread under them', () => {
  it('picks a default rather than a conversation model', () => {
    const [select] = selects(homeBlocks(paired));
    // The action id is the whole routing decision. Under `MODEL_ACTION` the
    // handler wants a conversation in the payload, finds none, and returns —
    // the member's pick would vanish without a word.
    assert.equal(select?.action_id, DEFAULT_MODEL_ACTION);
    const [option] = select!.options as { value: string }[];
    assert.deepEqual(JSON.parse(option!.value), { m: 'gpt-5.6-sol[high]', a: 'codex' });
  });

  it('says why there is nothing to pick, rather than rendering an empty picker', () => {
    // Slack rejects an actions block with no elements, and a rejected view is a
    // home tab that stays blank — so an empty roster has to render as a sentence.
    for (const blocks of [
      homeBlocks({ ...paired, models: [] }),
      modelPrompt({ ...paired, models: [] }).blocks,
    ]) {
      assert.deepEqual(selects(blocks), []);
      assert.match(text(blocks), /Ask me something first/);
    }
    // And a different sentence when the machine is down: the gateway serves no
    // roster for one that is not up, and "ask me something first" would send
    // them to a bot that cannot answer.
    const asleep = { ...paired, state: 'asleep' as const, models: [] };
    assert.match(text(modelPrompt(asleep).blocks), /arrives with your machine/);
  });

  it('tells an unpaired member what to run, and never offers a picker', () => {
    for (const blocks of [homeBlocks(undefined), modelPrompt(undefined).blocks]) {
      assert.match(text(blocks), /\/connect/);
      assert.deepEqual(selects(blocks), []);
    }
  });

  it('renders the setup as it is, not as it would read best', () => {
    assert.match(text(homeBlocks(paired)), /start in `symma`/);
    assert.match(text(homeBlocks({ ...paired, state: 'asleep' })), /not reachable/);
    // A machine offering no approved project still runs, in a temp directory —
    // so the row says that rather than going missing.
    assert.match(
      text(homeBlocks({ ...paired, workspaceLabel: undefined })),
      /No approved projects/,
    );
  });
});
