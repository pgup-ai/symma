#!/usr/bin/env node
/**
 * Companion: dials OUT to the gateway (no listeners) and bridges local ACP
 * agent binaries — with the machine's own ambient auth — to relayed sessions.
 * Frames pass verbatim; the only local interception is the permission
 * deny-floor, enforced here independently of any client so a remote party can
 * never authorize writes on this machine.
 * Spec: docs/design/m2-acp-gateway.md (M2a).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import {
  claudeAcpSpec,
  claudeConfigPath,
  claudeCredentialsPath,
  codexAcpSpec,
  codexAuthPath,
  createNdjsonReader,
  cursorAcpSpec,
  devinAcpSpec,
  geminiAcpSpec,
  geminiOauthPath,
  devinCredentialsPath,
  generateSigningKeys,
  kiloAcpSpec,
  opencodeAcpSpec,
  opencodeAuthPath,
  parseRelayControl,
  PROTOCOL_VERSION,
  publicKeyFrom,
  respondToPermissionRequest,
  signEnvelope,
  terminateProcessTree,
  type AcpAgentSpec,
  type HelloControl,
  type ObserverEnvelope,
  type OpenControl,
  type RefusalCode,
  type RelayControl,
} from '@symma/protocol';

import { installLoginService } from './login-service.js';
import { fetchWorkspace } from './workspace.js';

const KILL_GRACE_MS = 2_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// Must-deliver buffer while the gateway is away; overflow fails sessions loud.
const MAX_OUTBOX_LINES = 10_000;
/**
 * How long the down leg may say nothing before we treat it as dead. The gateway
 * heartbeats every 25s, so silence past two of them is not a quiet period.
 *
 * Without this a half-open socket is invisible: a slept laptop whose NAT entry
 * expired never sees a FIN, so `reader.read()` stays pending forever and the
 * companion keeps believing it is attached while the gateway has long since
 * dropped it. Tunable because it is really a question about the network in
 * between, not about us.
 */
const STREAM_IDLE_MS =
  Number(process.env.SYMMA_COMPANION_IDLE_MS) > 0
    ? Number(process.env.SYMMA_COMPANION_IDLE_MS)
    : 70_000;
/** How long `pair` waits on the gateway before saying so. */
const PAIR_TIMEOUT_MS =
  Number(process.env.SYMMA_COMPANION_PAIR_TIMEOUT_MS) > 0
    ? Number(process.env.SYMMA_COMPANION_PAIR_TIMEOUT_MS)
    : 15_000;

const log = (msg: string): void => {
  console.log(`[symma-companion] ${msg}`);
};

/** What this machine keeps between runs — the signing key, and since §2 the
 * identity the gateway assigned. Created 0700 alongside the key. */
const stateDir = join(homedir(), '.local', 'share', 'symma-companion');

interface Pairing {
  gateway: string;
  endpoint: string;
  token: string;
  /** The label given while pairing. Here because `hello` carries it: left out,
   * the gateway stores that name and the listing shows a hostname instead. */
  device: string;
}

/** What `symma pair` left behind. Missing is the ordinary unpaired case;
 * a file that yields nothing is said out loud, or a member reads "not paired"
 * with the file sitting right there. */
function readPairing(): Pairing {
  const path = join(stateDir, 'pairing.json');
  const none: Pairing = { gateway: '', endpoint: '', token: '', device: '' };
  if (!existsSync(path)) return none;
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) saved = parsed as Record<string, unknown>;
  } catch (error) {
    log(`ignoring ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return none;
  }
  const str = (key: keyof Pairing): string =>
    typeof saved[key] === 'string' ? saved[key].trim() : '';
  const pairing: Pairing = {
    gateway: str('gateway'),
    endpoint: str('endpoint'),
    token: str('token'),
    device: str('device'),
  };
  // Valid JSON can still be useless — a typo'd key contributes nothing. Only
  // when it contributes *nothing* though: one that supplies some fields and
  // leaves the rest to the environment is in use, not ignored.
  if (!pairing.gateway && !pairing.endpoint && !pairing.token)
    log(`ignoring ${path}: no gateway, endpoint or token in it`);
  return pairing;
}

// Env over file, per field: the file is what pairing wrote, a variable is what
// someone typed on purpose. Trimmed before it decides, or a stray space in a
// variable both wins and comes to nothing, and a real pairing reads as absent.
const paired = readPairing();
const pick = (name: string, saved: string): string => (process.env[name] ?? '').trim() || saved;
const gatewayUrl = pick('SYMMA_COMPANION_GATEWAY', paired.gateway).replace(/\/+$/, '');
const token = pick('SYMMA_COMPANION_TOKEN', paired.token);
const endpointId = pick('SYMMA_COMPANION_ENDPOINT', paired.endpoint);
const device = pick('SYMMA_COMPANION_DEVICE', paired.device) || hostname();
// Resolving an absent agent costs a skip reason, and §2 shows those reasons
// while pairing — so the default is everything we know how to run.
const agentNames = (
  process.env.SYMMA_COMPANION_AGENTS ?? 'kilo,codex,devin,cursor,claude,gemini,opencode'
)
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
/**
 * §4's allowlist: the roots this machine's owner will let an agent run in,
 * configured here and nowhere else. Keyed by the opaque id that crosses the
 * wire, derived from the resolved path so it survives a restart — a
 * conversation that pinned one yesterday still names that directory today.
 */
const workspaces = new Map<string, { id: string; label: string; path: string }>();
for (const entry of (process.env.SYMMA_COMPANION_WORKSPACES ?? '')
  .split(',')
  .map((raw) => raw.trim())
  .filter(Boolean)) {
  const path = resolve(entry);
  // Skipped with a reason rather than fatal, the same way an absent agent is:
  // one bad line in a config must not stop the machine answering at all. That
  // has to hold for every way a stat can fail — `throwIfNoEntry` covers the
  // path that is not there, and the catch covers the one this user cannot
  // reach, which would otherwise throw at module scope and never boot.
  let why: string | undefined;
  try {
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) why = 'not a directory';
  } catch (error) {
    why = error instanceof Error ? error.message : String(error);
  }
  if (why) {
    log(`skipping workspace ${entry}: ${why}`);
    continue;
  }
  const id = createHash('sha256').update(path).digest('hex').slice(0, 12);
  workspaces.set(id, { id, label: basename(path), path });
}

const maxSessions =
  Number(process.env.SYMMA_COMPANION_MAX_SESSIONS) > 0
    ? Number(process.env.SYMMA_COMPANION_MAX_SESSIONS)
    : 2;

/**
 * Signing key for this machine, generated once and kept at 0600. The private
 * half never leaves here: signing at the companion is what makes the journal
 * tamper-evident against the relay rather than merely by it.
 */
function loadSigningKeys(): { privateKey: string; publicKey: string } {
  const path = join(stateDir, 'signing-key.pem');
  // The public half sits beside it as a file the operator can copy off this
  // machine: a journal audit that distrusts the gateway needs a key that never
  // came from the gateway, and this is that channel.
  const publish = (publicKey: string): void =>
    writeFileSync(join(stateDir, 'signing-key.pub.pem'), publicKey, { mode: 0o644 });
  if (existsSync(path)) {
    const privateKey = readFileSync(path, 'utf8');
    const publicKey = publicKeyFrom(privateKey);
    publish(publicKey);
    return { privateKey, publicKey };
  }
  const keys = generateSigningKeys();
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
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

// `symma pair <CODE>` trades a code for this machine's identity and exits. With
// no command the companion attaches using whatever it already has.
const [command, argument] = process.argv.slice(2);
if (command !== undefined && command !== 'pair') {
  console.error(`Unknown command: ${command}. Usage: symma [pair <CODE>]`);
  process.exit(1);
}
const pairing = command === 'pair';
// Trimmed: a pasted code often brings a newline with it.
const pairCode = (argument ?? '').trim();
if (pairing && !pairCode) {
  console.error('Usage: symma pair <CODE>');
  process.exit(1);
}

if (!pairing && (!gatewayUrl || !token || !endpointId)) {
  console.error(
    'Not paired. Run `symma pair <CODE>`, or set SYMMA_COMPANION_GATEWAY, ' +
      'SYMMA_COMPANION_TOKEN and SYMMA_COMPANION_ENDPOINT.',
  );
  process.exit(1);
}

// Deferred for the same reason the config guard sits above it: `pair` signs
// nothing, and a refused pair should leave no key material behind either.
let keys: { privateKey: string; publicKey: string } | undefined;
const signingKeys = (): { privateKey: string; publicKey: string } => (keys ??= loadSigningKeys());

/**
 * Absolute path for a command, or undefined. Agent specs name bare binaries
 * (`kilo`, `codex-acp`), which resolve fine from a terminal and not at all from
 * a login service: launchd hands an agent a minimal PATH, so anything under
 * nvm, `/opt/homebrew/bin` or `~/.local/bin` is simply absent. The login-shell
 * fallback is how those get found — it is where the user's PATH is actually
 * written — and it costs a subprocess, so it only runs when the cheap lookup
 * has already failed.
 */
function resolveBin(bin: string): string | undefined {
  const runnable = (path: string): boolean => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (bin.includes('/')) return runnable(bin) ? bin : undefined;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir && runnable(join(dir, bin))) return join(dir, bin);
  }
  const shell = process.env.SHELL;
  if (!shell) return undefined;
  // Interactive as well as login: nvm and friends are sourced from .zshrc, not
  // .zprofile. The name travels as an argument, never interpolated into the
  // script, so a custom agent entry cannot smuggle shell syntax in here.
  const found = spawnSync(shell, ['-lic', 'command -v -- "$1"', shell, bin], {
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const path = found.stdout?.trim().split('\n').pop()?.trim();
  return path && path.startsWith('/') && runnable(path) ? path : undefined;
}

/** A credential's contents, or undefined unless it is a readable, non-blank
 * regular file. Leftovers fail detection, not the machine: a directory where
 * kilo's auth goes crashed the start, and a blank codex auth.json advertised
 * an agent whose every session then failed at setup. */
function credential(path: string): string | undefined {
  try {
    const text = statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined;
    return text?.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

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
      const auth = credential(path);
      if (!auth) return `kilo: no auth at ${path} (run kilo login)`;
      return { name: entry, spec: kiloAcpSpec(auth.trim()) };
    }
    case 'codex': {
      const home = join(homedir(), '.codex');
      if (!credential(codexAuthPath(home))) return `codex: no auth at ${codexAuthPath(home)}`;
      return { name: entry, spec: codexAcpSpec(home, join(stateDir, 'codex')) };
    }
    case 'devin': {
      if (!credential(devinCredentialsPath(homedir())))
        return `devin: no credentials at ${devinCredentialsPath(homedir())}`;
      return { name: entry, spec: devinAcpSpec() };
    }
    case 'cursor': {
      const key = (process.env.CURSOR_API_KEY ?? '').trim();
      if (!key) return 'cursor: CURSOR_API_KEY not set';
      return { name: entry, spec: cursorAcpSpec(key) };
    }
    case 'claude': {
      // Keychain on macOS, credentials file on Linux, API key anywhere: any of
      // the three is a login. The config's oauthAccount is how the Keychain
      // case shows up on disk.
      const loggedIn =
        credential(claudeCredentialsPath(homedir())) !== undefined ||
        (credential(claudeConfigPath(homedir()))?.includes('"oauthAccount"') ?? false) ||
        Boolean((process.env.ANTHROPIC_API_KEY ?? '').trim());
      if (!loggedIn) return 'claude: not logged in (run `claude /login`)';
      const spec = claudeAcpSpec();
      // The bin is Zed's adapter, not `claude` itself — a member who has
      // logged in has still probably never installed it, so the generic
      // not-on-PATH line would name a binary they never chose.
      if (!resolveBin(spec.bin))
        return 'claude: adapter missing (npm i -g @agentclientprotocol/claude-agent-acp)';
      return { name: entry, spec };
    }
    case 'gemini': {
      if (!credential(geminiOauthPath(homedir())))
        return `gemini: not logged in at ${geminiOauthPath(homedir())} (run gemini)`;
      return { name: entry, spec: geminiAcpSpec() };
    }
    case 'opencode': {
      const dataHome =
        (process.env.XDG_DATA_HOME ?? '').trim() || join(homedir(), '.local', 'share');
      const auth = credential(opencodeAuthPath(dataHome));
      if (!auth)
        return `opencode: no auth at ${opencodeAuthPath(dataHome)} (run opencode auth login)`;
      return { name: entry, spec: opencodeAcpSpec(auth) };
    }
    default:
      return `unknown agent: ${entry}`;
  }
}

const agents = new Map<string, AcpAgentSpec>();
// Kept rather than logged in place: §2 shows these to the member while pairing,
// where they are the onboarding copy and not a diagnostic.
const skipped: string[] = [];
for (const entry of agentNames) {
  const resolved = resolveAgent(entry);
  if (typeof resolved === 'string') {
    skipped.push(resolved);
    continue;
  }
  // Credentials were checked above; the binary was not. Detecting on auth alone
  // reports an agent as ready and then fails at spawn time, which is the worst
  // shape available — it passes onboarding and breaks on first use.
  const bin = resolveBin(resolved.spec.bin);
  if (!bin) {
    skipped.push(`${resolved.name}: ${resolved.spec.bin} not found on PATH`);
    continue;
  }
  agents.set(resolved.name, { ...resolved.spec, bin });
}
if (agents.size === 0) {
  console.error(
    pairing
      ? 'Nothing to connect: no agent on this machine is logged in.'
      : 'No usable agents; check SYMMA_COMPANION_AGENTS and local auth.',
  );
  for (const why of skipped) console.error(`  ${why}`);
  process.exit(1);
}
// Only once the start is going ahead — the refusal above already said them, and
// `pair` prints them as copy rather than as a log line.
if (!pairing) for (const why of skipped) log(`skipping agent — ${why}`);

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
/** Whether this epoch got as far as attaching. main() resets backoff on it
 * rather than on a clean stream end: a connection that attached and later went
 * quiet leaves through the error path, and compounding its delay would make
 * every laptop that sleeps twice slower to come back the third time. */
let attached = false;
/** The gateway refused this build's protocol generation. Nothing this process
 * does will fix that, so it is the one failure that reconnects at the slowest
 * rate rather than the fastest. */
let outdated = false;
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
    version: PROTOCOL_VERSION,
    // Advertising nothing is the ordinary case, and the one every session has
    // had until now.
    ...(workspaces.size > 0
      ? { workspaces: [...workspaces.values()].map(({ id, label }) => ({ id, label })) }
      : {}),
    // Live agents this process still holds — a fresh start sends none, so the
    // relay fails any stale sessions instead of leaving them as zombies. Opens
    // still cloning count: they have no agent yet, but the relay holds them and
    // would otherwise fail them for a blip the clone simply outlasted.
    // Abandoned ones are already out of `pending`, so they stay undeclared.
    sessions: [...sessions.keys(), ...pending.keys()],
    publicKey: signingKeys().publicKey,
  };
}

/**
 * Every directory this process made for a session, and the only thing `discard`
 * will remove. Once an allowlisted root can be a session's cwd, that `rmSync`
 * would delete the source the member asked about — and it is reached from seven
 * places, so a flag at each is one forgotten argument away from doing it.
 */
const madeHere = new Set<string>();

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'symma-companion-'));
  madeHere.add(dir);
  return dir;
}

/** Reclaim a session's temp state. Never throws: a cleanup failure must not
 * abort a shutdown loop, an exit handler, or a refusal path. */
function discard(workspace: string, cleanup?: () => void): void {
  try {
    cleanup?.();
  } catch {
    /* best effort */
  }
  // Above this on purpose: cleanup reclaims the agent's temp home, which exists
  // whether or not the directory below is ours.
  if (!madeHere.delete(workspace)) return;
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
  // The relay forwards this ack verbatim, so a code set here is the one the
  // client sees. Setup and spawn failures below carry none: they are this
  // machine's problem and no code in the set describes them.
  const refuse = (reason: string, code?: RefusalCode): void => {
    sendControl({ kind: 'refused', sessionId: control.sessionId, reason, ...(code && { code }) });
    log(`refused ${control.sessionId}: ${reason}`);
  };
  if (sessions.size + pending.size >= maxSessions) return refuse('at capacity', 'at_capacity');
  if (sessions.has(control.sessionId) || pending.has(control.sessionId))
    return refuse('session id in use', 'session_in_use');
  const spec = agents.get(control.agent);
  if (!spec) return refuse(`agent ${control.agent} not offered`, 'no_such_agent');

  // §4: only a name this endpoint advertised, and a miss is refused rather than
  // resolved — the allowlist is the boundary, so there is nothing to fall back
  // to. The agent runs in the member's own source from here, which is what
  // makes the read-only floor below load-bearing rather than theoretical.
  const chosen = control.workspace ? workspaces.get(control.workspace) : undefined;
  if (control.workspace && !chosen)
    return refuse(`workspace ${control.workspace} not offered`, 'no_such_workspace');
  // Cloning a review checkout on top of someone's working tree is not what
  // either caller meant, and the loser would be their uncommitted work.
  if (chosen && control.repo) return refuse('a workspace and a repo cannot both be given');

  const model = control.model ?? 'default';
  const workspace = chosen ? chosen.path : tempWorkspace();
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
  for (const key of Object.keys(env)) if (key.startsWith('SYMMA_COMPANION_')) delete env[key];

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
    sendLine(JSON.stringify(signEnvelope(envelope, signingKeys().privateKey)));
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
    // Only a checkout we made. An allowlisted root is the member's own path,
    // and §4 keeps those off the wire — the caller already knows the id it
    // named, and the agent's cwd is that directory, so the `.` the client
    // falls back to resolves there anyway.
    ...(chosen ? {} : { workspace }),
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
      if (res.status === 426) {
        outdated = true;
        log("gateway does not serve this build's protocol version; upgrade: npm i -g symma");
      }
      // A non-2xx (413 overflow, 401, 5xx) means the gateway stopped reading;
      // don't keep streaming into it.
      if (!res.ok) failUp();
    })
    .catch(failUp);
  sendControl(hello());
  while (outbox.length > 0 && upstream) sendLine(outbox.shift()!);
  attached = true;
  log(`attached to ${gatewayUrl} as ${endpointId} (${[...agents.keys()].join(', ')})`);

  const reader = down.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // Heartbeats count as traffic, so any read rearms this; only real silence
  // fires it. Aborting the epoch is what `done`/`break` cannot do here — the
  // read never resolves on a half-open socket — and it lands in the same
  // teardown the clean path uses, so main()'s loop reconnects with backoff.
  let idle: ReturnType<typeof setTimeout> | undefined;
  const rearm = (): void => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      log(`no traffic from the gateway in ${STREAM_IDLE_MS}ms; reconnecting`);
      epoch.abort();
    }, STREAM_IDLE_MS);
    idle.unref?.();
  };
  try {
    rearm();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rearm();
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
    clearTimeout(idle);
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
    attached = false;
    outdated = false;
    try {
      await connectOnce();
      log('gateway stream ended; reconnecting');
    } catch (error) {
      log(`connect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (outdated) backoff = BACKOFF_MAX_MS;
    else if (attached) backoff = BACKOFF_MIN_MS;
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
  // Last, after the closes: this is what lets a member be told "quit on your
  // Mac" instead of "asleep". A kill or a lid never reaches here, and that
  // asymmetry is the signal — the relay falls back to the last-seen timestamp.
  sendControl({ kind: 'goodbye' });
  // Brief grace for those frames to reach the gateway; its resume window is the
  // backstop if they don't.
  setTimeout(() => process.exit(0), 200);
}

/** Replaces, where the signing key must never be replaced — so rename rather
 * than link, still through a staged file so a reader never sees half of one. */
function savePairing(saved: Pairing): string {
  const path = join(stateDir, 'pairing.json');
  const staged = `${path}.${process.pid}`;
  try {
    writeFileSync(staged, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    renameSync(staged, path);
  } finally {
    // A staged file that outlived a failure is a token sitting under a name
    // nothing will ever read. Gone on the way out either way; after a rename
    // there is nothing left to remove.
    rmSync(staged, { force: true });
  }
  return path;
}

/** §2's exchange: what this machine can run, traded for the identity it will
 * present. The endpoint id comes back from the gateway rather than going up —
 * an unauthenticated caller naming an identity is one code away from someone
 * else's endpoint. */
async function runPair(code: string): Promise<never> {
  // A default is the point: without one the §2 one-liner needs a second field.
  const pairTarget = gatewayUrl || 'https://symma.dev';
  const running = [...agents.keys()];
  const refused = (why: string): never => {
    console.error(why);
    process.exit(1);
  };
  const because = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  // Before the code is spent: a home that cannot be written to should stop this
  // now rather than after the gateway has consumed a one-time code.
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return refused(`Cannot write to ${stateDir}: ${because(error)}`);
  }
  let status: number;
  let body: { error?: string; endpoint?: string; token?: string };
  try {
    const res = await fetch(`${pairTarget}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, device, agents: running }),
      // Covers the body as well as the headers, so a gateway that accepts and
      // then says nothing ends as a message rather than a command that hangs.
      signal: AbortSignal.timeout(PAIR_TIMEOUT_MS),
    });
    status = res.status;
    // Read then parse: a proxy's HTML error page is a real answer to report by
    // status, where a connection that died mid-body is not.
    const text = await res.text();
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      body = {};
    }
  } catch (error) {
    return refused(`Could not reach ${pairTarget}: ${because(error)}`);
  }
  if (status === 401) return refused('That code has expired or been used — ask for a new one.');
  if (status === 429) return refused('Too many attempts just now. Wait a minute and retry.');
  if (status !== 200 || !body.endpoint || !body.token)
    return refused(
      `Pairing failed (${status}${body.error ? `: ${body.error}` : ''}) at ${pairTarget}.`,
    );

  let path: string;
  try {
    path = savePairing({
      gateway: pairTarget,
      endpoint: body.endpoint,
      token: body.token,
      device,
    });
  } catch (error) {
    // The code is gone whatever happens here, so say that rather than let a
    // stack trace stand in for it — §2's failure modes want words.
    return refused(
      `Paired, but could not save it to ${stateDir}: ${because(error)}. ` +
        'That code is spent now — ask for another.',
    );
  }
  // Detection output is the onboarding copy (§2).
  console.log(`✅ Connected — ${device} · ${running.join(', ')}`);
  for (const why of skipped) console.log(`⚪ ${why}`);
  console.log(`Saved to ${path}. Run \`symma\` to stay connected.`);
  // §2 step 4: pairing installs the login service. Written, not started —
  // bootstrapping a service is a persistent change to someone's machine, and
  // the installer that ran this command is what does that unattended.
  for (const line of installLoginService(process.platform, homedir(), [
    process.execPath,
    ...process.execArgv,
    process.argv[1] ?? '',
  ])) {
    console.log(line);
  }
  process.exit(0); // fetch's keep-alive socket would hold a finished command open
}

if (pairing) {
  await runPair(pairCode);
} else {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
  await main();
}
