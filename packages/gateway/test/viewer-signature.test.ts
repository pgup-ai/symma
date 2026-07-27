import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { VIEWER_HTML } from '../src/viewer.ts';
import { generateSigningKeys, signEnvelope } from '@symma/protocol';

describe('viewer signature check', () => {
  it('ships the verification path with its regex escaping intact', () => {
    // Escaping is guarded generally in viewer-script.test.ts; this pins that the
    // PEM header/whitespace strip is still in the key path at all.
    assert.match(VIEWER_HTML, /replace\(\/\\s\+\/g, ''\)/);
    assert.match(VIEWER_HTML, /name: 'Ed25519'/);
    // Checked before the seq dedup, or a tampered frame carrying a replayed
    // seq would be dropped unchecked; the dedup key is a digest of the WHOLE
    // envelope, so copying a seq or sig onto rewritten bytes never inherits a
    // verdict, and full frames are not retained for the session's lifetime.
    // The session-identity guard comes first: a straggler from a closed stream
    // must neither tally into this session's badge nor poison its seq dedup.
    assert.match(
      VIEWER_HTML,
      /function ingest\(e\) \{[\s\S]{0,220}?if \(active !== e\.runId \+ '\/' \+ e\.sessionId\) return;\s*checkSig\(e\);/,
    );
    // Only the newest key load writes, so a slow older response cannot put
    // back keys a later load replaced.
    assert.match(VIEWER_HTML, /if \(mySeq === sigLoadSeq\) sigKeys\[entry\.endpoint\] = k;/);
    assert.match(VIEWER_HTML, /sha256hex\(JSON\.stringify\(e\)\)/);
    // Keyless frames stay unseen (judgeable later) and mark the session starved
    // so a successful key load replays it.
    assert.match(VIEWER_HTML, /if \(!sigLoaded\) \{ sigStarved = true; return; \}/);
    // An unsigned run with no keys hashes nothing: the digest exists only to
    // dedup a verdict, and there is no verdict to reach.
    assert.match(
      VIEWER_HTML,
      /typeof e\.sig !== 'string' && !sigSessionSigned && !sigKeys\[e\.endpoint\]/,
    );
    // Signed at all means signed throughout: unsigned inbound frames wait in a
    // pending count that lands once any signature appears in the session.
    assert.match(VIEWER_HTML, /sigBad \+= sigPendingUnsigned; sigPendingUnsigned = 0;/);
    // Gap tracking runs at arrival, not at verdict — verdicts resolve out of
    // order, and a deleted middle frame must still surface in the badge.
    assert.match(
      VIEWER_HTML,
      /if \(e\.seq !== \(sigLastSeq\[e\.endpoint\] \|\| 0\) \+ 1\) \{ sigGaps\+\+;/,
    );
  });

  it('verifies a companion signature through the browser primitives', async () => {
    // Same steps the page takes — SPKI import, drop `sig`, re-serialize —
    // against a real signature, since none of that is exercised in Node.
    const { privateKey, publicKey } = generateSigningKeys();
    const signed = JSON.parse(
      JSON.stringify(
        signEnvelope(
          { v: 1, runId: 'r', sessionId: 's', seq: 1, ts: 2, endpoint: 'e2e', frame: { x: 1 } },
          privateKey,
        ),
      ),
    ) as Record<string, unknown>;

    const der = Uint8Array.from(
      atob(publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')),
      (c) => c.charCodeAt(0),
    );
    const key = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
    const rest: Record<string, unknown> = {};
    for (const k in signed) if (k !== 'sig') rest[k] = signed[k];
    const signature = Uint8Array.from(atob(String(signed.sig)), (c) => c.charCodeAt(0));
    const bytes = (value: object) => new TextEncoder().encode(JSON.stringify(value));

    assert.equal(await crypto.subtle.verify('Ed25519', key, signature, bytes(rest)), true);
    assert.equal(
      await crypto.subtle.verify('Ed25519', key, signature, bytes({ ...rest, seq: 99 })),
      false,
    );
  });
});
