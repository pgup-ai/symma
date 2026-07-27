import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { VIEWER_HTML } from '../src/viewer.js';

const VIEWER_SRC = join(dirname(fileURLToPath(import.meta.url)), '../src/viewer.ts');

describe('viewer script', () => {
  it('parses as JavaScript', () => {
    // Catches whatever makes the page unparseable, whatever the cause. A single
    // SyntaxError takes the entire inline script with it: no run list, no
    // stream, just the "connecting" label the static HTML ships with.
    const open = VIEWER_HTML.lastIndexOf('<script>');
    const close = VIEWER_HTML.indexOf('</script>', open);
    assert.ok(open !== -1 && close !== -1, 'viewer ships an inline script');

    const script = VIEWER_HTML.slice(open + '<script>'.length, close);
    assert.doesNotThrow(() => new Function(script), SyntaxError);

    // Parsing is not enough for the delimiter that broke: one backslash is a
    // SyntaxError, two split on a newline, four split on a literal backslash-n
    // and quietly return the whole journal as a single line. Run it rather than
    // match its text — a substring assertion carries the same escaping hazard
    // it would be guarding.
    const delimiter = /text\.split\((.+?)\)/.exec(script)?.[1];
    assert.ok(delimiter, 'the journal split is still there to check');
    const split = new Function('text', `return text.split(${delimiter})`) as (
      text: string,
    ) => string[];
    assert.equal(split('a\nb').length, 2, 'journal lines split on a newline');
  });

  it('doubles every backslash meant for the browser', () => {
    // The page is a template literal, so TypeScript consumes one level of
    // escaping before the browser ever sees the code. A single backslash is
    // therefore a bug in two different ways, and parsing alone only catches
    // the first: `\n` collapses to a real newline and breaks the string it is
    // in, while `\s` silently becomes `s` and quietly changes what a regex
    // matches. `\u` is the exception — that one is meant to emit a character.
    const src = readFileSync(VIEWER_SRC, 'utf8');
    const body = src.slice(src.indexOf('`', src.indexOf('VIEWER_HTML')) + 1, src.lastIndexOf('`'));

    const singles: string[] = [];
    for (const match of body.matchAll(/(\\+)([^\\])/g)) {
      const [, slashes, next] = match;
      if (slashes!.length % 2 === 1 && next !== 'u') {
        singles.push(body.slice(Math.max(0, match.index - 30), match.index + 10).trim());
      }
    }
    assert.deepEqual(singles, [], 'single-backslash escapes lose a level before the browser');
  });
});
