import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ThreadMessage } from '../src/snapshot.js';
import { LINKS_PER_MESSAGE, resolveLinks, slackLinks } from '../src/links.js';

const link = (channel: string, ts: string, query = ''): string =>
  `https://acme.slack.com/archives/${channel}/p${ts.replace('.', '')}${query}`;

const THREAD: ThreadMessage[] = [
  { ts: '100.000001', author: 'Nel', text: 'the deploy is failing' },
  { ts: '101.000001', author: 'Ola', text: 'here is the trace' },
];

function resolver(over: {
  threads?: Record<string, ThreadMessage[] | undefined>;
  budgetBytes?: number;
  self?: { channel: string; root: string };
  throws?: boolean;
}) {
  const asked: string[] = [];
  const logged: string[] = [];
  return {
    asked,
    logged,
    deps: {
      budgetBytes: over.budgetBytes ?? 24_000,
      threadReplies: (channel: string, thread: string) => {
        asked.push(`${channel}/${thread}`);
        if (over.throws) return Promise.reject(new Error('thread too long to read'));
        return Promise.resolve(over.threads?.[`${channel}/${thread}`]);
      },
      log: (message: string) => {
        logged.push(message);
      },
      ...(over.self ? { self: over.self } : {}),
    },
  };
}

describe('slack links', () => {
  it('reads every form a member pastes: bare, bracketed, labelled, reply', () => {
    // Slack delivers URLs as `<url>` or `<url|label>`; a reply permalink carries
    // `thread_ts`, which names the root — the thread the member means, not just
    // the one message the link lands on.
    const root = link('C0BMCR1FGU9', '1786413790.840929');
    const text = [
      `continue from <${root}>`,
      `and <${link('D0AAAAAAAAA', '1786400200.000001')}|this DM>`,
      `plus ${link('C0BMCR1FGU9', '1786413999.111111', '?thread_ts=1786413790.840929&cid=C0BMCR1FGU9')}`,
    ].join(' ');
    assert.deepEqual(
      slackLinks(text).map((entry) => `${entry.channel}/${entry.root}`),
      // The reply link resolves to the same thread as the first and dedupes
      // into it — two mentions of one thread are one fetch.
      ['C0BMCR1FGU9/1786413790.840929', 'D0AAAAAAAAA/1786400200.000001'],
    );
  });

  it('ignores what is not a message permalink', () => {
    assert.deepEqual(
      slackLinks(
        [
          'https://example.com/archives/C123456/p1234567890123456',
          'https://acme.slack.com/archives/C0BMCR1FGU9/p123', // not a message ts
          'https://app.slack.com/client/T0123/C0BMCR1FGU9', // an address-bar copy
          'plain text',
        ].join(' '),
      ),
      [],
    );
  });

  it('hands the agent the thread, named by the link it came from', async () => {
    const url = link('C0BMCR1FGU9', '1786400100.000001');
    const { deps, asked } = resolver({
      threads: { 'C0BMCR1FGU9/1786400100.000001': THREAD },
    });
    const got = await resolveLinks(`what happened here? <${url}>`, deps);
    assert.deepEqual(asked, ['C0BMCR1FGU9/1786400100.000001']);
    assert.equal(got.sections.length, 1);
    // The URL is the one name the member, the agent and the section share.
    assert.match(got.sections[0]!, new RegExp(`^Behind ${url.replaceAll('.', '\\.')}`));
    assert.match(got.sections[0]!, /fetched just now/);
    assert.match(got.sections[0]!, /the deploy is failing/);
    assert.equal(got.spent, Buffer.byteLength(got.sections[0]!, 'utf8'));
    assert.deepEqual(got.unread, []);
  });

  it('names what it could not read and keeps going, a throw included', async () => {
    // Fail open per link: one dead link — another workspace, a channel the bot
    // is not in — must not cost the readable one beside it, or the turn.
    const dead = link('C0DEAD00000', '1786400300.000001');
    const alive = link('C0BMCR1FGU9', '1786400100.000001');
    const { deps } = resolver({ threads: { 'C0BMCR1FGU9/1786400100.000001': THREAD } });
    const got = await resolveLinks(`<${dead}> vs <${alive}>`, deps);
    assert.deepEqual(got.unread, [dead]);
    assert.equal(got.sections.length, 1);

    const throwing = resolver({ throws: true });
    const thrown = await resolveLinks(`<${alive}>`, throwing.deps);
    assert.deepEqual(thrown.unread, [alive]);
    assert.equal(throwing.logged.length, 1, 'a throw is said once, not swallowed');
  });

  it('tells a thread that did not fit apart from one it could not read', async () => {
    // Both end up outside the prompt, but "I cannot read it" about a thread the
    // budget squeezed out sends the member checking the bot's membership.
    const first = link('C0BMCR1FGU9', '1786400100.000001');
    const second = link('C0SECOND000', '1786400400.000001');
    const { deps } = resolver({
      threads: {
        'C0BMCR1FGU9/1786400100.000001': [
          { ts: '1786400100.000001', author: 'Nel', text: 'x'.repeat(600) },
        ],
        'C0SECOND000/1786400400.000001': THREAD,
      },
      budgetBytes: 700,
    });
    const got = await resolveLinks(`<${first}> then <${second}>`, deps);
    assert.equal(got.sections.length, 1);
    assert.deepEqual(got.unread, []);
    assert.deepEqual(got.crowded, [second]);
  });

  it('stops at the cap and says how many it left', async () => {
    const text = Array.from({ length: LINKS_PER_MESSAGE + 2 }, (_, i) =>
      link(`C0AAAAAAAA${String(i)}`, `${String(1786400100 + i)}.000001`),
    ).join(' ');
    const { deps, asked } = resolver({});
    const got = await resolveLinks(text, deps);
    assert.equal(asked.length, LINKS_PER_MESSAGE);
    assert.equal(got.skipped, 2);
  });

  it('does not fetch the thread the conversation itself lives in', async () => {
    // A self-link resolves to what the turn already carries — the replay reads
    // that thread every follow-up.
    const { deps, asked } = resolver({
      self: { channel: 'DNEL000000', root: '1786400200.000100' },
    });
    const got = await resolveLinks(`redo <${link('DNEL000000', '1786400200.000100')}>`, deps);
    assert.deepEqual(asked, []);
    assert.deepEqual(got, { sections: [], unread: [], crowded: [], skipped: 0, spent: 0 });
  });
});
