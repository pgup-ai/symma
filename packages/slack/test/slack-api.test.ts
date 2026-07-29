import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { slackApi } from '../src/slack-api.js';

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

/** Slack answers 200 with `ok: false`, so every case here is a 200. */
const answers = (body: unknown): void => {
  globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify(body)))) as typeof fetch;
};

describe('slack api', () => {
  it('reads a thread, and names files without fetching them', async () => {
    answers({
      ok: true,
      messages: [
        { ts: '100.0', user: 'U-nel', text: 'the deploy is failing' },
        { ts: '101.0', user: 'U-ola', text: 'logs', files: [{ name: 'trace.log', size: 12 }] },
        { user: 'U-no-ts', text: 'dropped: nothing can order or cite it' },
      ],
    });
    const thread = await slackApi('xoxb-test').threadReplies('C-incidents', '100.0');
    assert.equal(thread?.length, 2);
    assert.deepEqual(thread?.[1]?.files, [{ name: 'trace.log', size: 12 }]);
  });

  it('reports a channel it cannot see as unreadable, not as broken', async () => {
    // The difference is what the member is told: "invite me to that channel" or
    // nothing at all while an error goes to a log they never read (§4).
    for (const error of ['not_in_channel', 'channel_not_found', 'missing_scope']) {
      answers({ ok: false, error });
      assert.equal(
        await slackApi('xoxb-test').threadReplies('C-private', '100.0'),
        undefined,
        error,
      );
    }
  });

  it('lets a real failure through rather than reading it as an empty channel', async () => {
    // Classified on Slack's own code. An earlier version reparsed our formatted
    // message, so any error ending in one of those words was swallowed as
    // "invite me" — telling the member to fix something that was not wrong.
    answers({ ok: false, error: 'ratelimited' });
    await assert.rejects(
      slackApi('xoxb-test').threadReplies('C-incidents', '100.0'),
      /ratelimited/,
    );

    globalThis.fetch = (() =>
      Promise.reject(new Error('socket hang up: not_in_channel'))) as typeof fetch;
    await assert.rejects(
      slackApi('xoxb-test').threadReplies('C-incidents', '100.0'),
      /socket hang up/,
    );
  });

  it('posts to a user id, which Slack resolves to their DM', async () => {
    answers({ ok: true, channel: 'D-nel', ts: '200.0' });
    assert.deepEqual(await slackApi('xoxb-test').post('U-nel', 'hello'), {
      channel: 'D-nel',
      ts: '200.0',
    });
  });
});
