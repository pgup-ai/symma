/**
 * Companion: dials OUT to the gateway (no listeners) and bridges local ACP
 * agent binaries — with the machine's own ambient auth — to relayed sessions.
 * Frames pass verbatim; the only local interception is the permission
 * deny-floor, enforced here independently of any client so a remote party can
 * never authorize writes on this machine.
 * Spec: docs/design/m2-acp-gateway.md (M2a).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  codexAcpSpec,
  codexAuthPath,
  createNdjsonReader,
  cursorAcpSpec,
  devinAcpSpec,
  devinCredentialsPath,
  generateSigningKeys,
  kiloAcpSpec,
  parseRelayControl,
  publicKeyFrom,
  respondToPermissionRequest,
  signEnvelope,
  terminateProcessTree,
  type AcpAgentSpec,
  type HelloControl,
  type ObserverEnvelope,
  type OpenControl,
  type RelayControl,
} from '@symma/protocol';

import { fetchWorkspace } from './workspace.ts';

const KILL_GRACE_MS = 2_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// Must-deliver buffer while the gateway is away; overflow fails sessions loud.
const MAX_OUTBOX_LINES = 10_000;

const gatewayUrl = (process.env.JBOT_COMPANION_GATEWAY ?? '').trim().replace(/\/+$/, '');
const token = (process.env.JBOT_COMPANION_TOKEN ?? '').trim();
const endpointId = (process.env.JBOT_COMPANION_ENDPOINT ?? '').trim();
const device = (process.env.JBOT_COMPANION_DEVICE ?? '').trim() || hostname();
const agentNames = (process.env.JBOT_COMPANION_AGENTS ?? 'kilo')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
const maxSessions =
  Number(process.env.JBOT_COMPANION_MAX_SESSIONS) > 0
    ? Number(process.env.JBOT_COMPANION_MAX_SESSIONS)
    : 2;

/**
 * Signing key for this machine, generated once and kept at 0600. The private
 * half never leaves here: signing at the companion is what makes the journal
 * tamper-evident against the relay rather than merely by it.
 */
function loadSigningKeys(): { privateKey: string; publicKey: string } {
  const dir = join(homedir(), '.local', 'share', 'jbot-companion');
  const path = join(dir, 'signing-key.pem');
  // The public half sits beside it as a file the operator can copy off this
  // machine: a journal audit that distrusts the gateway needs a key that never
  // came from the gateway, and this is that channel.
  const publish = (publicKey: string): void =>
    writeFileSync(join(dir, 'signing-key.pub.pem'), publicKey, { mode: 0o644 });
  if (existsSync(path)) {
    const privateKey = readFileSync(path, 'utf8');
    const publicKey = publicKeyFrom(privateKey);
    publish(publicKey);
    return { privateKey, publicKey };
  }
  const keys = generateSigningKeys();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Written elsewhere then linked into place: `wx` alone would expose the path
  // before the PEM is complete, and a racing start could read half a key. The
  // link fails if another start won, and that winner's key is the one used.
  const staged = `${path}.${process.pid}`;
  writeFileSync(staged, keys.privateKey, { mode: 0o600 });
  try {
    linkSync(staged, path);
    publish(keys.publicKey);
    return keys;
  } catch (error) {
    // Only a lost race falls back; anything else (permissions, full disk) must
    // surface itself rather than resurface as ENOENT on a path never created.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const privateKey = readFileSync(path, 'utf8');
    const publicKey = publicKeyFrom(privateKey);
    publish(publicKey);
    return { privateKey, publicKey };
  } finally {
    rmSync(staged, { force: true });
  }
}

const log = (msg: string): void => {
  console.log(`[jbot-companion] ${msg}`);
};

if (!gatewayUrl || !token || !endpointId) {
  console.error('Set JBOT_COMPANION_GATEWAY, JBOT_COMPANION_TOKEN, and JBOT_COMPANION_ENDPOINT.');
  process.exit(1);
}

// After the config guard, so a misconfigured start writes no key material.
const signingKeys = loadSigningKeys();

/** Built-ins use the machine's ambient auth; `name=cmd arg…` entries add any
 * ACP binary (also the test seam). Returns an error string when auth is absent. */
function resolveAgent(entry: string): { name: string; spec: AcpAgentSpec } | string {
  const eq = entry.indexOf('=');
  if (eq !== -1) {
    const name = entry.slice(0, eq).trim();
    const [bin, ...args] = entry
      .slice(eq + 1)
      .trim()
      .split(/\s+/);
    if (!name || !bin) return `invalid custom agent entry: ${entry}`;
    return {
      name,
      spec: { id: name, bin, args: () => args, env: () => ({ env: { ...process.env } }) },
    };
  }
  switch (entry) {
    case 'kilo': {
      const path = join(homedir(), '.local', 'share', 'kilo', 'auth.json');
      if (!existsSync(path)) return `kilo: no auth at ${path} (run kilo login)`;
      return { name: entry, spec: kiloAcpSpec(readFileSync(path, 'utf8').trim()) };
    }
    case 'codex': {
      const home = join(homedir(), '.codex');
      if (!existsSync(codexAuthPath(home))) return `codex: no auth at ${codexAuthPath(home)}`;
      return { name: entry, spec: codexAcpSpec(home) };
    }
    case 'devin': {
      if (!existsSync(devinCredentialsPath(homedir())))
        return `devin: no credentials at ${devinCredentialsPath(homedir())}`;
      return { name: entry, spec: devinAcpSpec() };
    }
    case 'cursor': {
      const key = (process.env.CURSOR_API_KEY ?? '').trim();
      if (!key) return 'cursor: CURSOR_API_KEY not set';
      return { name: entry, spec: cursorAcpSpec(key) };
    }
    default:
      return `unknown agent: ${entry}`;
  }
}

const agents = new Map<string, AcpAgentSpec>();
for (const entry of agentNames) {
  const resolved = resolveAgent(entry);
  if (typeof resolved === 'string') log(`skipping agent — ${resolved}`);
  else agents.set(resolved.name, resolved.spec);
}
if (agents.size === 0) {
  console.error('No usable agents; check JBOT_COMPANION_AGENTS and local auth.');
  process.exit(1);
}

interface LiveSession {
  child: ChildProcess;
  runId: string;
  agent: string;
  model?: string;
  seq: number;
  workspace: string;
  cleanup?: () => void;
}

/** An open whose clone is still running: it holds a capacity slot and can be
 * cancelled before any agent is spawned. */
interface PendingOpen {
  cancelled: boolean;
  workspace: string;
  abort: AbortController;
}

const sessions = new Map<string, LiveSession>();
const pending = new Map<string, PendingOpen>();
const encoder = new TextEncoder();
let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
const outbox: string[] = [];
let shuttingDown = false;
/** Drops the current connection epoch; set while connected. */
let abortEpoch: (() => void) | undefined;

/** Drop an open still cloning: it stops holding capacity now, but its
 * workspace is reclaimed by openSession once git has actually exited — the
 * abort only signals, and deleting under a still-writing child recreates it. */
function abandonPending(sessionId: string, slot: PendingOpen): void {
  slot.cancelled = true;
  slot.abort.abort();
  pending.delete(sessionId);
}

// The upstream can't deliver, so don't try to send close frames through it
// (that would re-enter here): kill the agents, drop the epoch so no further
// opens are accepted into a dead stream, and let the reconnect resync — the
// gateway's resume window fails the sessions to their clients meanwhile.
function failAllSessions(reason: string): void {
  log(reason);
  for (const sessionId of sessions.keys()) endSession(sessionId, reason, false);
  for (const [sessionId, slot] of pending) abandonPending(sessionId, slot);
  upstream = undefined;
  outbox.length = 0;
  abortEpoch?.();
}

function sendLine(line: string): void {
  if (upstream) {
    try {
      upstream.enqueue(encoder.encode(`${line}\n`));
    } catch {
      upstream = undefined;
      outbox.push(line);
      return;
    }
    // desiredSize goes negative as the stream's queue backs up past its high-
    // water mark; a large backlog means a stalled gateway, so fail loud rather
    // than grow the queue without bound.
    const { desiredSize } = upstream;
    if (desiredSize !== null && desiredSize < -MAX_OUTBOX_LINES) {
      failAllSessions('companion upstream backlog exceeded');
    }
    return;
  }
  outbox.push(line);
  if (outbox.length > MAX_OUTBOX_LINES) {
    outbox.length = 0;
    failAllSessions('companion buffer overflow');
  }
}

function sendControl(control: RelayControl): void {
  sendLine(JSON.stringify(control));
}

function hello(): HelloControl {
  return {
    kind: 'hello',
    endpoint: endpointId,
    device,
    agents: [...agents.keys()].map((agent) => ({ agent })),
    maxSessions,
    // Live agents this process still holds — a fresh start sends none, so the
    // relay fails any stale sessions instead of leaving them as zombies. Opens
    // still cloning count: they have no agent yet, but the relay holds them and
    // would otherwise fail them for a blip the clone simply outlasted.
    // Abandoned ones are already out of `pending`, so they stay undeclared.
    sessions: [...sessions.keys(), ...pending.keys()],
    publicKey: signingKeys.publicKey,
  };
}

/** Reclaim a session's temp state. Never throws: a cleanup failure must not
 * abort a shutdown loop, an exit handler, or a refusal path. */
function discard(workspace: string, cleanup?: () => void): void {
  try {
    cleanup?.();
  } catch {
    /* best effort */
  }
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function finalizeSession(session: LiveSession): void {
  discard(session.workspace, session.cleanup);
}

function endSession(sessionId: string, reason: string, notify: boolean): void {
  const slot = pending.get(sessionId);
  if (slot) abandonPending(sessionId, slot);
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  // Reclaim temp homes/workspaces only after the child is truly gone — some
  // agents (kilo's SQLite dir) still write during the SIGTERM grace.
  const { child } = session;
  if (child.exitCode === null && child.signalCode === null) {
    child.once('exit', () => finalizeSession(session));
    terminateProcessTree(child, KILL_GRACE_MS);
  } else {
    finalizeSession(session);
  }
  if (notify) sendControl({ kind: 'close', sessionId, reason });
  log(`session ${sessionId} ended: ${reason}`);
}

async function openSession(control: OpenControl): Promise<void> {
  const refuse = (reason: string): void => {
    sendControl({ kind: 'refused', sessionId: control.sessionId, reason });
    log(`refused ${control.sessionId}: ${reason}`);
  };
  if (sessions.size + pending.size >= maxSessions) return refuse('at capacity');
  if (sessions.has(control.sessionId) || pending.has(control.sessionId))
    return refuse('session id in use');
  const spec = agents.get(control.agent);
  if (!spec) return refuse(`agent ${control.agent} not offered`);

  const model = control.model ?? 'default';
  const workspace = mkdtempSync(join(tmpdir(), 'jbot-companion-'));
  if (control.repo) {
    // The clone is the one await in this function: hold a slot across it so it
    // counts against capacity and a close can cancel it. Everything after runs
    // synchronously, so nothing can interleave between here and sessions.set.
    const slot: PendingOpen = { cancelled: false, workspace, abort: new AbortController() };
    pending.set(control.sessionId, slot);
    let failure: string | undefined;
    try {
      failure = await fetchWorkspace(
        workspace,
        control.repo,
        control.ref,
        control.base,
        slot.abort.signal,
      );
    } catch (error) {
      // handleWireLine turns this into a refusal, but only this frame still
      // knows which temp dir to reclaim.
      discard(workspace);
      throw error;
    } finally {
      // Conditional: a same-id open that started after this one was abandoned
      // owns the entry now.
      if (pending.get(control.sessionId) === slot) pending.delete(control.sessionId);
    }
    // Cancelled mid-clone: git has exited by now, so this is where the
    // workspace is safe to remove. Spawning would leave an agent nobody awaits.
    if (slot.cancelled || shuttingDown) {
      discard(workspace);
      return;
    }
    if (failure) {
      discard(workspace);
      return refuse(failure);
    }
  }

  let env: NodeJS.ProcessEnv;
  let cleanup: (() => void) | undefined;
  try {
    ({ env, cleanup } = spec.env(model));
  } catch (error) {
    discard(workspace);
    return refuse(`agent setup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Built-in specs build env from process.env, so scrub the companion's own
  // gateway credentials here — the single choke point every agent passes.
  for (const key of Object.keys(env)) if (key.startsWith('JBOT_COMPANION_')) delete env[key];

  let child: ChildProcess;
  try {
    child = spawn(spec.bin, spec.args(model), {
      cwd: workspace,
      env,
      // Own process group so terminateProcessTree's group signal reaches the
      // whole agent subtree (mirrors driveAcpSession).
      detached: process.platform !== 'win32',
      stdio: 'pipe',
    });
  } catch (error) {
    discard(workspace, cleanup);
    return refuse(`spawn failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Stream-level errors (EPIPE writing to a dead agent) must stay scoped to
  // this session, not throw out and take the whole companion down.
  child.stdin?.on('error', () => {});
  child.stdout?.on('error', () => {});
  // Drain stderr so a chatty agent can't deadlock on a full pipe buffer.
  child.stderr?.resume();
  child.stderr?.on('error', () => {});
  const session: LiveSession = {
    child,
    runId: control.runId,
    agent: control.agent,
    ...(control.model ? { model: control.model } : {}),
    seq: 0,
    workspace,
    cleanup,
  };
  sessions.set(control.sessionId, session);

  const read = createNdjsonReader((frame) => {
    // Deny-floor: permission requests are answered HERE with the read-only
    // policy and never forwarded — a remote client cannot grant writes.
    if (frame.method === 'session/request_permission' && frame.id !== undefined) {
      const response = respondToPermissionRequest(
        (frame.params ?? {}) as Parameters<typeof respondToPermissionRequest>[0],
      );
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: response })}\n`);
      return;
    }
    const envelope: ObserverEnvelope = {
      v: 1,
      runId: session.runId,
      sessionId: control.sessionId,
      seq: (session.seq += 1),
      ts: Date.now(),
      agent: session.agent,
      label: session.agent,
      ...(session.model ? { model: session.model } : {}),
      endpoint: endpointId,
      dir: 'in',
      frame,
    };
    sendLine(JSON.stringify(signEnvelope(envelope, signingKeys.privateKey)));
  });
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    if (!read(chunk)) endSession(control.sessionId, 'agent frame exceeded budget', true);
  });
  child.on('error', (error) =>
    endSession(control.sessionId, `spawn failed: ${error.message}`, true),
  );
  child.on('exit', (code) => {
    if (sessions.has(control.sessionId))
      endSession(control.sessionId, `agent exited ${code ?? 'by signal'}`, true);
  });
  // The client drives the session but doesn't hold the agent spec, so hand it
  // the workspace and this agent's session policy.
  sendControl({
    kind: 'opened',
    sessionId: control.sessionId,
    workspace,
    ...(spec.requirePlanMode ? { requirePlanMode: true } : {}),
    ...(spec.modelConfigCandidates ? { modelCandidates: spec.modelConfigCandidates(model) } : {}),
  });
  log(`session ${control.sessionId} opened (agent=${control.agent})`);
}

function handleWireLine(line: string): void {
  // Stop accepting work once shutting down, so a late open can't spawn an
  // agent that the shutdown sweep has already passed.
  if (shuttingDown) return;
  const control = parseRelayControl(line);
  if (control) {
    if (control.kind === 'open') {
      // The open is async now, so its rejection needs an owner here: an
      // unhandled one would take the whole companion down over one session.
      void openSession(control).catch((error: unknown) => {
        sendControl({
          kind: 'refused',
          sessionId: control.sessionId,
          reason: `open failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    } else if (control.kind === 'close')
      endSession(control.sessionId, control.reason ?? 'closed', false);
    return;
  }
  try {
    const envelope = JSON.parse(line) as ObserverEnvelope;
    if (envelope.dir !== 'out' || !envelope.sessionId || !envelope.frame) return;
    sessions.get(envelope.sessionId)?.child.stdin?.write(`${JSON.stringify(envelope.frame)}\n`);
  } catch {
    /* not a frame line */
  }
}

/** One connection epoch: SSE down + streaming NDJSON up. Resolves when the
 * downstream ends; live sessions survive into the next epoch. */
async function connectOnce(): Promise<void> {
  const headers = { authorization: `Bearer ${token}` };
  // One signal ties both legs: if the ingest POST fails, the read loop aborts
  // and reconnects, so the companion can't sit half-connected — receiving opens
  // it can't answer while responses pile into a dead upstream.
  const epoch = new AbortController();
  abortEpoch = () => epoch.abort();
  const down = await fetch(`${gatewayUrl}/api/endpoints/${endpointId}/stream`, {
    headers,
    signal: epoch.signal,
  });
  if (down.status !== 200 || !down.body) {
    await down.body?.cancel();
    throw new Error(`stream connect ${down.status}`);
  }

  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      upstream = controller;
    },
  });
  const failUp = (): void => {
    upstream = undefined;
    epoch.abort();
  };
  const up = fetch(`${gatewayUrl}/api/endpoints/${endpointId}/ingest`, {
    method: 'POST',
    headers,
    body,
    duplex: 'half',
    signal: epoch.signal,
  } as RequestInit)
    .then((res) => {
      // A non-2xx (413 overflow, 401, 5xx) means the gateway stopped reading;
      // don't keep streaming into it.
      if (!res.ok) failUp();
    })
    .catch(failUp);
  sendControl(hello());
  while (outbox.length > 0 && upstream) sendLine(outbox.shift()!);
  log(`attached to ${gatewayUrl} as ${endpointId} (${[...agents.keys()].join(', ')})`);

  const reader = down.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data: ')) handleWireLine(line.slice(6));
        nl = buffer.indexOf('\n');
      }
    }
  } finally {
    // Always tear down this epoch's upstream, even on a read error, so the
    // next connectOnce() doesn't leak the prior /ingest POST.
    try {
      upstream?.close();
    } catch {
      /* already closed */
    }
    upstream = undefined;
    abortEpoch = undefined;
    epoch.abort();
    await up;
  }
}

async function main(): Promise<void> {
  let backoff = BACKOFF_MIN_MS;
  for (;;) {
    try {
      await connectOnce();
      backoff = BACKOFF_MIN_MS;
      log('gateway stream ended; reconnecting');
    } catch (error) {
      log(`connect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, backoff));
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
}

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const sessionId of sessions.keys()) {
    const session = sessions.get(sessionId)!;
    sessions.delete(sessionId);
    // Detached agents outlive us, so SIGKILL the group now (grace 0); then
    // reclaim temp homes/workspaces synchronously so credential copies never
    // outlive the process.
    terminateProcessTree(session.child, 0);
    finalizeSession(session);
    sendControl({ kind: 'close', sessionId, reason: 'companion shutdown' });
  }
  // In-flight clones hold a git child and a temp dir, and nothing runs
  // openSession's continuation past the exit below — so reclaim both here.
  // The abort SIGKILLs, so the child cannot write again after it returns.
  for (const [sessionId, slot] of pending) {
    abandonPending(sessionId, slot);
    discard(slot.workspace);
    sendControl({ kind: 'close', sessionId, reason: 'companion shutdown' });
  }
  // Brief grace for the close frames to reach the gateway; its resume window
  // is the backstop if they don't.
  setTimeout(() => process.exit(0), 200);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);

await main();
