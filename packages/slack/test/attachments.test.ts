import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { collectAttachments, skippedNote, type SlackFile } from '../src/attachments.js';

const downloads = (answer: (url: string) => { ok: boolean; bytes?: Buffer; status?: number }) => {
  const asked: string[] = [];
  return {
    asked,
    fetchFile: (url: string) => {
      asked.push(url);
      return Promise.resolve(answer(url));
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
        file({ name: 'nolink.md', url_private_download: undefined }),
      ],
      fetchFile,
    );
    assert.deepEqual(
      got.map((entry) => (entry.ok ? 'sent' : entry.name)),
      ['book.xlsx', 'huge.log', 'nolink.md'],
    );
    // The ceiling exists to not pull the bytes, so an oversized file is never
    // downloaded — and a binary is refused before the network too.
    assert.deepEqual(asked, []);
    assert.deepEqual(skippedNote(got), [
      'Could not read book.xlsx (xlsx is not something I can pass along), ' +
        'huge.log (too big to send (879kB)), nolink.md (Slack gave me no way to download it).',
    ]);
  });

  it('turns a refused download into a line rather than a failed turn', async () => {
    const { fetchFile } = downloads(() => ({ ok: false, status: 403 }));
    const got = await collectAttachments([file()], fetchFile);
    assert.deepEqual(got, [{ ok: false, name: 'notes.md', why: 'I am not allowed to read it' }]);
  });

  it('stops at the total budget rather than burying the question', async () => {
    // Each file passes the per-file bar; together they must not.
    const big = Buffer.alloc(400 * 1024, 'x');
    const { fetchFile } = downloads(() => ({ ok: true, bytes: big }));
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
  });
});
