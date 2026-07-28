import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  isSafeId,
  parseEnvelope,
  parseRelayControl,
  type AckControl,
  type RefusalCode,
  readNdjsonBody,
  type ObserverEnvelope,
} from '@symma/protocol';

import {
  appendEnvelope,
  deleteJournal,
  journalPath,
  listJournals,
  listRuns,
  parseRunControl,
  readJournalLines,
  readRunStatus,
  writeRunStatus,
  type RunControl,
} from './journal.js';
import { createRelay, parseEndpointTokens } from './relay.js';
import { localStore, openStore, type Owner, type SessionRef, type Store } from './store.js';
import { VIEWER_HTML } from './viewer.js';

// SSE comment ping; keeps idle viewer connections alive through proxies.
const HEARTBEAT_MS = 25_000;

const port =
  Number(process.env.SYMMA_GATEWAY_PORT) > 0 ? Number(process.env.SYMMA_GATEWAY_PORT) : 8790;
const dataDir = process.env.SYMMA_GATEWAY_DATA?.trim() || 'gateway-data';
const token = process.env.SYMMA_GATEWAY_TOKEN?.trim() || '';
// No token = local mode: loopback bind only, no auth — SYMMA_GATEWAY_HOST
// cannot override that. With a token the default is all interfaces; behind a
// local TLS proxy (deploy/observer), SYMMA_GATEWAY_HOST=127.0.0.1 keeps token
// auth while making the proxy the only public door, firewall or not.
const databaseUrl = process.env.SYMMA_GATEWAY_DATABASE_URL?.trim() || '';
// A database is authentication too, so it unlocks the configured bind exactly
// as the shared token does — otherwise a multi-tenant deployment has to invent
// a dummy token it never uses to become reachable.
const host =
  token || databaseUrl ? process.env.SYMMA_GATEWAY_HOST?.trim() || '0.0.0.0' : '127.0.0.1';
// Always present. Without a database it is the journal directory with one
// implicit tenant — the same contract, not a bypass. `if (store)` used to fork
// nine call sites, and a behaviour written on one side kept shipping without
// the other.
let store: Store;
// §1: "frames expire on a default window (start at 30 days)". 0 disables.
const retentionDays = Number(process.env.SYMMA_GATEWAY_RETENTION_DAYS ?? 30);
const RETENTION_SWEEP_MS = 60 * 60 * 1000;
// Tighter than retention: this is how long a revoked peer keeps working. `||`,
// not `??`: setInterval reads a NaN delay as 1ms, so a typo here would be a
// self-inflicted hot loop against the database.
const REVOCATION_SWEEP_MS = Number(process.env.SYMMA_GATEWAY_REVOCATION_MS) || 30_000;

const log = (msg: string): void => {
  console.log(`[symma-gateway] ${msg}`);
};

/** Same fail-open contract as journalWrite, for the store's fire-and-forget
 * writes: a failed recordSession costs its owner the journal, so it must be
 * loud in the log even though nothing here can retry it. */
const storeWrite = (what: string, write: Promise<void>): void => {
  void write.catch((error: unknown) =>
    log(`${what} failed: ${error instanceof Error ? error.message : String(error)}`),
  );
};

/** Journaling is observability: a write failure (ENOSPC, EACCES) must never
 * break the live relay, nor abort an in-flight review's remaining frames and
 * its terminal run status. Both write paths fail open through here. */
const journalWrite = (write: () => void): void => {
  try {
    write();
  } catch (error) {
    log(`journal write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/** `gzip;q=0` is a refusal (RFC 9110 §12.5.3), so a bare substring test would
 * hand a client the one encoding it just declined. The accepted set is
 * unchanged — `gzip` and the legacy `x-gzip` — only the weight is now read. A
 * malformed weight reads as a refusal: uncompressed is always safe to send. */
function acceptsGzip(header: string): boolean {
  const token = header
    .split(',')
    .map((part) => part.trim())
    .find((part) => /^(x-)?gzip\s*(;|$)/i.test(part));
  const q = token?.match(/;\s*q=([\d.]+)/i);
  return Boolean(token) && (!q || Number(q[1]) > 0);
}

const subscribers = new Map<string, Set<ServerResponse>>();
const journalKey = (runId: string, sessionId: string): string => `${runId}/${sessionId}`;

// Relay state: companions and clients each hold one SSE leg; sends resolve
// through the maps so a reconnect rebinds without touching the relay.
const endpointTokens = parseEndpointTokens(process.env.SYMMA_GATEWAY_ENDPOINTS);
const endpointStreams = new Map<string, ServerResponse>();
const sessionStreams = new Map<string, ServerResponse>();
const relay = createRelay({
  resumeWindowMs:
    Number(process.env.SYMMA_GATEWAY_RESUME_MS) > 0
      ? Number(process.env.SYMMA_GATEWAY_RESUME_MS)
      : undefined,
  onLine: (sessionId, runId, _dir, line) => {
    const envelope = parseEnvelope(line);
    if (!envelope) return;
    // The relay knows which session a line arrived on; the line only claims.
    // Taking the claim would let either peer of one session write into another
    // run's journal and fan frames to its viewers, so the relay's ids win.
    if (envelope.runId !== runId || envelope.sessionId !== sessionId) {
      log(`dropped frame on ${sessionId}: claimed ${envelope.runId}/${envelope.sessionId}`);
      return;
    }
    fanOut(envelope, line);
    journalWrite(() => appendEnvelope(dataDir, envelope));
  },
});
const sendToEndpoint =
  (id: string) =>
  (line: string): void => {
    const res = endpointStreams.get(id);
    if (res) sseWrite(res, line);
  };
const sendToSession =
  (sid: string) =>
  (line: string): void => {
    const res = sessionStreams.get(sid);
    if (res) sseWrite(res, line);
  };

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
}

/** Query token is for EventSource/browser GETs only (they cannot set headers);
 * ingest (POST) must use the Authorization header so the token never lands in
 * access logs or proxy caches. */
function clientToken(req: IncomingMessage, url: URL): string {
  return bearerToken(req) ?? (req.method === 'GET' ? (url.searchParams.get('token') ?? '') : '');
}

// SSE writes must never throw: a subscriber can disconnect between the
// membership check and the write, and an unhandled error would crash the
// long-lived gateway. Fail open per subscriber.
function sseSend(res: ServerResponse, payload: string): void {
  try {
    res.write(payload);
  } catch {
    /* subscriber gone; cleanup runs on its close/error */
  }
}
function sseWrite(res: ServerResponse, line: string): void {
  sseSend(res, `data: ${line}\n\n`);
}

function fanOut(envelope: ObserverEnvelope, line: string): void {
  const subs = subscribers.get(journalKey(envelope.runId, envelope.sessionId));
  if (!subs) return;
  for (const res of subs) sseWrite(res, line);
}

// A run-status control targets no single session, so it reaches every viewer
// of any session in that run.
function fanRunControl(control: RunControl, line: string): void {
  const prefix = `${control.runId}/`;
  for (const [key, subs] of subscribers) {
    if (!key.startsWith(prefix)) continue;
    for (const res of subs) sseWrite(res, line);
  }
}

/** Store + fan one ingest line. Returns whether it was a recognized message. */
function acceptLine(line: string): boolean {
  const control = parseRunControl(line);
  if (control) {
    journalWrite(() => writeRunStatus(dataDir, control));
    fanRunControl(control, JSON.stringify(control));
    return true;
  }
  const envelope = parseEnvelope(line);
  if (!envelope) return false;
  journalWrite(() => appendEnvelope(dataDir, envelope));
  fanOut(envelope, JSON.stringify(envelope));
  return true;
}

async function handleIngest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Bounded NDJSON: one envelope per line, appended and fanned out as it
  // arrives so live viewers track an in-flight review.
  let accepted = 0;
  let rejected = 0;
  const { overflow } = await readNdjsonBody(req, (line) => {
    if (acceptLine(line)) accepted += 1;
    else rejected += 1;
  });
  if (overflow) {
    res.writeHead(413, { 'content-type': 'text/plain' });
    res.end('payload too large');
    req.destroy();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ accepted, rejected }));
}

function overflowOr(res: ServerResponse, req: IncomingMessage, overflow: boolean): void {
  if (overflow) {
    res.writeHead(413, { 'content-type': 'text/plain' });
    res.end('payload too large');
    req.destroy();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
}

// Companion upstream: hello attaches, acks/frames route by sessionId. The
// path id is the authority — a hello for another endpoint is ignored.
async function handleEndpointIngest(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  owner: Owner,
): Promise<void> {
  const { overflow } = await readNdjsonBody(req, (line) => {
    const control = parseRelayControl(line);
    if (control) {
      if (control.kind === 'hello' && control.endpoint === id) {
        relay.attachEndpoint(control, sendToEndpoint(id), owner);
        storeWrite(`markSeen ${id}`, store.markSeen(id));
      } else if (control.kind === 'opened' || control.kind === 'refused') {
        // Only on an ack the relay actually applied: a companion naming
        // another endpoint's session is ignored there, and deleting its row
        // anyway would strip the real owner's authorization and retention.
        // Captured before the ack removes the session: the delete is scoped by
        // run so it cannot strip a historical row that reuses the id.
        const refusedRun = relay.sessionRun(control.sessionId);
        const applied = relay.endpointAck(id, control, line);
        // The relay accepted this open before the companion saw it; a refusal
        // now leaves a row with no session, which both shows as an empty run
        // and blocks the id from being opened again.
        if (applied && control.kind === 'refused' && refusedRun)
          storeWrite(
            `deleteSessionRow ${control.sessionId}`,
            store.deleteSessionRow(control.sessionId, refusedRun, id).then(forgetSessions),
          );
      } else if (control.kind === 'close') {
        relay.endpointClose(id, control.sessionId, control.reason ?? 'closed by endpoint');
      }
      return;
    }
    const envelope = parseEnvelope(line);
    if (envelope) relay.endpointLine(id, envelope.sessionId, line);
  });
  overflowOr(res, req, overflow);
}

// Client upstream: open pairs, frames relay, close tears down. The path sid
// is the authority for every line.
/** Postgres codes the reservation can answer instead of failing on: the id is
 * already taken (23505), or the endpoint row went away under a concurrent
 * delete (23503) — which is the fact the attachment check reports as offline,
 * arriving one layer down because that check reads the relay, not the store. */
const INSERT_REFUSALS: Record<string, [RefusalCode, string] | undefined> = {
  23505: ['session_in_use', 'session id in use'],
  23503: ['offline', 'endpoint offline'],
};

async function handleSessionIngest(
  req: IncomingMessage,
  res: ServerResponse,
  sid: string,
  owner: Owner,
): Promise<void> {
  const { overflow } = await readNdjsonBody(req, async (line) => {
    const control = parseRelayControl(line);
    if (control?.kind === 'open' && control.sessionId === sid) {
      // Ownership before the write. The reserve below names the endpoint the
      // caller asked for, so checking it only in openSession lets a caller
      // insert a row against someone else's endpoint — which then blocks that
      // id for its real owner and shows up in their listing.
      if (relay.endpointOwner(control.endpoint) !== owner) {
        refuseToSender(sid, owner, 'offline', 'endpoint offline');
        return;
      }
      // Reserve before dispatching. The insert is what rejects a reused id, and
      // until it lands the session is open, the companion has the open, and a
      // frame later in this same body would journal into whoever owned that id
      // last. A conflict here refuses instead.
      {
        try {
          await store.recordSession({
            id: sid,
            runId: control.runId,
            endpoint: control.endpoint,
            agent: control.agent,
            model: control.model,
          });
        } catch (error) {
          // Both are the caller's answer and neither is retryable. Anything
          // else is our outage, and refusing would tell them not to retry
          // something that clears on its own — so it throws.
          const refusal = INSERT_REFUSALS[(error as { code?: string }).code ?? ''];
          log(
            `recordSession ${sid} ${refusal ? 'refused' : 'failed'}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          if (!refusal) throw error;
          refuseToSender(sid, owner, ...refusal);
          return;
        }
      }
      const accepted = relay.openSession(control, sendToSession(sid), owner);
      // Reserved but refused: release it, or the id is unopenable from here on.
      if (!accepted)
        storeWrite(
          `deleteSessionRow ${sid}`,
          store.deleteSessionRow(sid, control.runId, control.endpoint).then(forgetSessions),
        );
      // maySession keeps a stranger from registering while someone holds the
      // id, but a registration can still interleave with the await above, when
      // neither the relay nor the map has a claim yet. Evict what that leaves.
      if (accepted && sessionStreamOwners.get(sid) !== owner) {
        sessionStreams.get(sid)?.end();
        sessionStreams.delete(sid);
        sessionStreamOwners.delete(sid);
      }
      // Only a session the relay accepted may leave a row. A refused open that
      // recorded one would put a run in its owner's listing whose journal never
      // existed, and every read of it 404s.
    } else if (!maySession(owner, sid)) {
      // Everything past the open touches a session that already has an owner:
      // a close ends it, a frame is forwarded to the endpoint as if the owner
      // sent it. Drop both silently rather than confirm the session exists.
    } else if (control?.kind === 'close' && control.sessionId === sid) {
      relay.closeSession(sid, control.reason ?? 'closed by client');
    } else if (!control) {
      const envelope = parseEnvelope(line);
      if (envelope && envelope.sessionId === sid) relay.clientLine(sid, line);
    }
  });
  overflowOr(res, req, overflow);
}

/** The token names the endpoint it may speak for; a token for one endpoint
 * cannot attach as another (§1: the owner is never read off `hello`). Takes the
 * token rather than the request because a held leg re-runs it on the sweep —
 * and its callers pass the header only, since a companion is a fetch client and
 * never needs the ?token= query form that lands in logs. */
async function endpointOwner(token: string, id: string): Promise<Owner | undefined> {
  const found = await store.endpointForToken(token);
  return found?.endpoint === id ? found.owner : undefined;
}

/**
 * Every other authorization check runs per request, but a stream or an ingest
 * body is admitted once and then lives for hours, so revoking its token,
 * deactivating its owner or uninstalling the workspace left it serving.
 * Invariant 3 says compromise means shutdown, which a revocation that only
 * reaches the next request does not deliver.
 *
 * Held legs re-run the exact check that admitted them, so revoking one of an
 * endpoint's tokens drops the legs that token opened and leaves the rest — and
 * every long-lived leg is held, because covering one kind just moves the
 * survivor to another.
 */
interface HeldLeg {
  what: string;
  admits: () => Promise<boolean>;
}
const heldLegs = new Map<ServerResponse, HeldLeg>();

function holdLeg(res: ServerResponse, what: string, admits: () => Promise<boolean>): void {
  heldLegs.set(res, { what, admits });
  res.on('close', () => heldLegs.delete(res));
}

/** One live SSE leg per peer; last connection wins, cleanup only clears the
 * map when this response is still the registered one. */
function registerPeerStream(
  streams: Map<string, ServerResponse>,
  key: string,
  res: ServerResponse,
  onGone?: () => void,
): void {
  streams.get(key)?.end();
  streams.set(key, res);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  // Flush headers now — peers await them before sending hello/open.
  sseSend(res, ': connected\n\n');
  const heartbeat = setInterval(() => sseSend(res, ': ping\n\n'), HEARTBEAT_MS);
  heartbeat.unref();
  let done = false;
  const cleanup = (): void => {
    if (done) return;
    done = true;
    clearInterval(heartbeat);
    if (streams.get(key) === res) {
      streams.delete(key);
      onGone?.();
    }
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
}

/**
 * The whole journal in one compressible, cacheable response. A finished review
 * is immutable and often large — the run that prompted this is 24k frames and
 * 9MB — and SSE can carry none of that cheaply: it is never compressed (that
 * would defeat streaming) and never cached, so every visit paid full size and
 * 24k message dispatches to replay something that had stopped changing.
 */
function handleJournal(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  sessionId: string,
): void {
  let mtimeMs: number;
  let size: number;
  try {
    const stat = statSync(journalPath(dataDir, runId, sessionId));
    mtimeMs = stat.mtimeMs;
    size = stat.size;
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no journal');
    return;
  }
  const status = readRunStatus(dataDir, runId);
  // Size and mtime together: an append changes both, so a stale body cannot
  // survive a revalidation even while a run is still being written.
  const etag = `"${size}-${Math.trunc(mtimeMs)}"`;
  const live = status === undefined || status === 'reviewing';
  if (!live && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag });
    res.end();
    return;
  }
  // The file is already newline-delimited JSON, so it ships as-is rather than
  // being split into lines only to be rejoined — that tripled peak memory for
  // no gain. Same shape the stream sends: run status first, then the frames.
  let frames: Buffer;
  try {
    frames = readFileSync(journalPath(dataDir, runId, sessionId));
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no journal');
    return;
  }
  const head = status
    ? `${JSON.stringify({ v: 1, kind: 'run', runId, status, ts: Math.trunc(mtimeMs) })}\n`
    : '';
  // Compressed here rather than at the proxy: a journal is ~34x smaller gzipped,
  // and making that depend on external config would leave a standalone gateway
  // shipping megabytes. A proxy that sees content-encoding set passes it through.
  const gzipped = acceptsGzip(String(req.headers['accept-encoding'] ?? ''));
  res.writeHead(200, {
    'content-type': 'application/x-ndjson',
    etag,
    vary: 'accept-encoding',
    // Revalidate rather than freeze: a late frame after a status write must not
    // be able to serve a stale transcript forever. A 304 costs one round trip.
    'cache-control': live ? 'no-store' : 'private, max-age=0, must-revalidate',
    ...(gzipped ? { 'content-encoding': 'gzip' } : {}),
  });
  // Header and body written separately, never concatenated: joining them copies
  // the whole journal a second time for nothing.
  if (!gzipped) {
    if (head) res.write(head);
    res.end(frames);
    return;
  }
  const gz = createGzip();
  // Same reason sseSend swallows: an unhandled stream error would take the whole
  // gateway down. A client vanishing mid-response is handled by pipe's unpipe —
  // measured, no crash and no retained buffers — but a zlib failure has nothing
  // listening, so it ends this response instead of the process.
  gz.on('error', () => res.destroy());
  gz.pipe(res);
  if (head) gz.write(head);
  gz.end(frames);
}

function handleStream(res: ServerResponse, runId: string, sessionId: string): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  // Send the run status FIRST, so a viewer opening a finished run sees the
  // terminal verdict before the replayed frames and never flashes "reviewing".
  const status = readRunStatus(dataDir, runId);
  if (status) sseWrite(res, JSON.stringify({ v: 1, kind: 'run', runId, status, ts: Date.now() }));
  // Then replay the journal. Replay + subscribe is one synchronous block, so no
  // live frame slips through the gap; the viewer also de-dupes by seq, which
  // tolerates the EventSource auto-reconnect replay.
  for (const line of readJournalLines(dataDir, runId, sessionId)) sseWrite(res, line);
  const key = journalKey(runId, sessionId);
  let subs = subscribers.get(key);
  if (!subs) {
    subs = new Set();
    subscribers.set(key, subs);
  }
  subs.add(res);
  const heartbeat = setInterval(() => sseSend(res, ': ping\n\n'), HEARTBEAT_MS);
  heartbeat.unref();
  // close and error can both fire; run once, and only drop the key if this is
  // still the set the map holds (a concurrent reconnect may have replaced it).
  let done = false;
  const cleanup = (): void => {
    if (done) return;
    done = true;
    clearInterval(heartbeat);
    subs.delete(res);
    if (subs.size === 0 && subscribers.get(key) === subs) subscribers.delete(key);
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
}

/** A live session belongs to whoever opened it. Unknown means not open yet —
 * clients connect their leg before sending the open — so it cannot be a
 * refusal, and `openSession` is what authorizes the open itself. */
const sessionStreamOwners = new Map<string, Owner>();

/** A refusal the relay never saw, so it has no clientSend to use. Goes out only
 * down a leg this caller holds: sendToSession resolves whichever stream is
 * registered, and for a contested id that is someone else's — whose client
 * reads any refusal as its own session failing. */
function refuseToSender(sid: string, owner: Owner, code: RefusalCode, reason: string): void {
  if (sessionStreamOwners.get(sid) !== owner) return;
  sendToSession(sid)(
    JSON.stringify({ kind: 'refused', sessionId: sid, code, reason } satisfies AckControl),
  );
}

function maySession(owner: Owner, sessionId: string): boolean {
  // Before the open there is no relay owner, so the leg itself is the claim:
  // otherwise a second caller registers over the first and ends it, and the
  // client treats its stream ending as the session failing.
  const held = relay.sessionOwner(sessionId) ?? sessionStreamOwners.get(sessionId);
  return held === undefined || held === owner;
}

/** 404 rather than 403 throughout: whether a session exists is itself owned. */
function ownsSession(owner: Owner, runId: string, sessionId: string): Promise<boolean> {
  return store.sessionBelongsTo(owner, runId, sessionId);
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  // Companion routes authenticate with their per-endpoint token, not the
  // gateway token, so they sit before the global gate.
  const endpointRoute = url.pathname.match(/^\/api\/endpoints\/([^/]+)\/(stream|ingest)$/);
  if (endpointRoute) {
    const [, id, mode] = endpointRoute;
    const token = bearerToken(req) ?? '';
    const endpointOwned = isSafeId(id) ? await endpointOwner(token, id) : undefined;
    if (!endpointOwned) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('unauthorized');
      return;
    }
    const stillEndpoint = async (): Promise<boolean> =>
      (await endpointOwner(token, id)) === endpointOwned;
    if (mode === 'stream' && req.method === 'GET') {
      registerPeerStream(endpointStreams, id, res, () => relay.detachEndpoint(id));
      holdLeg(res, `endpoint ${id} stream`, stillEndpoint);
      return;
    }
    if (mode === 'ingest' && req.method === 'POST') {
      holdLeg(res, `endpoint ${id} ingest`, stillEndpoint);
      void handleEndpointIngest(req, res, id, endpointOwned).catch(() => res.destroy());
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  const token = clientToken(req, url);
  const owner = await store.ownerForClientToken(token);
  if (!owner) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('unauthorized');
    return;
  }
  const stillClient = async (): Promise<boolean> =>
    (await store.ownerForClientToken(token)) === owner;
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(VIEWER_HTML);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/runs') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    // Runs the caller owns, intersected with what is on disk — a run with no
    // session row belongs to nobody and is listed by nobody.
    const mine = await store.runsFor(owner);
    const runs = listRuns(dataDir).filter((r) => mine.has(r.runId));
    // A runId is caller-chosen, so two tenants can share one run directory and
    // the listing would name the other's sessions. One query for all of them:
    // per-run would grow with a tenant's history on every viewer refresh.
    {
      const owned = await store.sessionsByRun(
        owner,
        runs.map((r) => r.runId),
      );
      for (const run of runs) {
        const mineHere = owned.get(run.runId) ?? new Set<string>();
        run.sessions = run.sessions.filter((sid) => mineHere.has(sid));
        // updatedAt came from every journal in the shared directory, so it
        // reported when the other tenant last wrote. Recompute from ours.
        run.updatedAt = journalsUpdatedAt(
          dataDir,
          run.runId,
          run.sessions,
          run.status !== undefined,
        );
      }
    }
    res.end(JSON.stringify(runs));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/endpoints') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    res.end(JSON.stringify(relay.listEndpoints(owner)));
    return;
  }
  const sessionRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(stream|ingest)$/);
  if (sessionRoute) {
    const [, sid, mode] = sessionRoute;
    if (!isSafeId(sid)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad id');
      return;
    }
    if (mode === 'stream' && req.method === 'GET') {
      // registerPeerStream is last-connection-wins, so an unchecked connect
      // does not just read someone else's frames — it takes their leg away.
      if (!maySession(owner, sid)) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      // Client leg (re)connected: cancel any pending client-side resume, then
      // arm it again if this leg drops — symmetric with the endpoint side, so a
      // blip or the SIGTERM drain doesn't kill the session outright.
      relay.attachClient(sid);
      registerPeerStream(sessionStreams, sid, res, () => {
        relay.detachClient(sid);
        if (sessionStreams.get(sid) === undefined) sessionStreamOwners.delete(sid);
      });
      // After registering, not before: evicting the previous leg runs its
      // cleanup, which would delete the entry this line sets.
      sessionStreamOwners.set(sid, owner);
      holdLeg(res, `session ${sid} stream`, stillClient);
      return;
    }
    if (mode === 'ingest' && req.method === 'POST') {
      holdLeg(res, `session ${sid} ingest`, stillClient);
      void handleSessionIngest(req, res, sid, owner).catch(() => res.destroy());
      return;
    }
  }
  const journal = url.pathname.match(/^\/api\/runs\/([^/]+)\/sessions\/([^/]+)\/journal$/);
  if (req.method === 'GET' && journal) {
    const [, runId, sessionId] = journal;
    if (!isSafeId(runId) || !isSafeId(sessionId)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad id');
      return;
    }
    if (!(await ownsSession(owner, runId, sessionId))) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    handleJournal(req, res, runId, sessionId);
    return;
  }
  if (req.method === 'DELETE' && journal) {
    const [, runId, sessionId] = journal;
    if (!isSafeId(runId) || !isSafeId(sessionId)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad id');
      return;
    }
    const gone = await store.deleteSession(owner, runId, sessionId);
    if (gone.length === 0) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    // Ending it is part of deleting it. A live session keeps journaling, so the
    // next frame recreates the file with nothing behind it — unreadable,
    // undeletable, and past retention's reach, which turns a delete into a
    // permanent retention leak.
    relay.closeSession(sessionId, 'session deleted by its owner');
    forgetSessions(gone);
    res.writeHead(204);
    res.end();
    return;
  }
  const stream = url.pathname.match(/^\/api\/runs\/([^/]+)\/sessions\/([^/]+)\/stream$/);
  if (req.method === 'GET' && stream) {
    const [, runId, sessionId] = stream;
    if (!isSafeId(runId) || !isSafeId(sessionId)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad id');
      return;
    }
    if (!(await ownsSession(owner, runId, sessionId))) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    handleStream(res, runId, sessionId);
    holdLeg(res, `journal ${runId}/${sessionId}`, stillClient);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/ingest' && databaseUrl) {
    // The observer tee journals sessions this gateway never routed, so its
    // runId and sessionId are whatever the caller says — there is nothing to
    // check them against, and unchecked they write into another tenant's
    // journal. Multi-tenant frames arrive through the relay, which knows whose
    // session they belong to.
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/ingest') {
    void handleIngest(req, res).catch(() => {
      // The socket may already be gone; nothing useful left to do.
      res.destroy();
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

const server = createServer((req, res) => {
  // Handlers do synchronous fs reads and now await the store; either a corrupt
  // file or an unreachable database must return 500, never crash the long-lived
  // gateway. route() is async, so this catches the rejection, not a throw.
  void route(req, res).catch((error: unknown) => {
    log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('internal error');
  });
});
// The ingest POST streams for a whole review (often >5min); Node's default
// 300s requestTimeout would sever it mid-review, dropping trailing frames and
// the terminal run status (leaving the viewer stuck on "reviewing"). Byte caps
// in handleIngest are the real bound, so disable the wall-clock cap.
server.requestTimeout = 0;

// Drain on deploy: close every live SSE leg so peers reconnect and resume
// within the relay's window, instead of waiting out dead connections.
process.on('SIGTERM', () => {
  log('SIGTERM: draining');
  server.close(() => process.exit(0));
  for (const res of endpointStreams.values()) res.end();
  for (const res of sessionStreams.values()) res.end();
  for (const subs of subscribers.values()) for (const res of subs) res.end();
  setTimeout(() => process.exit(0), 3000).unref();
});

/** Frames and their row are one unit; deleting either alone leaves a journal
 * nobody can reach or a row pointing at nothing. */
/** Newest mtime across just these journals, plus the run's status file when it
 * has one — the same inputs listRuns uses, narrowed to what the caller owns. */
function journalsUpdatedAt(
  dir: string,
  runId: string,
  sessions: string[],
  withStatus: boolean,
): number {
  const times = sessions.map((sid) => {
    try {
      return statSync(journalPath(dir, runId, sid)).mtimeMs;
    } catch {
      return 0;
    }
  });
  if (withStatus) {
    try {
      times.push(statSync(join(dir, runId, 'status')).mtimeMs);
    } catch {
      /* status vanished mid-list */
    }
  }
  return times.length > 0 ? Math.max(...times) : 0;
}

function forgetSessions(doomed: SessionRef[]): void {
  for (const { runId, sessionId } of doomed) {
    try {
      deleteJournal(dataDir, runId, sessionId);
    } catch (error) {
      // The row is already gone, so this file now sits outside authorization
      // and retention both. Nothing here can fix it; it must not be silent.
      log(
        `orphaned journal ${runId}/${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

// Fail to start rather than start unscoped: a gateway told to use a database it
// cannot reach has no owners, and silently falling back would serve every
// tenant's journals to whoever asked.
store = databaseUrl
  ? await openStore(databaseUrl, fileURLToPath(new URL('./schema.sql', import.meta.url)))
  : localStore(token, endpointTokens, () => listJournals(dataDir));

/** Destroy, not end: a revocation is a shutdown, and a half-closed response
 * still leaves the peer's request body streaming in. Cleanup runs off `close`,
 * which detaches the relay and drops the leg from `heldLegs`. */
function dropRevokedLegs(): void {
  void (async () => {
    for (const [res, leg] of heldLegs) {
      if (await leg.admits()) continue;
      log(`${leg.what} is no longer authorized; dropping`);
      res.destroy();
    }
  })().catch((error: unknown) =>
    log(`revocation sweep failed: ${error instanceof Error ? error.message : String(error)}`),
  );
}
setInterval(dropRevokedLegs, REVOCATION_SWEEP_MS).unref();

if (retentionDays > 0) {
  // A sweep that fails is a promise unkept, not a reason to stop serving — same
  // fail-open contract as the journal, and identical at boot and on the
  // interval so a transient failure does not decide whether we start.
  const sweep = (): void => {
    void (async () => {
      const doomed = await store.expireSessions(retentionDays, relay.liveSessions());
      forgetSessions(doomed);
      if (doomed.length > 0) log(`retention: expired ${doomed.length} sessions`);
    })().catch((error: unknown) =>
      log(`retention failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  };
  // Both modes, at boot as well as on the interval: retention is a product
  // promise (§1), and a gateway that restarts often still has to forget.
  sweep();
  setInterval(sweep, RETENTION_SWEEP_MS).unref();
}

server.listen(port, host, () => {
  log(`listening on http://${host}:${port} (data: ${dataDir})`);
  log(
    databaseUrl
      ? 'multi-tenant: endpoints, journals and listings are owner-scoped'
      : token
        ? 'single tenant, token auth; ingest needs Authorization: Bearer, viewers ?token='
        : 'single tenant, local mode: loopback only, no auth',
  );
});
