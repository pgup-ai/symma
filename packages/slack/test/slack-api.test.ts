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
      'the notice goes above, and the answer keeps a block of its own',
    );
    assert.match(blocks[0]!.elements![0]!.text, /shortened/);
    assert.doesNotMatch(blocks[0]!.elements![0]!.text, /…$/, 'one that fits is not marked cut');
    assert.equal(blocks[1]!.text!.text, 'the answer');
    // The fallback is what Slack notifies and reads out, so it stays the answer
    // alone — a notice is not what the member is being told about.
    assert.equal(sent.get('text'), 'the answer');
  });

  it('splits an answer Slack would reject rather than losing the post', async () => {
    // A section caps at 3,000 characters and the message at 50 blocks. Slack
    // rejects the whole post over either, and `handleDm` reports a rejected
    // post as a failed run — so the member loses an answer that was produced.
    const answer = Array.from(
      { length: 400 },
      (_, i) => `line ${String(i)} ${'x'.repeat(40)}`,
    ).join('\n');
    const { fetchImpl, seen } = answering({ ok: true, channel: 'D-nel', ts: '1.0' });
    // Over the limit itself, since an agent's notice is not bounded either.
    await slackApi('xoxb-test', { fetch: fetchImpl }).post('D-nel', answer, '200.0', undefined, [
      `Warning: ${'y'.repeat(4000)}`,
    ]);
    const blocks = JSON.parse(new URLSearchParams(String(seen[0])).get('blocks') ?? '[]') as {
      type: string;
      text?: { text: string };
      elements?: { text: string }[];
    }[];
    assert.ok(blocks.length <= 50, 'inside the message cap');
    for (const block of blocks) {
      assert.ok((block.text?.text.length ?? 0) <= 3000, 'every section inside its own');
      for (const element of block.elements ?? []) {
        assert.ok(element.text.length <= 3000, 'and so is a notice that arrived too long');
      }
    }
    assert.equal(blocks[0]!.type, 'context', 'the notice still leads');
    // Nothing is silently dropped on the way: the answer is split, not cut.
    const rebuilt = blocks
      .filter((b) => b.type === 'section')
      .map((b) => b.text!.text)
      .join('');
    assert.equal(rebuilt, answer);
  });

  it('gives the answer its blocks before the asides get theirs', async () => {
    // More notices than the message has room for. Slack rejects a post over 50
    // blocks outright, so an agent that talked about itself a lot would take
    // down the answer it talked alongside.
    const { fetchImpl, seen } = answering({ ok: true, channel: 'D-nel', ts: '1.0' });
    await slackApi('xoxb-test', { fetch: fetchImpl }).post(
      'D-nel',
      'the answer',
      '200.0',
      { conversation: 'conv-1', destination: '<#C-incidents>' },
      Array.from({ length: 80 }, (_, i) => `notice ${String(i)}`),
    );
    const blocks = JSON.parse(new URLSearchParams(String(seen[0])).get('blocks') ?? '[]') as {
      type: string;
      text?: { text: string };
    }[];
    assert.ok(blocks.length <= 50, `inside the message cap, got ${String(blocks.length)}`);
    assert.deepEqual(
      blocks.filter((b) => b.type === 'section').map((b) => b.text!.text),
      ['the answer'],
      'and the answer is still there rather than squeezed out',
    );
    assert.equal(blocks.at(-1)!.type, 'actions', 'with the share button after it');

    // A cut landing between the halves of an emoji would leave a lone surrogate
    // that renders as a replacement glyph.
    const emoji = answering({ ok: true, channel: 'D-nel', ts: '1.0' });
    await slackApi('xoxb-test', { fetch: emoji.fetchImpl }).post(
      'D-nel',
      // The odd prefix is what puts the 3,000th unit inside a pair rather than
      // between two: without it the boundary lands evenly and proves nothing.
      `x${'🙂'.repeat(4000)}`,
      '200.0',
      undefined,
      [`x${'🙂'.repeat(4000)}`],
    );
    for (const block of JSON.parse(
      new URLSearchParams(String(emoji.seen[0])).get('blocks') ?? '[]',
    ) as { text?: { text: string }; elements?: { text: string }[] }[]) {
      for (const part of [block.text?.text, ...(block.elements ?? []).map((e) => e.text)]) {
        assert.ok(!/[\uD800-\uDBFF]$/.test(part ?? ''), 'no half a character at the boundary');
      }
    }

    // And the other way round: an answer long enough to want every block gets
    // them, and the asides are what go.
    const long = answering({ ok: true, channel: 'D-nel', ts: '1.0' });
    await slackApi('xoxb-test', { fetch: long.fetchImpl }).post(
      'D-nel',
      'z'.repeat(3000 * 60),
      '200.0',
      undefined,
      ['notice 0', 'notice 1'],
    );
    const wide = JSON.parse(new URLSearchParams(String(long.seen[0])).get('blocks') ?? '[]') as {
      type: string;
    }[];
    assert.ok(wide.length <= 50, 'inside the cap');
    // One block is held back for them, so what was said is never simply gone.
    const aside = wide.find((b) => b.type === 'context') as
      { elements: { text: string }[] } | undefined;
    assert.match(aside!.elements[0]!.text, /_and 1 more_$/, 'and says what it could not show');
    // The fallback is what Slack notifies and reads out, and it has a cap of
    // its own — bounded here rather than left to whatever Slack does past it.
    const fallback = new URLSearchParams(String(long.seen[0])).get('text') ?? '';
    assert.ok(fallback.length <= 40_000, `inside the text cap, got ${String(fallback.length)}`);
    assert.match(fallback, /…$/, 'and says it was cut');
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

  it('does not pay for a tidy break with the answer’s tail', async () => {
    // Every line break shortens the section it ends, so preferring them costs
    // blocks — and just past the budget that cost comes out of the answer.
    const line = `${'w'.repeat(2599)}\n`;
    // 54 lines: 47 sections when cut at the limit, 54 when cut at the breaks —
    // so the tidy version is the one that does not fit in 50.
    const answer = line.repeat(54);
    const { fetchImpl, seen } = answering({ ok: true, channel: 'D-nel', ts: '1.0' });
    await slackApi('xoxb-test', { fetch: fetchImpl }).post('D-nel', answer, '200.0');
    const blocks = JSON.parse(new URLSearchParams(String(seen[0])).get('blocks') ?? '[]') as {
      text?: { text: string };
    }[];
    assert.equal(blocks.map((b) => b.text!.text).join(''), answer, 'all of it, tidy or not');
  });

  it('does not leave a code fence hanging across a split', async () => {
    // A coding agent's long answer is usually mostly code. A cut inside a fence
    // leaves the section holding it open — everything after renders as code —
    // and the next section starting on a stray close.
    // One long line inside it, so the split lands on the hard cut rather than
    // on a line break that happens to leave room for the close.
    const answer = `before\n\`\`\`ts\n${'x'.repeat(7000)}\n\`\`\`\nafter`;
    const { fetchImpl, seen } = answering({ ok: true, channel: 'D-nel', ts: '1.0' });
    await slackApi('xoxb-test', { fetch: fetchImpl }).post('D-nel', answer, '200.0');
    const parts = (
      JSON.parse(new URLSearchParams(String(seen[0])).get('blocks') ?? '[]') as {
        text: { text: string };
      }[]
    ).map((b) => b.text.text);
    assert.ok(parts.length > 1, 'the fixture actually splits');
    for (const [index, part] of parts.entries()) {
      assert.equal(
        (part.match(/```/g) ?? []).length % 2,
        0,
        `section ${String(index)} is balanced`,
      );
      // The close it gains has to fit in the same 3,000 as everything else.
      assert.ok(part.length <= 3000, `section ${String(index)} is ${String(part.length)} long`);
    }
    // Reopened in the language it was opened with, or the code stops being ts
    // halfway down.
    assert.ok(parts.slice(1).every((part) => part.startsWith('```ts')));
  });

  it('still splits a long answer with nothing beside it', async () => {
    // The ordinary DM case: no notice, and no thread to share back to. Without
    // blocks the whole answer rides the fallback, which has a cap of its own.
    const { fetchImpl, seen } = answering({ ok: true, channel: 'D-nel', ts: '1.0' });
    await slackApi('xoxb-test', { fetch: fetchImpl }).post('D-nel', 'z'.repeat(8000), '200.0');
    const blocks = JSON.parse(new URLSearchParams(String(seen[0])).get('blocks') ?? '[]') as {
      text?: { text: string };
    }[];
    assert.equal(blocks.map((b) => b.text!.text).join(''), 'z'.repeat(8000));
  });
});
