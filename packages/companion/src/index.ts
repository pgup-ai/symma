#!/usr/bin/env node
/**
 * Companion: dials OUT to the gateway (no listeners) and bridges local ACP
 * agent binaries — with the machine's own ambient auth — to relayed sessions.
 * Frames pass verbatim; the only local interception is the permission floor,
 * enforced here independently of any client: outside an allowlisted workspace
 * a remote party can never authorize writes on this machine, and inside one
 * writes happen only under a session mode the owner chose — never granted
 * from inside a session (§4).
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
  isWriteCapableMode,
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
  answerPermission,
  PERMISSION_ANSWERED,
  signEnvelope,
  terminateProcessTree,
  type AcpAgentSpec,
  type HelloControl,
  type ObserverEnvelope,
  type OpenControl,
  type RefusalCode,
  type RelayControl,
} from '@symma/protocol';

import { installLoginService, loginService, type LoginService } from './login-service.js';
import { fetchWorkspace } from './workspace.js';

/** So a code from Slack is the whole of what a member types. A name we own
 * rather than a host we rent, because this ships inside every installed copy:
 * moving providers has to be a DNS change, not a reinstall for everyone who
 * already paired. `SYMMA_COMPANION_GATEWAY` overrides it. */
const DEFAULT_GATEWAY = 'https://gateway.symma.dev';

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
const gatewayUrl = (pick('SYMMA_COMPANION_GATEWAY', paired.gateway) || DEFAULT_GATEWAY).replace(
  /\/+$/,
  '',
);
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
 * §4's allowlist: the roots this machine's owner will let an agent run in.
 * The variable is how it is authored; what it names is copied to the state
 * dir, because the login service starts the companion with no environment at
 * all — without the copy, the first reboot silently unlists every root. Env
 * over file, the precedence pairing already takes. Keyed by the opaque id
 * that crosses the wire, derived from the resolved path so it survives a
 * restart — a conversation that pinned one yesterday still names that
 * directory today.
 */
const workspacesPath = join(stateDir, 'workspaces.json');

/** A copy that cannot be parsed is set aside as `.bad` rather than merely
 * ignored: an env-free boot cannot rebuild it, so leaving it in place is the
 * same silent zero-root boot on every reboot — the rename makes the state
 * visible on disk and stops the log repeating. Renamed only while the file
 * still holds the bytes that failed to parse: state dirs are shared between
 * concurrent starts (see `sweepStaging`), and another one may have just
 * rewritten it valid. A rename that failed is said, not claimed — the on-disk
 * state has to match what the operator is told. Never thrown, which at module
 * scope would be a companion that cannot boot past its own config. */
function quarantineWorkspaces(raw: string, why: string): string[] {
  try {
    if (readFileSync(workspacesPath, 'utf8') === raw) {
      renameSync(workspacesPath, `${workspacesPath}.bad`);
      log(
        `set aside ${workspacesPath} (${why}); start with SYMMA_COMPANION_WORKSPACES to rebuild it`,
      );
    }
  } catch (error) {
    log(
      `cannot set aside ${workspacesPath} (${why}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return [];
}

/** What a previous start persisted. */
function savedWorkspaceEntries(): string[] {
  if (!existsSync(workspacesPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(workspacesPath, 'utf8');
  } catch (error) {
    // Unreadable at the filesystem level: nothing to compare, and a rename
    // would fail the same way.
    log(`ignoring ${workspacesPath}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  try {
    const entries = (JSON.parse(raw) as { workspaces?: unknown }).workspaces;
    if (Array.isArray(entries) && entries.every((entry) => typeof entry === 'string'))
      return entries as string[];
  } catch (error) {
    return quarantineWorkspaces(raw, error instanceof Error ? error.message : String(error));
  }
  return quarantineWorkspaces(raw, 'no workspaces array in it');
}

// Presence decides, not blankness — a divergence from pairing's pick() on
// purpose: an allowlist's explicit empty is a revocation to honor and to
// persist, where a credential's empty is only ever noise. Entries resolve at
// authoring time, when the shell's cwd is the one a relative entry meant; the
// login service would resolve it against `/`.
const workspacesVar = process.env.SYMMA_COMPANION_WORKSPACES;
const envWorkspaceEntries = (workspacesVar ?? '')
  .split(',')
  .map((raw) => raw.trim())
  .filter(Boolean)
  .map((entry) => resolve(entry));
if (workspacesVar !== undefined) {
  // Persisted before validation, not after: the entries are the member's
  // intent, and a root unmounted at this boot must come back at the next one
  // rather than vanish from the copy. Compared first so the steady state
  // writes nothing.
  const contents = `${JSON.stringify({ workspaces: envWorkspaceEntries }, null, 2)}\n`;
  try {
    if (!existsSync(workspacesPath) || readFileSync(workspacesPath, 'utf8') !== contents) {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      saveState(workspacesPath, contents);
    }
  } catch (error) {
    // The allowlist still works from the variable this run; only the copy
    // that would survive a reboot could not be written.
    log(`could not persist workspaces: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const workspaces = new Map<string, { id: string; label: string; path: string }>();
for (const path of workspacesVar !== undefined ? envWorkspaceEntries : savedWorkspaceEntries()) {
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
    log(`skipping workspace ${path}: ${why}`);
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
const COMMANDS = ['pair', 'install', 'uninstall', 'status'];
if (command !== undefined && !COMMANDS.includes(command)) {
  console.error(
    `Unknown command: ${command}. Usage: symma [pair <CODE> | install | uninstall | status]`,
  );
  process.exit(1);
}
const pairing = command === 'pair';

/** `argv[1]` rather than a fixed path, so a global install and a checkout each
 * supervise themselves. */
const thisService = (): ReturnType<typeof loginService> =>
  loginService(
    process.platform,
    homedir(),
    [process.execPath, ...process.execArgv, process.argv[1] ?? ''],
    process.getuid?.() ?? 0,
  );

const because = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Loaded is not running: launchd keeps a job that exited and still answers
 * for it, so the exit code alone would report a crash-looping companion as
 * healthy. */
const running = (service: LoginService): boolean => {
  const asked = control(service.probe);
  return asked.ok && service.isRunning(asked.said);
};

const control = (argv: string[]): { ok: boolean; said: string } => {
  const [bin, ...rest] = argv;
  const done = spawnSync(bin!, rest, { encoding: 'utf8' });
  return {
    ok: done.status === 0,
    said: `${done.stderr ?? ''}${done.stdout ?? ''}`.trim() || String(done.error ?? ''),
  };
};

/** Answered before the gateway, the pairing and the agents are resolved: these
 * two are about this machine's supervisor, and neither should be refusable by a
 * setup it does not use. */
if (command === 'install' || command === 'uninstall') {
  const service = thisService();
  if (!service) {
    console.error(`No login service for ${process.platform}. Run \`symma\` to stay connected.`);
    process.exit(1);
  }
  if (command === 'uninstall') {
    // Asked first, because nothing loaded is the ordinary case: without this
    // every uninstall ends on launchd's "Boot-out failed: 3: No such process",
    // which reads as a problem where there is none. Loaded and still refusing
    // is the real failure, and that one is worth saying.
    const wasLoaded = control(service.probe).ok;
    const refused = service.stop.map(control).filter((step) => !step.ok);
    try {
      rmSync(service.path, { force: true });
    } catch (error) {
      console.error(`Could not remove ${service.path}: ${because(error)}`);
      process.exit(1);
    }
    console.log(`Removed ${service.path}.`);
    if (wasLoaded) for (const step of refused) if (step.said) console.log(`  ${step.said}`);
    process.exit(0);
  }
  // Rewritten every time, never only when absent: a machine that paired before
  // this build has a unit that restarts on a clean exit and captures no output,
  // and starting that one would install this version's bugs rather than fix
  // them. The sequence ends by restarting, so the rewrite is what runs.
  for (const line of installLoginService(
    process.platform,
    homedir(),
    [process.execPath, ...process.execArgv, process.argv[1] ?? ''],
    process.getuid?.() ?? 0,
  )) {
    console.log(line);
  }
  // The install declines rather than throws — an npx cache it would outlive, a
  // home it cannot write — and has already said which it was.
  if (!existsSync(service.path)) process.exit(1);
  const steps = [...service.start];
  const last = steps.pop()!;
  for (const argv of steps) control(argv);
  const started = control(last);
  if (!started.ok) {
    console.error(`Could not start it: ${started.said || 'unknown error'}`);
    process.exit(1);
  }
  console.log(
    `Installed and starting. \`symma status\` to check; output goes to ${service.logPath}.`,
  );
  process.exit(0);
}
// Trimmed: a pasted code often brings a newline with it.
const pairCode = (argument ?? '').trim();
if (pairing && !pairCode) {
  console.error('Usage: symma pair <CODE>');
  process.exit(1);
}

if (command === undefined && (!token || !endpointId)) {
  console.error(
    'Not paired. Run `symma pair <CODE>` with a code from Slack, or set ' +
      'SYMMA_COMPANION_GATEWAY, SYMMA_COMPANION_TOKEN and SYMMA_COMPANION_ENDPOINT.',
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
// `status` survives it: a machine with no agent is exactly the one whose owner
// is asking what is wrong, and the attach path's refusal answers nothing.
if (agents.size === 0 && command !== 'status') {
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
if (command === undefined) for (const why of skipped) log(`skipping agent — ${why}`);

// Answered from this machine alone: asking the gateway would report a companion
// that cannot start as healthy, on the strength of an earlier one that could.
if (command === 'status') {
  const service = thisService();
  const installed = service !== undefined && existsSync(service.path);
  console.log(`Machine   ${device}`);
  console.log(
    token && endpointId
      ? `Paired    ${endpointId} → ${gatewayUrl}`
      : 'Paired    no — run `symma pair <CODE>` with a code from Slack',
  );
  console.log(
    !service
      ? `Service   none for ${process.platform} — run \`symma\` to stay connected`
      : !installed
        ? 'Service   not installed — run `symma install`'
        : running(service)
          ? `Service   running · ${service.logPath}`
          : 'Service   installed but stopped — run `symma install`',
  );
  console.log(
    agents.size
      ? `Agents    ${[...agents.keys()].join(', ')}`
      : 'Agents    none logged in — sign in to codex or claude and run `symma status` again',
  );
  for (const why of skipped) console.log(`          ⚪ ${why}`);
  process.exit(0);
}

interface LiveSession {
  child: ChildProcess;
  runId: string;
  agent: string;
  model?: string;
  seq: number;
  workspace: string;
  /** The owner picked a write-capable mode for this session, so the floor
   * answers `writes` instead of the read-only policy. */
  allowWrites: boolean;
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
    agents: [...agents.entries()].map(([agent, spec]) => ({
      agent,
      ...(spec.modes ? { modes: true } : {}),
    })),
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
  // §4: a write-capable mode only means something inside a root this machine's
  // owner allowlisted at the keyboard; anywhere else it is refused rather than
  // quietly downgraded to a tier the caller was not shown.
  const mode = control.mode;
  if (mode && isWriteCapableMode(mode) && !chosen)
    return refuse(`mode ${mode} requires a named workspace`);

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
    ({ env, cleanup } = spec.env(model, {
      ...(mode ? { mode } : {}),
      workspace: Boolean(chosen),
    }));
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
    // The workspace requirement was enforced above, so a write-capable mode
    // here is one the owner chose for a root they allowlisted.
    allowWrites: Boolean(mode && isWriteCapableMode(mode)),
    cleanup,
  };
  sessions.set(control.sessionId, session);

  /** Signs, sequences and journals every frame shown to the client. */
  const forward = (frame: Record<string, unknown>): void => {
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
  };

  const read = createNdjsonReader((frame) => {
    // The floor: permission requests are answered HERE and never forwarded —
    // a remote client cannot grant anything. The policy is the session's, set
    // once at open from the mode the owner picked.
    if (frame.method === 'session/request_permission' && frame.id !== undefined) {
      const { response, decided } = answerPermission(
        (frame.params ?? {}) as Parameters<typeof answerPermission>[0],
        session.allowWrites ? 'writes' : 'read-only',
      );
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: response })}\n`);
      // The request stays local; only the floor's decision travels.
      if (decided) forward({ jsonrpc: '2.0', method: PERMISSION_ANSWERED, params: decided });
      return;
    }
    // Only the companion may report its floor's decision; an agent frame would
    // spoof the member-facing record.
    if (frame.method === PERMISSION_ANSWERED) {
      log(`${control.sessionId}: agent tried to report a permission decision; dropped`);
      if (frame.id !== undefined)
        child.stdin?.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: -32601, message: `Unsupported method: ${frame.method}` },
          })}\n`,
        );
      return;
    }
    forward(frame);
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
    // Only for a named workspace: a temp-dir session's rollout lands in
    // symma's own run home, where the member's `codex resume` cannot see it.
    ...(chosen && spec.resumeWith ? { resumeWith: spec.resumeWith } : {}),
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
function saveState(path: string, contents: string): void {
  const staged = `${path}.${process.pid}`;
  try {
    writeFileSync(staged, contents, { mode: 0o600 });
    renameSync(staged, path);
  } finally {
    // A staged file that outlived a failure is state sitting under a name
    // nothing will ever read. Gone on the way out either way; after a rename
    // there is nothing left to remove.
    rmSync(staged, { force: true });
  }
}

function savePairing(saved: Pairing): string {
  const path = join(stateDir, 'pairing.json');
  saveState(path, `${JSON.stringify(saved, null, 2)}\n`);
  return path;
}

/** §2's exchange: what this machine can run, traded for the identity it will
 * present. The endpoint id comes back from the gateway rather than going up —
 * an unauthenticated caller naming an identity is one code away from someone
 * else's endpoint. */
async function runPair(code: string): Promise<never> {
  const running = [...agents.keys()];
  const refused = (why: string): never => {
    console.error(why);
    process.exit(1);
  };
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
    const res = await fetch(`${gatewayUrl}/api/pair`, {
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
    return refused(`Could not reach ${gatewayUrl}: ${because(error)}`);
  }
  if (status === 401) return refused('That code has expired or been used — ask for a new one.');
  if (status === 429) return refused('Too many attempts just now. Wait a minute and retry.');
  if (status !== 200 || !body.endpoint || !body.token)
    return refused(
      `Pairing failed (${status}${body.error ? `: ${body.error}` : ''}) at ${gatewayUrl}.`,
    );

  let path: string;
  try {
    path = savePairing({
      gateway: gatewayUrl,
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
  for (const line of installLoginService(
    process.platform,
    homedir(),
    [process.execPath, ...process.execArgv, process.argv[1] ?? ''],
    process.getuid?.() ?? 0,
  )) {
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
