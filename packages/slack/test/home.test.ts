import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TurnTarget } from '@symma/protocol';

import { homeBlocks, modelPrompt } from '../src/home.js';
import { DEFAULT_AGENT_ACTION, DEFAULT_MODEL_ACTION, DISCONNECT_ACTION } from '../src/slack-api.js';

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

  it('offers the agents the machine has, and only where there is a choice', () => {
    const picker = (target: TurnTarget): Record<string, unknown> | undefined =>
      selects(homeBlocks(target)).find((s) => s.action_id === DEFAULT_AGENT_ACTION);
    // One agent is not a choice — a picker with a single option is a control
    // that does nothing, so the gateway does not send the list and this renders
    // none. Above the model picker, which is the smaller of the two decisions.
    assert.equal(picker(paired), undefined);

    const both = { ...paired, agents: ['codex', 'kilo'] };
    const shown = picker(both)!;
    assert.deepEqual(
      (shown.options as { value: string }[]).map((o) => JSON.parse(o.value)),
      [{ m: 'codex' }, { m: 'kilo' }],
      'the agent it carries, and no conversation — this is a member-level pick',
    );
    // The one they are on is the current selection, not just an option in the
    // list: a picker that shows no selection reads as nothing being chosen.
    assert.equal((shown.initial_option as { value: string }).value, JSON.stringify({ m: 'codex' }));

    // The list only exists while the machine is attached to say what it runs, so
    // a member looking mid-turn finds the section gone rather than empty. Said,
    // the way the model list below it is — and not said where the machine is up
    // and simply has one agent, which is not a control that went missing.
    const away = { ...both, state: 'busy' as const, agents: undefined };
    assert.equal(picker(away), undefined);
    assert.match(text(homeBlocks(away)), /Your agents arrive with your machine/);
    assert.doesNotMatch(text(homeBlocks(paired)), /Your agents arrive/);
  });

  it('offers to post as them, says so once it can, and nothing where it cannot', () => {
    // Three states, and the third is every deployment without Slack app
    // credentials: an offer that cannot be taken up is worse than no offer.
    assert.match(
      text(homeBlocks(paired, { linked: false, url: 'https://slack.test/oauth' })),
      /https:\/\/slack.test\/oauth/,
    );
    // Linked, they get the way back out: a credential granted with a button
    // needs one to hand it back, and it is the only control that recovers a tab
    // still claiming they post as themselves after an unlink failed.
    assert.match(text(homeBlocks(paired, { linked: true })), /go out as you/);
    assert.match(text(homeBlocks(paired, { linked: true })), new RegExp(DISCONNECT_ACTION));
    const off = text(homeBlocks(paired, { linked: false }));
    assert.doesNotMatch(off, /as you|as yourself/);
    assert.equal(text(homeBlocks(paired)), off, 'no linking config reads the same as not linked');
  });

  it('renders the setup as it is, not as it would read best', () => {
    assert.match(text(homeBlocks(paired)), /start in `symma`/);
    assert.match(text(homeBlocks({ ...paired, state: 'asleep' })), /not reachable/);
    // A machine mid-turn is attached and working — "start the companion" would
    // send them to restart the thing that is answering them.
    // And "busy" is every session it can run being in use, not one question.
    assert.match(text(homeBlocks({ ...paired, state: 'busy' })), /running everything it can/);
    // A machine offering no approved project still runs, in a temp directory —
    // so the row says that rather than going missing.
    assert.match(
      text(homeBlocks({ ...paired, workspaceLabel: undefined })),
      /No approved projects/,
    );
  });
});
