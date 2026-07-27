import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

/**
 * Ed25519 signing for relayed envelopes (M2d). The companion signs what it
 * emits, so the journal is tamper-evident against the relay itself: the gateway
 * stores and fans out frames it cannot forge, which is what keeps the pipe dumb
 * rather than trusted.
 */

/** Signed line as it travels: the envelope's own fields plus `sig`, always last. */
const SIGNATURE_FIELD = 'sig';

/**
 * Bytes covered by a signature: the line minus its signature. `sig` is appended
 * last on the wire, so deleting it and re-serializing reproduces exactly what
 * the signer hashed — JSON.parse preserves the key order of the text it read.
 */
function signedPayload(line: object): string {
  const { [SIGNATURE_FIELD]: _signature, ...rest } = line as Record<string, unknown>;
  return JSON.stringify(rest);
}

/** PEM keypair for a companion. The private half never leaves its machine. */
export function generateSigningKeys(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** The public half of a stored private key, so only the private one is kept. */
export function publicKeyFrom(privateKeyPem: string): string {
  return createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
}

/** Returns the line with its signature appended, ready to serialize. */
export function signEnvelope<T extends object>(
  envelope: T,
  privateKeyPem: string,
): T & { sig: string } {
  const signature = sign(null, Buffer.from(signedPayload(envelope)), privateKeyPem);
  return { ...envelope, [SIGNATURE_FIELD]: signature.toString('base64') } as T & { sig: string };
}

/**
 * Whether `line` carries a signature made by `publicKeyPem`. False for an
 * unsigned line, a malformed signature, or a key that cannot be read — a
 * verifier must not have to distinguish "unsigned" from "forged".
 */
export function verifyEnvelope(line: object, publicKeyPem: string): boolean {
  const signature = (line as Record<string, unknown>)[SIGNATURE_FIELD];
  if (typeof signature !== 'string') return false;
  try {
    return verify(
      null,
      Buffer.from(signedPayload(line)),
      publicKeyPem,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * Tally over a journal against every companion key the caller trusts. A signed
 * frame verifies if any key fits — the endpoint field sits inside the signed
 * payload, so there is no attacker-writable selector and no skip to bypass:
 * only an unsigned client frame is out of scope, and a signed frame counts
 * against `checked` no matter how its fields were rewritten.
 *
 * `breaks` counts signed-sequence violations per endpoint: each companion
 * numbers its frames 1,2,3… per session inside the payload, so among verified
 * frames each endpoint's run must climb by one from 1. A deleted frame leaves
 * a gap no rewriting can hide, which is also what still catches a signature
 * stripped to pose as a client frame. Limits: truncation at the tail, and
 * deletion of every signed frame at once, leave no survivors to break against.
 */
export function verifyJournalLines(
  lines: string[],
  publicKeyPems: string[],
  expected?: { runId: string; sessionId: string },
): { checked: number; verified: number; skipped: number; breaks: number; misplaced: number } {
  let checked = 0;
  let verified = 0;
  let skipped = 0;
  let breaks = 0;
  let misplaced = 0;
  const lastSeqByEndpoint = new Map<string, number>();
  for (const line of lines) {
    let parsed: Record<string, unknown> | undefined;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object') parsed = value as Record<string, unknown>;
    } catch {
      /* left undefined */
    }
    if (typeof parsed?.sig !== 'string' && parsed?.dir === 'out') {
      skipped += 1;
      continue;
    }
    checked += 1;
    if (!parsed || !publicKeyPems.some((pem) => verifyEnvelope(parsed, pem))) continue;
    // Genuine signature, wrong journal: runId/sessionId are signed, so a file
    // swapped in from another run or session gives itself away here. Kept out
    // of the sequence runs — foreign frames form their own coherent run.
    if (expected && (parsed.runId !== expected.runId || parsed.sessionId !== expected.sessionId)) {
      misplaced += 1;
      continue;
    }
    verified += 1;
    const endpoint = typeof parsed.endpoint === 'string' ? parsed.endpoint : '';
    if (parsed.seq !== (lastSeqByEndpoint.get(endpoint) ?? 0) + 1) breaks += 1;
    if (typeof parsed.seq === 'number') lastSeqByEndpoint.set(endpoint, parsed.seq);
  }
  return { checked, verified, skipped, breaks, misplaced };
}
