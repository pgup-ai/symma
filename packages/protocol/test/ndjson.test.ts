import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readNdjsonBody } from '../src/ndjson.js';

function fakeReq(chunks: string[]): Parameters<typeof readNdjsonBody>[0] {
  return {
    setEncoding() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as Parameters<typeof readNdjsonBody>[0];
}

describe('readNdjsonBody', () => {
  it('splits lines across chunk boundaries and skips blanks', async () => {
    const lines: string[] = [];
    const { overflow } = await readNdjsonBody(fakeReq(['{"a":1}\n{"b', '":2}\n\n']), (l) =>
      lines.push(l),
    );
    assert.equal(overflow, false);
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  });

  it('caps a completed line that terminates inside its chunk (no bypass)', async () => {
    const lines: string[] = [];
    const oversized = `${'x'.repeat(49 * 1024 * 1024)}\n`;
    const { overflow } = await readNdjsonBody(fakeReq([oversized]), (l) => lines.push(l));
    assert.equal(overflow, true);
    assert.equal(lines.length, 0);
  });
});
