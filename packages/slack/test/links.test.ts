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
  host?: string;
  /** Channels this member could have opened themselves; every link is theirs
   * unless a test says which are. */
  mine?: string[];
  spent?: boolean;
  /** `mayRead` throws rather than answering — a missing scope, Slack down. */
  mayReadThrows?: boolean;
  /** The read never settles inside the deadline. */
  slowRead?: boolean;
  /** The caller's logger throws, as a caller's callback may. */
  logThrows?: boolean;
}) {
  const asked: string[] = [];
  const logged: string[] = [];
  return {
    asked,
    logged,
    deps: {
      budgetBytes: over.budgetBytes ?? 24_000,
      mayRead: (channel: string): Promise<'yes' | 'not yours' | 'unreadable'> =>
        over.mayReadThrows
          ? Promise.reject(new Error('missing_scope'))
          : Promise.resolve(!over.mine || over.mine.includes(channel) ? 'yes' : 'not yours'),
      spent: () => over.spent === true,
      reading: <T>(read: Promise<T>): Promise<T | 'too slow'> =>
        over.slowRead ? Promise.resolve('too slow' as const) : read,
      threadReplies: (channel: string, thread: string) => {
        asked.push(`${channel}/${thread}`);
        if (over.throws) return Promise.reject(new Error('thread too long to read'));
        return Promise.resolve(over.threads?.[`${channel}/${thread}`]);
      },
      log: (message: string) => {
        logged.push(message);
        if (over.logThrows) throw new Error('the logger is a caller callback');
      },
      ...(over.host ? { host: over.host } : {}),
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
    assert.deepEqual(got.missed, []);
  });

  it('names what it could not read and keeps going, a throw included', async () => {
    // Fail open per link: one dead link — another workspace, a channel the bot
    // is not in — must not cost the readable one beside it, or the turn.
    const dead = link('C0DEAD00000', '1786400300.000001');
    const alive = link('C0BMCR1FGU9', '1786400100.000001');
    const { deps } = resolver({ threads: { 'C0BMCR1FGU9/1786400100.000001': THREAD } });
    const got = await resolveLinks(`<${dead}> vs <${alive}>`, deps);
    assert.deepEqual(got.missed, [{ url: dead, why: 'unreadable' }]);
    assert.equal(got.sections.length, 1);

    const throwing = resolver({ throws: true });
    const thrown = await resolveLinks(`<${alive}>`, throwing.deps);
    assert.deepEqual(thrown.missed, [{ url: alive, why: 'unreadable' }]);
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
    assert.deepEqual(got.missed, [{ url: second, why: 'too long' }]);
  });

  it('stops at the cap and names the rest as over it', async () => {
    const channels = Array.from({ length: LINKS_PER_MESSAGE + 2 }, (_, i) => [
      `C0AAAAAAAA${String(i)}`,
      `${String(1786400100 + i)}.000001`,
    ]);
    const { deps, asked } = resolver({
      threads: Object.fromEntries(channels.map(([c, ts]) => [`${c!}/${ts!}`, THREAD])),
    });
    const got = await resolveLinks(channels.map(([c, ts]) => link(c!, ts!)).join(' '), deps);
    assert.equal(asked.length, LINKS_PER_MESSAGE, 'the cap is on fetches, not on links');
    assert.equal(got.sections.length, LINKS_PER_MESSAGE);
    assert.deepEqual(
      got.missed.map((miss) => miss.why),
      ['over the cap', 'over the cap'],
    );
  });

  it('does not fetch the thread the conversation itself lives in', async () => {
    // A self-link resolves to what the turn already carries — the replay reads
    // that thread every follow-up.
    const { deps, asked } = resolver({
      self: { channel: 'DNEL000000', root: '1786400200.000100' },
    });
    const got = await resolveLinks(`redo <${link('DNEL000000', '1786400200.000100')}>`, deps);
    assert.deepEqual(asked, []);
    assert.deepEqual(got, { sections: [], missed: [], spent: 0 });
  });

  it('will not fetch a channel the member could not open themselves', async () => {
    // The bot reads with its own token and is in whatever it was invited to, so
    // without this any member could paste a link to any channel it can see and
    // read it through the agent — including another member's DM with the bot.
    const theirs = link('C0PRIVATE00', '1786400100.000001');
    const { deps, asked } = resolver({
      mine: ['C0BMCR1FGU9'],
      threads: { 'C0PRIVATE00/1786400100.000001': THREAD },
    });
    const got = await resolveLinks(`what is in <${theirs}>?`, deps);
    assert.deepEqual(asked, [], 'refused before the fetch, not after');
    assert.deepEqual(got.missed, [{ url: theirs, why: 'not yours' }]);
  });

  it('survives a logger that throws on the paths that only log', async () => {
    // Both places this logs are recovery paths, and the logger is a caller's
    // callback: one that throws there turns a link the bot merely could not
    // read into a turn that never reached its acknowledgement.
    const url = link('C0BMCR1FGU9', '1786400100.000001');
    for (const over of [{ mayReadThrows: true }, { throws: true }]) {
      const { deps, logged } = resolver({ ...over, logThrows: true });
      const got = await resolveLinks(`<${url}>`, deps);
      assert.equal(got.missed.length, 1, JSON.stringify(over));
      // Not how many times, only that it still tried: guarding a logger by
      // deleting the call would pass everything above this line.
      assert.ok(logged.length > 0, 'it still tried to say why');
    }
  });

  it('refuses a link it cannot check, without blaming the member for it', async () => {
    // This gate is the whole reason the bot's reach is not handed to whoever
    // pastes a link, so not knowing has to mean no — a missing scope answering
    // by throwing must not read as permission. But it is no evidence about
    // *them* either: "you are not in that channel" would send a member auditing
    // their own membership over a scope the app is missing.
    const url = link('C0BMCR1FGU9', '1786400100.000001');
    const { deps, asked, logged } = resolver({ mayReadThrows: true });
    const got = await resolveLinks(`<${url}>`, deps);
    assert.deepEqual(asked, [], 'refused, whatever it is called');
    assert.deepEqual(got.missed, [{ url, why: 'unreadable' }]);
    assert.equal(logged.length, 1, 'and the reason it could not tell is not swallowed');
  });

  it('does not let a refusal spend the fetch allowance', async () => {
    // The cap is on requests to Slack, and a refusal makes none — so a link the
    // member cannot read must not push a readable one out of the message.
    const theirs = link('C0PRIVATE00', '1786400100.000001');
    const readable = Array.from({ length: LINKS_PER_MESSAGE }, (_, i) => [
      `C0AAAAAAAA${String(i)}`,
      `${String(1786400200 + i)}.000001`,
    ]);
    const { deps } = resolver({
      mine: readable.map(([c]) => c!),
      threads: Object.fromEntries(readable.map(([c, ts]) => [`${c!}/${ts!}`, THREAD])),
    });
    const got = await resolveLinks(
      [theirs, ...readable.map(([c, ts]) => link(c!, ts!))].join(' '),
      deps,
    );
    assert.equal(got.sections.length, LINKS_PER_MESSAGE);
    assert.deepEqual(got.missed, [{ url: theirs, why: 'not yours' }]);
  });

  it('stops waiting on any Slack call that will not answer', async () => {
    // Sampling between links bounds five quick calls and does nothing about one
    // never returning, which is the shape a stalled Slack takes. The permission
    // check is such a call too — it is first, so this fixture stalls there, and
    // a stall is reported as one rather than as a refusal.
    const url = link('C0BMCR1FGU9', '1786400100.000001');
    const { deps, asked } = resolver({
      slowRead: true,
      threads: { 'C0BMCR1FGU9/1786400100.000001': THREAD },
    });
    const got = await resolveLinks(`<${url}>`, deps);
    assert.deepEqual(got.missed, [{ url, why: 'too slow' }]);
    assert.deepEqual(got.sections, []);
    assert.deepEqual(asked, [], 'and the fetch behind it never ran');
  });

  it('ignores a permalink from another workspace', async () => {
    // A channel id means something only in the workspace that issued it, so
    // fetching a foreign one by (channel, ts) answers with whatever we have at
    // those ids — a different thread under a label naming the link.
    const { deps, asked } = resolver({ host: 'acme.slack.com' });
    const foreign = 'https://other.slack.com/archives/C0BMCR1FGU9/p1786400100000001';
    assert.deepEqual(slackLinks(foreign, 'acme.slack.com'), []);
    const got = await resolveLinks(foreign, deps);
    assert.deepEqual(asked, []);
    assert.deepEqual(got.missed, []);
  });

  it('stops fetching once the reads have taken too long', async () => {
    // These happen before the acknowledgement, so a stalled Slack call is a
    // member watching nothing happen — and it is not the same as a link the bot
    // cannot read.
    const url = link('C0BMCR1FGU9', '1786400100.000001');
    const { deps, asked } = resolver({ spent: true });
    const got = await resolveLinks(`<${url}>`, deps);
    assert.deepEqual(asked, []);
    assert.deepEqual(got.missed, [{ url, why: 'too slow' }]);
  });
});
