import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  generateSigningKeys,
  signEnvelope,
  verifyEnvelope,
  verifyJournalLines,
} from '../src/envelope-signature.ts';

const envelope = {
  v: 1,
  runId: 'run-1',
  sessionId: 'sess-1',
  seq: 3,
  ts: 1_700_000_000_000,
  agent: 'kilo',
  label: 'review',
  dir: 'in',
  endpoint: 'e2e',
  frame: {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { text: 'hello' },
  },
};

describe('envelope signatures', () => {
  it('verifies a signed envelope only under the key that signed it', () => {
    const { privateKey, publicKey } = generateSigningKeys();
    const other = generateSigningKeys();

    const signed = signEnvelope(envelope, privateKey);
    assert.equal(verifyEnvelope(signed, publicKey), true);
    assert.equal(verifyEnvelope(signed, other.publicKey), false);
  });

  it('survives the JSON round trip the relay puts it through', () => {
    const { privateKey, publicKey } = generateSigningKeys();
    const signed = signEnvelope(envelope, privateKey);

    // What the gateway journals and a viewer reads back is the serialized line,
    // so verification has to hold on the reparsed object, not just this one.
    const relayed = JSON.parse(JSON.stringify(signed)) as Record<string, unknown>;
    assert.equal(verifyEnvelope(relayed, publicKey), true);
  });

  it('rejects tampering with any covered field, and rejects unsigned lines', () => {
    const { privateKey, publicKey } = generateSigningKeys();
    const signed = signEnvelope(envelope, privateKey);

    assert.equal(verifyEnvelope({ ...signed, seq: 4 }, publicKey), false);
    assert.equal(
      verifyEnvelope({ ...signed, frame: { jsonrpc: '2.0', method: 'evil' } }, publicKey),
      false,
    );
    // Unsigned and forged must be indistinguishable to a caller: both false.
    assert.equal(verifyEnvelope(envelope, publicKey), false);
    assert.equal(verifyEnvelope({ ...signed, sig: 'not-base64!' }, publicKey), false);
  });
});

describe('verifyJournalLines', () => {
  const sign = (privateKey: string, seq: number, endpoint = 'e2e') =>
    JSON.stringify(signEnvelope({ ...envelope, seq, endpoint }, privateKey));

  it('skips only unsigned client frames, so no field can turn tampering into a skip', () => {
    const { privateKey, publicKey } = generateSigningKeys();
    const clientFrame = JSON.stringify({ v: 1, seq: 1, dir: 'out', frame: {} });

    assert.deepEqual(verifyJournalLines([sign(privateKey, 1), clientFrame], [publicKey]), {
      checked: 1,
      verified: 1,
      skipped: 1,
      breaks: 0,
      misplaced: 0,
    });

    // Tampered, unsigned-inbound and unparseable all count as checked-not-verified.
    const tampered = JSON.stringify({
      ...JSON.parse(sign(privateKey, 2)),
      ts: 999,
    });
    assert.deepEqual(
      verifyJournalLines(
        [sign(privateKey, 1), tampered, JSON.stringify({ ...envelope, seq: 2 }), '{oops'],
        [publicKey],
      ),
      { checked: 4, verified: 1, skipped: 0, breaks: 0, misplaced: 0 },
    );

    // A signed frame stays checked however its unverified fields are rewritten:
    // flipping dir to 'out' or deleting endpoint must not skip it.
    const flipped = JSON.stringify({
      ...JSON.parse(sign(privateKey, 1)),
      dir: 'out',
    });
    const { endpoint: _gone, ...stripped } = JSON.parse(sign(privateKey, 2)) as Record<
      string,
      unknown
    >;
    assert.deepEqual(verifyJournalLines([flipped, JSON.stringify(stripped)], [publicKey]), {
      checked: 2,
      verified: 0,
      skipped: 0,
      breaks: 0,
      misplaced: 0,
    });
  });

  it('audits a multi-companion run in one pass, with per-endpoint sequence runs', () => {
    const a = generateSigningKeys();
    const b = generateSigningKeys();
    const journal = [
      sign(a.privateKey, 1, 'A'),
      sign(b.privateKey, 1, 'B'),
      sign(a.privateKey, 2, 'A'),
      sign(b.privateKey, 2, 'B'),
    ];

    // Both keys: everything verifies, and each endpoint's run climbs on its own.
    assert.deepEqual(verifyJournalLines(journal, [a.publicKey, b.publicKey]), {
      checked: 4,
      verified: 4,
      skipped: 0,
      breaks: 0,
      misplaced: 0,
    });
    // One key: the other companion's frames fail rather than being set aside —
    // there is no skip an endpoint rewrite could route a tampered frame into.
    assert.deepEqual(verifyJournalLines(journal, [a.publicKey]), {
      checked: 4,
      verified: 2,
      skipped: 0,
      breaks: 0,
      misplaced: 0,
    });
  });

  it('flags genuine frames transplanted from another run or session', () => {
    const { privateKey, publicKey } = generateSigningKeys();
    const here = { runId: 'run-1', sessionId: 'sess-1' };
    const foreign = JSON.stringify(
      signEnvelope({ ...envelope, sessionId: 'sess-9', seq: 1, endpoint: 'e2e' }, privateKey),
    );

    assert.deepEqual(verifyJournalLines([sign(privateKey, 1)], [publicKey], here), {
      checked: 1,
      verified: 1,
      skipped: 0,
      breaks: 0,
      misplaced: 0,
    });
    // A whole file swapped for another session's genuine journal: every
    // signature and its sequence are valid, only the signed ids give it away.
    // Foreign frames also stay out of the local sequence runs.
    assert.deepEqual(verifyJournalLines([sign(privateKey, 1), foreign], [publicKey], here), {
      checked: 2,
      verified: 1,
      skipped: 0,
      breaks: 0,
      misplaced: 1,
    });
  });

  it('breaks when a signed sequence gaps, repeats, or reorders', () => {
    const { privateKey, publicKey } = generateSigningKeys();
    const run = (seqs: number[]) =>
      verifyJournalLines(
        seqs.map((n) => sign(privateKey, n)),
        [publicKey],
      ).breaks;

    assert.equal(run([1, 2, 3]), 0);
    // A deleted middle frame leaves a gap the survivors' signatures pin in place —
    // including one whose signature was stripped to masquerade as a client frame.
    assert.equal(run([1, 3]), 1);
    const strippedTwo: Record<string, unknown> = JSON.parse(sign(privateKey, 2));
    delete strippedTwo.sig;
    strippedTwo.dir = 'out';
    const hidden = verifyJournalLines(
      [sign(privateKey, 1), JSON.stringify(strippedTwo), sign(privateKey, 3)],
      [publicKey],
    );
    assert.equal(hidden.skipped, 1);
    assert.equal(hidden.breaks, 1);
    assert.equal(run([2, 3]), 1); // head deletion
    // A name colliding with Object.prototype members must act like any other.
    const proto = verifyJournalLines(
      [sign(privateKey, 1, '__proto__'), sign(privateKey, 2, '__proto__')],
      [publicKey],
    );
    assert.equal(proto.breaks, 0);
    assert.equal(run([1, 1, 2]), 1); // duplicate breaks once; the run then resumes
    assert.equal(run([2, 1]), 2); // reorder breaks both steps
  });
});
