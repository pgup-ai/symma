import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { collectAttachments, skippedNote, type SlackFile } from '../src/attachments.js';

const downloads = (answer: (url: string) => { ok: boolean; bytes?: Buffer; status?: number }) => {
  const asked: string[] = [];
  return {
    asked,
    // Caps like the real one, so a test can see what happens to a size Slack
    // under-reported rather than only to one it declared honestly.
    fetchFile: (url: string, maxBytes: number) => {
      asked.push(url);
      const got = answer(url);
      return Promise.resolve(
        got.bytes && got.bytes.byteLength > maxBytes ? { ok: false, status: 413 } : got,
      );
    },
  };
};

const file = (over: Partial<SlackFile> = {}): SlackFile => ({
  name: 'notes.md',
  mimetype: 'text/markdown',
  filetype: 'markdown',
  size: 10,
  url_private_download: 'https://files.slack.com/notes.md',
  ...over,
});

describe('attachments', () => {
  it('sends text as text and images as base64', async () => {
    const { fetchFile } = downloads((url) =>
      url.endsWith('.png')
        ? { ok: true, bytes: Buffer.from([0x89, 0x50]) }
        : { ok: true, bytes: Buffer.from('a,b\n1,2\n') },
    );
    const got = await collectAttachments(
      [
        file({ name: 'rows.csv', mimetype: 'text/csv', filetype: 'csv' }),
        file({
          name: 'shot.png',
          mimetype: 'image/png',
          filetype: 'png',
          url_private_download: 'https://files.slack.com/shot.png',
        }),
      ],
      fetchFile,
    );
    assert.deepEqual(
      got.map((entry) => (entry.ok ? [entry.file.kind, entry.file.data] : entry.why)),
      [
        ['text', 'a,b\n1,2\n'],
        // base64, because that is what ACP's image block takes.
        ['image', 'iVA='],
      ],
    );
    assert.deepEqual(skippedNote(got), [], 'nothing to apologise for');
  });

  it('skips what it cannot pass along, and says which', async () => {
    const { fetchFile, asked } = downloads(() => ({ ok: true, bytes: Buffer.from('x') }));
    const got = await collectAttachments(
      [
        file({ name: 'book.xlsx', mimetype: 'application/vnd.ms-excel', filetype: 'xlsx' }),
        file({ name: 'huge.log', filetype: 'log', size: 900_000 }),
        file({ name: 'we`ird.md', url_private_download: undefined }),
      ],
      fetchFile,
    );
    assert.deepEqual(
      got.map((entry) => (entry.ok ? 'sent' : entry.name)),
      ['book.xlsx', 'huge.log', 'we`ird.md'],
    );
    // The ceiling exists to not pull the bytes, so an oversized file is never
    // downloaded — and a binary is refused before the network too.
    assert.deepEqual(asked, []);
    assert.deepEqual(skippedNote(got), [
      'Could not read book.xlsx (xlsx is not something I can pass along), ' +
        // Backtick stripped: the aside is mrkdwn, and a code span opened here
        // would swallow the rest of the sentence.
        'huge.log (too big to send (879kB)), we ird.md (Slack gave me no way to download it).',
    ]);
  });

  it('does not let refusals spend the budget the readable files need', async () => {
    // Five unreadable attachments ahead of the CSV a member actually wanted: the
    // cap counts what was sent, so the sixth still travels.
    const { fetchFile } = downloads(() => ({ ok: true, bytes: Buffer.from('a,b') }));
    const junk = Array.from({ length: 5 }, (_, i) =>
      file({
        name: `book${String(i)}.xlsx`,
        mimetype: 'application/vnd.ms-excel',
        filetype: 'xlsx',
      }),
    );
    const got = await collectAttachments(
      [...junk, file({ name: 'rows.csv', mimetype: 'text/csv', filetype: 'csv' })],
      fetchFile,
    );
    assert.deepEqual(
      got.filter((entry) => entry.ok).map((entry) => (entry.ok ? entry.file.name : '')),
      ['rows.csv'],
    );
  });

  it('turns a refused download into a line rather than a failed turn', async () => {
    const { fetchFile } = downloads(() => ({ ok: false, status: 403 }));
    const got = await collectAttachments([file()], fetchFile);
    assert.deepEqual(got, [{ ok: false, name: 'notes.md', why: 'I am not allowed to read it' }]);
  });

  it('stops at the total budget rather than burying the question', async () => {
    // Each file passes the per-file bar; together they must not.
    const big = Buffer.alloc(400 * 1024, 'x');
    const { fetchFile, asked } = downloads(() => ({ ok: true, bytes: big }));
    const got = await collectAttachments(
      [
        file({ size: big.byteLength }),
        file({ size: big.byteLength }),
        file({ size: big.byteLength }),
      ],
      fetchFile,
    );
    assert.deepEqual(
      got.map((entry) => (entry.ok ? 'sent' : entry.why)),
      ['sent', 'sent', 'the files together were more than one turn can carry'],
    );
    // Refused from its declaration, not its bytes: a ceiling judged afterwards
    // still pulled every file past it in full.
    assert.equal(asked.length, 2);
  });

  it('names an empty file rather than sending nothing under its name', async () => {
    // Distinct from a refused download: the fetch succeeded, so only the length
    // separates a file the agent can read from one it cannot.
    const { fetchFile } = downloads(() => ({ ok: true, bytes: Buffer.alloc(0) }));
    const got = await collectAttachments([file({ size: 0 })], fetchFile);
    assert.deepEqual(got, [{ ok: false, name: 'notes.md', why: 'it came back empty' }]);
  });

  it('cuts a size Slack under-reported off at the ceiling, and charges it', async () => {
    // 800kB sent, then two files that each say 100kB and serve 400kB. Nothing
    // weighs the bytes once they are here, so the fetch cap is the whole
    // ceiling — and the bytes it cuts off are spent, or the second file is
    // allowed the same transfer over again.
    const big = Buffer.alloc(400 * 1024, 'x');
    const { fetchFile, asked } = downloads(() => ({ ok: true, bytes: big }));
    const got = await collectAttachments(
      [
        file({ size: big.byteLength }),
        file({ size: big.byteLength }),
        file({ size: 100 * 1024 }),
        file({ size: 100 * 1024 }),
      ],
      fetchFile,
    );
    assert.deepEqual(
      got.map((entry) => (entry.ok ? 'sent' : entry.why)),
      [
        'sent',
        'sent',
        'it turned out too big to send',
        'the files together were more than one turn can carry',
      ],
    );
    assert.equal(asked.length, 3, 'the fourth was refused without a request');
  });
});
