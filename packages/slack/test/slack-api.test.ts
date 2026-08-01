import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { slackApi } from '../src/slack-api.js';

/** Slack answers 200 with `ok: false`, so every case here is a 200. */
const answering = (...bodies: unknown[]) => {
  const seen: unknown[] = [];
  const called: string[] = [];
  const fetchImpl = ((url: string, init: { body?: unknown }) => {
    called.push(String(url).split('/').pop() ?? '');
    seen.push(init.body);
    return Promise.resolve(
      new Response(JSON.stringify(bodies[Math.min(seen.length - 1, bodies.length - 1)])),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, seen, called };
};

describe('slack api', () => {
  it('reads a thread, and names files without fetching them', async () => {
    const { fetchImpl } = answering({
      ok: true,
      messages: [
        { ts: '100.0', user: 'U-nel', text: 'the deploy is failing' },
        { ts: '101.0', user: 'U-ola', text: 'logs', files: [{ name: 'trace.log', size: 12 }] },
        { user: 'U-no-ts', text: 'dropped: nothing can order or cite it' },
      ],
    });
    const thread = await slackApi('xoxb-test', { fetch: fetchImpl }).threadReplies(
      'C-incidents',
      '100.0',
    );
    assert.equal(thread?.length, 2);
    assert.deepEqual(thread?.[1]?.files, [{ name: 'trace.log', size: 12 }]);
  });

  it('reads every page, because the newest replies are on the last one', async () => {
    // `conversations.replies` returns oldest first. Stopping at page one and
    // advancing the cursor to its newest would put every later page permanently
    // behind the cursor, with nothing saying so.
    const { fetchImpl, seen } = answering(
      {
        ok: true,
        messages: [{ ts: '100.0', user: 'U-nel', text: 'oldest' }],
        response_metadata: { next_cursor: 'page2' },
      },
      { ok: true, messages: [{ ts: '101.0', user: 'U-ola', text: 'newest' }] },
    );
    const thread = await slackApi('xoxb-test', { fetch: fetchImpl }).threadReplies(
      'C-incidents',
      '100.0',
    );
    assert.deepEqual(
      thread?.map((m) => m.text),
      ['oldest', 'newest'],
    );
    assert.match(String(seen[1]), /page2/, 'the cursor is carried');
  });

  it('gives up on a thread it cannot read to the end', async () => {
    // Every page claims another follows, so nothing but the cap ends this. The
    // answer is a refusal rather than the pages it did get: they are the oldest
    // ones, and a snapshot missing its newest end is worse than no snapshot.
    const { fetchImpl, seen } = answering({
      ok: true,
      messages: [{ ts: '100.0', user: 'U-nel', text: 'more' }],
      response_metadata: { next_cursor: 'again' },
    });

    await assert.rejects(
      () => slackApi('xoxb-test', { fetch: fetchImpl }).threadReplies('C-incidents', '100.0'),
      /too long/,
    );
    assert.ok(seen.length <= 21, `bounded, and stopped at ${String(seen.length)} pages`);
  });

  it('reports a channel it cannot see as unreadable, not as broken', async () => {
    // The difference is what the member is told: "invite me to that channel", or
    // nothing at all while an error goes to a log they never read (§4).
    for (const error of ['not_in_channel', 'channel_not_found', 'missing_scope']) {
      const { fetchImpl } = answering({ ok: false, error });
      assert.equal(
        await slackApi('xoxb-test', { fetch: fetchImpl }).threadReplies('C-private', '100.0'),
        undefined,
        error,
      );
    }
  });

  it('lets a real failure through rather than reading it as an empty channel', async () => {
    // Classified on Slack's own code, off the SDK's typed error. An earlier
    // version reparsed our formatted message, so anything ending in one of those
    // words was swallowed as "invite me".
    const { fetchImpl } = answering({ ok: false, error: 'invalid_auth' });
    await assert.rejects(
      slackApi('xoxb-test', { fetch: fetchImpl }).threadReplies('C-incidents', '100.0'),
      /invalid_auth/,
    );
  });

  it('resolves a member to their DM channel before posting', async () => {
    // Slack's docs disagree about whether a user id can stand in as a channel —
    // one page says it opens the DM, another that the message lands in the
    // Slackbot conversation. Asking is correct under either.
    const opened = answering({ ok: true, channel: { id: 'D-nel' } });
    assert.equal(await slackApi('xoxb-test', { fetch: opened.fetchImpl }).openDm('U-nel'), 'D-nel');

    const posted = answering({ ok: true, channel: 'D-nel', ts: '200.0' });
    assert.deepEqual(await slackApi('xoxb-test', { fetch: posted.fetchImpl }).post('D-nel', 'hi'), {
      channel: 'D-nel',
      ts: '200.0',
    });
  });

  it('has nothing to remove when the run is only starting', async () => {
    const { fetchImpl, called } = answering({ ok: true });
    await slackApi('xoxb-test', { fetch: fetchImpl }).mark('D-nel', '250.0', 'working');
    assert.deepEqual(called, ['reactions.add']);
  });

  it('never lets a lost mark cost the member the answer it was about', async () => {
    // The remove has nothing to take off when the working mark's own add failed,
    // so swallowing the pair together would drop the mark that actually says the
    // run is over. Both failing is still not the member's problem.
    const { fetchImpl, called } = answering(
      { ok: false, error: 'no_reaction' },
      { ok: false, error: 'message_not_found' },
    );
    await slackApi('xoxb-test', { fetch: fetchImpl }).mark('D-nel', '250.0', 'done');
    assert.deepEqual(called, ['reactions.remove', 'reactions.add']);
  });

  it('sets a notice apart from the answer instead of running them together', async () => {
    const { fetchImpl, seen } = answering({ ok: true, channel: 'D-nel', ts: '1.0' });
    await slackApi('xoxb-test', { fetch: fetchImpl }).post(
      'D-nel',
      'the answer',
      '200.0',
      undefined,
      ['Warning: skill descriptions were shortened.'],
    );
    // The SDK form-encodes this call and JSON-encodes only the complex fields.
    const sent = new URLSearchParams(String(seen[0]));
    const blocks = JSON.parse(sent.get('blocks') ?? '[]') as {
      type: string;
      elements?: { text: string }[];
      text?: { text: string };
    }[];
    assert.deepEqual(
      blocks.map((b) => b.type),
      ['context', 'section'],
      'the notice is above, small and grey, and the answer keeps its own block',
    );
    assert.match(blocks[0]!.elements![0]!.text, /shortened/);
    assert.equal(blocks[1]!.text!.text, 'the answer');
    // The fallback is what Slack notifies and reads out, so it stays the answer
    // alone — a notice is not what the member is being told about.
    assert.equal(sent.get('text'), 'the answer');
  });

  it('stays a plain message when there is nothing to set apart', async () => {
    const { fetchImpl, seen } = answering({ ok: true, channel: 'D-nel', ts: '1.0' });
    await slackApi('xoxb-test', { fetch: fetchImpl }).post(
      'D-nel',
      'the answer',
      '200.0',
      undefined,
      [],
    );
    assert.equal(new URLSearchParams(String(seen[0])).get('blocks'), null);
  });
});
