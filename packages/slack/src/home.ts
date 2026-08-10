/**
 * The two surfaces with no thread under them: `/model`, and the app's home tab.
 *
 * Every other picker rides an answer, which is fine until the choice is one you
 * want to make *before* asking — and a model is exactly that. Both render from
 * the roster the gateway kept from the last turn, because an agent only ever
 * says what it offers while it is running.
 *
 * The site's own marks, so the same four things are the same four things in
 * both places: ⌁ machine, ⌘ project, ◫ access level, ◎ model.
 */
import type { TurnTarget } from '@symma/protocol';

import { modelSelect, plainly } from './slack-api.js';

const context = (text: string): Record<string, unknown> => ({
  type: 'context',
  elements: [{ type: 'mrkdwn', text }],
});

const section = (text: string): Record<string, unknown> => ({
  type: 'section',
  text: { type: 'mrkdwn', text },
});

const UNPAIRED = 'No machine yet. Run `/connect` and I will send you a code.';

/** The picker, or the reason there is none. Shared so `/model` and the home tab
 * cannot drift into disagreeing about what is on offer. */
const modelBlocks = (target: TurnTarget): Record<string, unknown>[] => {
  const elements = target.agent
    ? modelSelect(
        undefined,
        {
          availableModels: target.models ?? [],
          ...(target.model ? { currentModelId: target.model } : {}),
        },
        target.agent,
      )
    : [];
  if (elements.length) return [{ type: 'actions', elements }];
  // A roster is learned by running, and the gateway serves none for a machine
  // that is not up — so an unreachable one is why there is nothing here, and
  // saying "ask me something first" would send them to a bot that cannot answer.
  return [
    context(
      target.state === 'ready'
        ? 'Ask me something first and your agent will tell me what it offers.'
        : 'Your model list arrives with your machine.',
    ),
  ];
};

/**
 * `/model`. Ephemeral by construction — the caller answers Slack's own response
 * URL — so it is a choice made and gone, rather than a control left in a thread
 * for somebody to press a week later.
 */
export function modelPrompt(target: TurnTarget | undefined): {
  text: string;
  blocks: Record<string, unknown>[];
} {
  if (!target) return { text: UNPAIRED, blocks: [section(UNPAIRED)] };
  const lead = '◎ Your default model';
  return {
    text: lead,
    blocks: [
      section(`*${lead}*`),
      ...modelBlocks(target),
      context('Conversations where you picked a model keep it.'),
    ],
  };
}

/**
 * The home tab: what this member's setup is, and the one choice that belongs
 * outside a conversation.
 *
 * Block Kit has no colour of its own — the home tab is Slack's surface, not
 * ours — so the brand carries as the site's marks and the site's voice.
 */
export function homeBlocks(target: TurnTarget | undefined): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Your agent. Your laptop. Now reachable from Slack.' },
    },
    { type: 'divider' },
  ];
  if (!target) return [...blocks, section(UNPAIRED)];

  // Escaped like every other name this bot renders: a device name, a project
  // label and an agent name are all whatever the member's own machine calls
  // them, and a backtick in one would swallow the rest of the line.
  const machine = plainly(target.device) || 'Your machine';
  blocks.push(
    section(
      target.state === 'ready'
        ? `⌁ *${machine}* is ready${target.agent ? `, running \`${plainly(target.agent)}\`` : ''}`
        : `⌁ *${machine}* is not reachable — start the companion and it will come back`,
    ),
    // A machine offering no approved project is not a broken one: conversations
    // run in an empty temp directory, and the DM says so on the turn itself.
    context(
      target.workspaceLabel
        ? `⌘ New conversations start in \`${plainly(target.workspaceLabel)}\``
        : '⌘ No approved projects — conversations run in an empty temp directory',
    ),
    context('◫ Access level is chosen in each conversation'),
    { type: 'divider' },
    section('*◎ Your default model*'),
    ...modelBlocks(target),
    context('Conversations where you picked a model keep it.'),
  );
  return blocks;
}
