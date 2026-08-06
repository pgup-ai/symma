/**
 * ACP protocol engine: framing, the JSON-RPC peer, session driving, the
 * read-only permission floor, and the per-agent spec table. Deliberately free
 * of review concerns — the companion and gateway depend on this half, and it
 * is what would extract as a standalone package.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { codexEnvForHome, prepareCodexRunHome } from './codex.js';
import { CURSOR_CLI_BIN, cursorEnvForKey } from './cursor.js';
import { buildDevinReadOnlyConfig, DEVIN_CLI_BIN, devinCredentialsPath } from './devin.js';
import {
  KILO_CLI_BIN,
  KILO_GATEWAY_FREE_MODEL,
  KILO_PROVIDER_ID,
  KILO_STRIPPED_ENV_KEYS,
  kiloEnvForAuth,
} from './kilo.js';
import { parseModelName } from './model.js';

const ACP_PROTOCOL_VERSION = 1;
// What the handshake reports as this client. Read from package.json rather
// than duplicated as a constant: a hand-copied version is wrong the first time
// someone forgets it, and the field's whole use is display and debugging.
// Resolves the same from src/ and dist/, and npm ships package.json always.
const { name: CLIENT_NAME, version: CLIENT_VERSION } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };
// One JSON-RPC frame far above any real message; growth past it means a
// runaway child, and the connection fails loud instead of buffering to OOM.
const ACP_MAX_FRAME_BYTES = 32 * 1024 * 1024;
// The trailing-frame race (opencode#17505) is flush-ordering, so late frames
// arrive within an I/O tick; this covers it without paying 750ms per session.
const ACP_POST_TURN_DRAIN_MS = 300;
export const CODEX_ACP_BIN = 'codex-acp';
/** The canonical adapter, not the claude binary: `claude` itself speaks no
 * ACP. Zed's claude-code-acp was renamed to this and deprecated; live-verified
 * 2026-07-29 against @agentclientprotocol/claude-agent-acp 0.63.0 over Claude
 * Code 2.1.193, and it is what the ACP registry distributes. */
export const CLAUDE_ACP_BIN = 'claude-agent-acp';
export const GEMINI_CLI_BIN = 'gemini';
export const OPENCODE_CLI_BIN = 'opencode';

/** Claude Code's OAuth on macOS lives in the Keychain, not a file — the
 * config is what records the logged-in account there (`"oauthAccount"`), while
 * Linux keeps a credentials file. Detection needs both surfaces. */
export const claudeCredentialsPath = (home: string): string =>
  join(home, '.claude', '.credentials.json');
export const claudeConfigPath = (home: string): string => join(home, '.claude.json');
export const geminiOauthPath = (home: string): string => join(home, '.gemini', 'oauth_creds.json');
export const opencodeAuthPath = (dataHome: string): string =>
  join(dataHome, 'opencode', 'auth.json');

/**
 * Byte-exact budget test that skips the UTF-8 scan for all but near-cap
 * frames. UTF-8 never exceeds 3 bytes per UTF-16 code unit (astral chars cost
 * 4 bytes but span a 2-unit surrogate pair), so anything under a third of the
 * budget is provably inside it — and every real frame is. Counting `.length`
 * alone would let multibyte output overrun a cap named in bytes by up to 3x,
 * while `ndjson.ts` measures the same kind of cap exactly.
 */
function exceedsFrameBudget(text: string, maxFrameBytes: number): boolean {
  if (text.length * 3 <= maxFrameBytes) return false;
  return Buffer.byteLength(text) > maxFrameBytes;
}

/**
 * ACP frames are newline-delimited JSON (no Content-Length headers). Tolerates
 * frames split across chunks and skips non-JSON lines — some CLIs print
 * banners on stdout before the protocol stream starts.
 */
export function createNdjsonReader(
  onMessage: (message: Record<string, unknown>) => void,
  maxFrameBytes = ACP_MAX_FRAME_BYTES,
): (chunk: string) => boolean {
  let buffer = '';
  let overflowed = false;
  return (chunk) => {
    if (overflowed) return false;
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      // A newline arriving in the same chunk as an oversized frame would
      // otherwise reach JSON.parse before the post-loop budget check.
      if (exceedsFrameBudget(line, maxFrameBytes)) {
        overflowed = true;
        buffer = '';
        return false;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message && typeof message === 'object') onMessage(message as Record<string, unknown>);
    }
    if (exceedsFrameBudget(buffer, maxFrameBytes)) {
      overflowed = true;
      buffer = '';
      return false;
    }
    return true;
  };
}

export interface PermissionRequestParams {
  toolCall?: { kind?: string; title?: string };
  options?: { optionId?: string; kind?: string }[];
  /** codex-acp 1.1.7 marks MCP tool approvals here (`is_mcp_tool_approval`);
   * their kind is `execute`, so the kind alone cannot tell them apart. */
  _meta?: Record<string, unknown>;
}

/** `read-only` is the review floor. `writes` is a DM turn whose owner picked a
 * write-capable mode inside their own allowlisted workspace — everything is
 * allowed but `switch_mode`, so the mode channel and the prompt channel never
 * mix and a session can never escalate itself. */
export type PermissionPolicy = 'read-only' | 'writes';

export type PermissionResponse = {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
};

// ACP ToolKind maps file mutations to edit/delete/move; `write` is not a spec
// kind but is denied too in case an agent labels nonstandardly. `switch_mode`
// is denied because the caller sets the session mode — approving one would let
// a prompt-injected request escape the plan-mode read-only layer.
const DENIED_TOOL_KINDS = new Set(['edit', 'delete', 'move', 'write', 'switch_mode']);

/**
 * Client-side layer of the read-only floor (AGENTS.md, "Read-only enforced in
 * three layers"): mutating tool kinds are rejected, everything else
 * (read/search/execute/fetch — bash stays allowed for git diff/log/grep) is
 * approved. Deliberately kind-based and allow-by-default for unknown kinds:
 * read tools commonly ship kind `other` or none, so denying unknowns would
 * stall reviews (a recall hole). Command-level policing — bash filtering and
 * the like — belongs to the other two layers, codex's OS sandbox and plan
 * mode. Prefers the `*_once` option so no standing grant outlives a single
 * call. Kind strings normalize `-` to `_` (cursor emits hyphens). No usable
 * option ⇒ cancelled outcome.
 */
export function respondToPermissionRequest(
  params: PermissionRequestParams,
  policy: PermissionPolicy = 'read-only',
): PermissionResponse {
  const kind = normalizeKind(params.toolCall?.kind);
  // MCP servers are the agent's own subprocesses, outside its OS sandbox and
  // this floor's kind vocabulary — read-only must catch them by the meta flag.
  const mcp = params._meta?.is_mcp_tool_approval === true;
  const denied =
    policy === 'writes' ? kind === 'switch_mode' : DENIED_TOOL_KINDS.has(kind) || mcp;
  const direction = denied ? 'reject' : 'allow';
  const options = params.options ?? [];
  const pick =
    options.find((option) => normalizeKind(option.kind) === `${direction}_once`) ??
    options.find((option) => normalizeKind(option.kind).startsWith(direction));
  return pick?.optionId
    ? { outcome: { outcome: 'selected', optionId: pick.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

function normalizeKind(kind: string | undefined): string {
  return (kind ?? '').replaceAll('-', '_');
}

interface JsonRpcMessage extends Record<string, unknown> {
  id?: unknown;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface AcpSessionIo {
  input: Writable;
  output: Readable;
}

/** Minimal JSON-RPC 2.0 peer over stdio streams: client requests/notifies,
 * plus dispatch for agent-initiated requests and notifications. */
class AcpConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly io: AcpSessionIo,
    private readonly onNotification: (method: string, params: Record<string, unknown>) => void,
    private readonly onRequest: (method: string, params: Record<string, unknown>) => unknown,
    private readonly tee?: (dir: 'out' | 'in', frame: Record<string, unknown>) => void,
  ) {
    const read = createNdjsonReader((message) => {
      this.tee?.('in', message);
      this.dispatch(message);
    });
    io.output.setEncoding('utf8');
    io.output.on('data', (chunk: string | Buffer) => {
      if (!read(String(chunk))) {
        this.failAllPending(
          new Error('agent stdout exceeded the 32MB frame budget without a newline'),
        );
      }
    });
    // A closed transport can never answer, so pending requests fail here
    // rather than waiting out the caller's deadline — and a consumer that
    // sets no deadline gets a rejection instead of a hang. `error` also needs
    // a listener in its own right: unhandled, it would take down the process.
    // These fire BEFORE a child process's own 'close', so a caller racing an
    // exit handler to attach stderr should expect this terser error to win;
    // the guarantee here is a rejection, not the most descriptive one.
    io.output.on('end', () => this.failAllPending(new Error('agent stdout ended mid-request')));
    io.output.on('close', () => this.failAllPending(new Error('agent stdout closed mid-request')));
    io.output.on('error', (error: Error) =>
      this.failAllPending(new Error(`agent stdout failed mid-request: ${error.message}`)),
    );
  }

  private failAllPending(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    // An unwritable stdin drops the frame, so nothing will ever answer this
    // id; reject now instead of leaving the entry pending forever.
    if (!this.write({ jsonrpc: '2.0', id, method, params })) {
      const entry = this.pending.get(id);
      this.pending.delete(id);
      entry?.reject(new Error(`agent stdin is not writable; ${method} was not sent`));
    }
    return promise;
  }

  /** Returns whether the frame reached the stream. Responses to agent-initiated
   * requests ignore this — a dead stdin has no one left to inform. */
  private write(message: Record<string, unknown>): boolean {
    if (!this.io.input.writable) return false;
    this.io.input.write(`${JSON.stringify(message)}\n`);
    this.tee?.('out', message);
    return true;
  }

  private dispatch(message: JsonRpcMessage): void {
    if (message.id !== undefined && ('result' in message || 'error' in message)) {
      const entry = this.pending.get(message.id as number);
      if (!entry) return;
      this.pending.delete(message.id as number);
      if (message.error) {
        // Agents put the actionable cause in error.data (e.g. cline's
        // "requires re-authentication"), not in the generic message.
        const data =
          message.error.data === undefined ? '' : ` ${JSON.stringify(message.error.data)}`;
        const error = new Error(
          `agent error ${message.error.code ?? ''}: ${message.error.message ?? ''}${data}`,
        ) as Error & { code?: number };
        error.code = message.error.code;
        entry.reject(error);
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== 'string') return;
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (message.id !== undefined) {
      try {
        this.write({
          jsonrpc: '2.0',
          id: message.id,
          result: this.onRequest(message.method, params),
        });
      } catch {
        this.write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Unsupported method: ${message.method}` },
        });
      }
      return;
    }
    this.onNotification(message.method, params);
  }
}

export interface AcpSessionOptions {
  cwd: string;
  prompt: string;
  agent: string;
  label: string;
  log: (msg: string) => void;
  /** Model string (`<provider>/<id>`), passed through to `tee`. */
  model?: string;
  /** Ordered candidates to select via the agent's ACP model config option
   * (agents whose spec sets modelConfigCandidates — CLI flags/env don't reach
   * their sessions). First candidate that matches an offered value wins. */
  configOptionModelIds?: string[];
  /** Fail closed when plan mode is missing or cannot be set (agents with no
   * agent-side sandbox — plan mode is their behavioral read-only layer). */
  requirePlanMode?: boolean;
  /** Session mode to run under, one of the agent's `availableModes`. Fails the
   * turn when not offered — no silent downgrade in either direction. Absent
   * keeps the review path's behavior: plan mode forced when offered. */
  mode?: string;
  /** Reattach to this session rather than opening one, for agents that
   * advertise `loadSession`. Fails open: a resume that cannot happen costs the
   * caller its history, and must not also cost it the turn. */
  resume?: string;
  /** Sent ahead of the prompt when — and only when — the session is a new one.
   * The caller cannot know whether its `resume` landed until the load has been
   * tried, so it hands over what a fresh session would need and this drops it
   * where it would be a second copy of what the agent already remembers. */
  context?: string;
  /** Observe every frame in both directions. The caller decides whether one
   * exists: a relayed session is already journaled by the companion — signed
   * and endpoint-attributed — so it passes none rather than posting the same
   * frames a second time, unsigned, under a different id. */
  tee?: (dir: 'out' | 'in', frame: Record<string, unknown>) => void;
}

export interface ModelOptionCandidate {
  value?: string;
  name?: string;
  /** Present on SessionConfigSelectGroup entries (grouped option lists). */
  options?: ModelOptionCandidate[];
}

/** Resolves a caller's model id against a model config option's choices: exact
 * value, then display name (case-insensitive), then dotted→hyphenated value
 * (`glm-5.2` ⇒ devin's `glm-5-2`). Grouped option lists (spec: entries with a
 * nested `options` array under a group header) are flattened first — a
 * group's `name` is a header, never a model. */
export function matchModelOptionValue(
  options: ModelOptionCandidate[],
  modelID: string,
): string | undefined {
  const flat = options.flatMap((option) =>
    Array.isArray(option.options) ? option.options : [option],
  );
  const lower = modelID.toLowerCase();
  const match =
    flat.find((option) => option.value === modelID) ??
    flat.find((option) => option.name?.toLowerCase() === lower) ??
    flat.find((option) => option.value === modelID.replaceAll('.', '-'));
  return match?.value;
}

export interface SessionMode {
  id: string;
  name?: string;
  description?: string;
}

/** An agent's mode surface as `session/new`/`session/load` returned it, with
 * `currentModeId` reflecting the caller's mode when one was set. */
export interface SessionModes {
  currentModeId?: string;
  availableModes: SessionMode[];
}

export interface AcpSessionResult {
  text: string;
  stopReason: string;
  /** The session this turn ran in — `resume` when it was honoured, the new one
   * when it was not. Compare the two to tell which happened; store it to
   * resume next time. */
  sessionId: string;
  /** Assistant text the agent did not label with a `messageId`, in a session
   * where it labelled everything else — an adapter with no channel of its own
   * putting an operational notice in the message stream. codex-acp turns
   * codex's `warning` and `configWarning` events into exactly this. */
  notices: string[];
  /** Present when the agent served a mode roster — what a caller's member can
   * pick from next turn. */
  modes?: SessionModes;
}

/**
 * Drives one review prompt over an ACP stdio pair: initialize → session/new →
 * plan mode when offered → session/prompt, answering permission requests with
 * the read-only policy. The returned text is the LAST assistant-message
 * segment — a new messageId (or, for agents that omit ids, a tool_call after
 * text) starts a new segment — mirroring the "final message" semantics every
 * other backend's parser expects.
 */
export async function driveAcpSession(
  io: AcpSessionIo,
  options: AcpSessionOptions,
): Promise<AcpSessionResult> {
  const { agent, label, log } = options;
  // Kept with the id they arrived under, because whether an unlabelled one is a
  // notice depends on whether the session ever labels anything — and a
  // `tool_call` can flush one before the first labelled chunk says so.
  const segments: { id: unknown; text: string }[] = [];
  let current = '';
  let lastMessageId: unknown;
  let seenChunk = false;
  let usesMessageIds = false;
  const flush = () => {
    if (current.trim()) segments.push({ id: lastMessageId, text: current });
    current = '';
  };

  const conn = new AcpConnection(
    io,
    (method, params) => {
      if (method !== 'session/update') return;
      const update = (params.update ?? {}) as Record<string, unknown>;
      const kind = update.sessionUpdate;
      if (kind === 'agent_message_chunk') {
        const messageId = update.messageId;
        if (messageId !== undefined) usesMessageIds = true;
        // `undefined` is an id like any other, so a chunk the agent did not
        // label starts its own segment rather than joining the answer. Agents
        // that label nothing see no change: their id never varies.
        if (seenChunk && messageId !== lastMessageId) flush();
        seenChunk = true;
        lastMessageId = messageId;
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === 'text' && typeof content.text === 'string') current += content.text;
      } else if ((kind === 'tool_call' || kind === 'tool_call_update') && !usesMessageIds) {
        flush();
      }
    },
    (method, params) => {
      if (method === 'session/request_permission') {
        const response = respondToPermissionRequest(params as PermissionRequestParams);
        if (response.outcome.outcome !== 'selected') {
          log(`acp:${agent} ${label}: permission request had no usable option; cancelled`);
        }
        return response;
      }
      throw new Error(`unsupported agent request: ${method}`);
    },
    options.tee,
  );

  const init = (await conn.request('initialize', {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      // Advertised so conforming agents include configOptions in session/new —
      // the model-selection surface (devin serves it either way; spec-gated
      // agents may not).
      session: { configOptions: {} },
    },
    // ACP `name` is for programmatic use, so agents may branch on it — naming
    // one consumer would put that branch on every other one. A caller needing
    // its own identity gets an option when it exists, not a default nobody sets.
    clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
  })) as Record<string, unknown>;
  const newSession = () =>
    conn.request('session/new', { cwd: options.cwd, mcpServers: [] }) as Promise<
      Record<string, unknown>
    >;
  /**
   * Spec flow for auth-gated agents (error -32000): authenticate with an
   * advertised method, retry once. Never called pre-emptively — advertised
   * methods are often interactive logins, and agents with ambient credentials
   * (cursor/devin, live-verified) don't gate a session at all.
   */
  const withAuth = async (what: string, call: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await call();
    } catch (error) {
      const methodId = ((init?.authMethods ?? []) as { id?: string }[])[0]?.id;
      if ((error as { code?: number }).code !== -32000 || !methodId) throw error;
      log(`acp:${agent} ${label}: ${what} requires auth; retrying after authenticate(${methodId})`);
      await conn.request('authenticate', { methodId });
      return call();
    }
  };

  const loadable =
    (init?.agentCapabilities as { loadSession?: unknown } | undefined)?.loadSession === true;
  let session: Record<string, unknown> | undefined;
  if (options.resume !== undefined && loadable) {
    try {
      const loaded = (await withAuth('session/load', () =>
        conn.request('session/load', {
          sessionId: options.resume,
          cwd: options.cwd,
          mcpServers: [],
        }),
      )) as Record<string, unknown>;
      // Same `modes` and `configOptions` a new session returns — plan mode and
      // model selection read them off this, so a resume that dropped them
      // would fail closed on every agent whose read-only layer is plan mode.
      // It carries no id of its own; the one asked for is the one it loaded.
      session = { ...loaded, sessionId: options.resume };
      // `session/load` replays the whole conversation as `session/update`
      // (live-probed, codex-acp 1.1.7), so what has arrived so far is the turn
      // before this one and would otherwise be answered with.
      segments.length = 0;
      current = '';
      lastMessageId = undefined;
      seenChunk = false;
      usesMessageIds = false;
    } catch (error) {
      // Still gated after authenticating is not a session problem, and a fresh
      // one would need the same credentials — so it stays the caller's error
      // rather than becoming a turn that quietly starts over.
      if ((error as { code?: number }).code === -32000) throw error;
      // Otherwise fails open: a session the agent has forgotten costs the
      // caller its history, and must not also cost it the answer.
      log(
        `acp:${agent} ${label}: resume ${options.resume} refused (${String(error)}); starting fresh`,
      );
    }
  }
  session ??= (await withAuth('session/new', newSession)) as Record<string, unknown>;
  const sessionId = session.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error(`acp:${agent} ${label}: session/new returned no sessionId`);
  }
  if (options.configOptionModelIds?.length) {
    await selectModelConfigOption(conn, sessionId, session, options);
  }
  const modes = session.modes as
    | { currentModeId?: string; availableModes?: Record<string, unknown>[] }
    | undefined;
  const roster = (modes?.availableModes ?? []).flatMap((entry): SessionMode[] =>
    typeof entry.id === 'string'
      ? [
          {
            id: entry.id,
            ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
            ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
          },
        ]
      : [],
  );
  if (options.mode !== undefined) {
    // The caller's mode is its member's explicit choice: not offered fails the
    // turn — silently downgrading would run a different permission tier than
    // the one they were shown, and upgrading is not ours to do either.
    if (!roster.some((offered) => offered.id === options.mode)) {
      throw new Error(
        `acp:${agent} ${label}: mode ${options.mode} not offered (offers: ${
          roster.map((offered) => offered.id).join(', ') || 'none'
        })`,
      );
    }
    if (modes?.currentModeId !== options.mode) {
      await conn.request('session/set_mode', { sessionId, modeId: options.mode });
    }
  } else {
    const planOffered = roster.some((offered) => offered.id === 'plan');
    if (planOffered && modes?.currentModeId !== 'plan') {
      try {
        await conn.request('session/set_mode', { sessionId, modeId: 'plan' });
      } catch (error) {
        const detail = `plan mode unavailable (${
          error instanceof Error ? error.message : String(error)
        })`;
        // Agents with no agent-side sandbox (spec.requirePlanMode) fail CLOSED
        // here — plan mode is their behavioral read-only layer, not a nicety.
        if (options.requirePlanMode) {
          throw new Error(`acp:${agent} ${label}: ${detail}; refusing to run without it`);
        }
        log(`acp:${agent} ${label}: ${detail}; relying on permission policy`);
      }
    } else if (!planOffered) {
      // kilo exposes mode as a config option (no session/modes); its `plan`
      // value is the read-only agent — the same contract as opencode's.
      const applied = await selectPlanConfigOption(conn, sessionId, session, options);
      if (!applied && options.requirePlanMode) {
        throw new Error(
          `acp:${agent} ${label}: agent offered no plan mode; refusing to run without it`,
        );
      }
    }
  }
  const result = (await conn.request('session/prompt', {
    sessionId,
    prompt: [
      {
        type: 'text',
        text:
          options.context !== undefined && sessionId !== options.resume
            ? `${options.context}\n\n${options.prompt}`
            : options.prompt,
      },
    ],
  })) as Record<string, unknown>;
  // opencode-lineage agents can flush trailing session/update frames AFTER the
  // prompt response (anomalyco/opencode#17505, live-hit via kilo). Flushing
  // now would truncate — the trailing chunks land in `current` after this
  // point whether or not text already arrived — so drain first (the ordering
  // race resolves within one I/O flush), then take the final segment.
  await new Promise((resolve) => setTimeout(resolve, ACP_POST_TURN_DRAIN_MS));
  flush();
  const aside = (segment: { id: unknown }) => usesMessageIds && segment.id === undefined;
  // A notice arriving mid-message splits the message it interrupted, so a run
  // of one id rejoins — otherwise the half before the interruption is not the
  // last segment, and the answer comes back with its opening missing.
  const answered: { id: unknown; text: string }[] = [];
  for (const segment of segments) {
    if (aside(segment)) continue;
    const open = answered[answered.length - 1];
    if (open && segment.id !== undefined && segment.id === open.id) open.text += segment.text;
    else answered.push({ ...segment });
  }
  // Filtering to nothing means the session labelled something but not what it
  // answered with. Recall beats precision there (AGENTS.md, "auxiliary sessions
  // fail open") — an aside shown as the answer is recoverable, a lost answer is
  // not — so the asides are taken back rather than returning silence.
  const kept = answered.length ? answered : segments;
  const finalMode =
    options.mode ?? (typeof modes?.currentModeId === 'string' ? modes.currentModeId : undefined);
  return {
    text: (kept[kept.length - 1]?.text ?? '').trim(),
    stopReason: String(result?.stopReason ?? 'unknown'),
    sessionId,
    notices: answered.length ? segments.filter(aside).map((s) => s.text.trim()) : [],
    ...(roster.length
      ? { modes: { ...(finalMode ? { currentModeId: finalMode } : {}), availableModes: roster } }
      : {}),
  };
}

interface ConfigOptionState {
  id?: string;
  category?: string;
  currentValue?: unknown;
  options?: ModelOptionCandidate[];
}

/** Every failure here throws: silently reviewing on a model the user did not
 * pick would misrepresent the review, so no fail-open. */
/** Plan mode via the `mode` config option, for agents without session/modes.
 * Returns whether plan is (now) active; setting failures throw when plan mode
 * is required — a review outside the read-only agent must not run. */
async function selectPlanConfigOption(
  conn: AcpConnection,
  sessionId: string,
  session: Record<string, unknown>,
  options: AcpSessionOptions,
): Promise<boolean> {
  const { agent, label, log } = options;
  const configOptions = (session.configOptions ?? []) as ConfigOptionState[];
  const modeOption = configOptions.find(
    (option) => option.id === 'mode' || option.category === 'mode',
  );
  if (!modeOption?.id) return false;
  const plan = matchModelOptionValue(modeOption.options ?? [], 'plan');
  if (!plan) return false;
  if (modeOption.currentValue === plan) return true;
  try {
    const updated = (await conn.request('session/set_config_option', {
      sessionId,
      configId: modeOption.id,
      value: plan,
    })) as Record<string, unknown> | undefined;
    const after = ((updated?.configOptions ?? []) as ConfigOptionState[]).find(
      (option) => option.id === modeOption.id,
    );
    if (after?.currentValue !== plan) {
      throw new Error(`agent reports mode ${JSON.stringify(after?.currentValue)}`);
    }
    return true;
  } catch (error) {
    const detail = `plan mode via config option failed (${
      error instanceof Error ? error.message : String(error)
    })`;
    if (options.requirePlanMode) {
      throw new Error(`acp:${agent} ${label}: ${detail}; refusing to run without it`);
    }
    log(`acp:${agent} ${label}: ${detail}; relying on permission policy`);
    return false;
  }
}

async function selectModelConfigOption(
  conn: AcpConnection,
  sessionId: string,
  session: Record<string, unknown>,
  options: AcpSessionOptions,
): Promise<void> {
  const { agent, label } = options;
  const candidates = options.configOptionModelIds as string[];
  const modelId = candidates[0];
  const configOptions = (session.configOptions ?? []) as ConfigOptionState[];
  const modelOption = configOptions.find(
    (option) => option.id === 'model' || option.category === 'model',
  );
  if (!modelOption?.id) {
    throw new Error(
      `acp:${agent} ${label}: agent exposes no model config option; cannot select "${modelId}"`,
    );
  }
  let value: string | undefined;
  for (const candidate of candidates) {
    value = matchModelOptionValue(modelOption.options ?? [], candidate);
    if (value) break;
  }
  if (!value) {
    const available = (modelOption.options ?? [])
      .flatMap((option) => (Array.isArray(option.options) ? option.options : [option]))
      .map((option) => option.value)
      .filter(Boolean)
      .slice(0, 12)
      .join(', ');
    throw new Error(
      `acp:${agent} ${label}: model "${modelId}" is not offered by the agent; first offers: ${available}`,
    );
  }
  if (modelOption.currentValue === value) return;
  const updated = (await conn.request('session/set_config_option', {
    sessionId,
    configId: modelOption.id,
    value,
  })) as Record<string, unknown> | undefined;
  const after = ((updated?.configOptions ?? []) as ConfigOptionState[]).find(
    (option) => option.id === modelOption.id,
  );
  if (after?.currentValue !== value) {
    throw new Error(
      `acp:${agent} ${label}: model selection did not stick (wanted "${value}", agent reports ${JSON.stringify(after?.currentValue)})`,
    );
  }
}

export interface AcpAgentSpec {
  /** Backend id this spec serves; the engine name becomes `acp:<id>`. */
  id: string;
  bin: string;
  args(model: string): string[];
  /** Per-spawn env + optional cleanup (temp auth copies, config files). */
  env(model: string): { env: NodeJS.ProcessEnv; cleanup?: () => void };
  /** Ordered model-id candidates for the agent's ACP model config option —
   * for agents (devin, kilo) whose CLI flags/env/config never reach the ACP
   * session. Empty result skips selection; kilo always returns candidates
   * because its session default is a PAID model while the caller's
   * `kilo/default` means the free gateway tier. */
  modelConfigCandidates?(model: string): string[];
  /** See AcpSessionOptions.requirePlanMode. */
  requirePlanMode?: boolean;
}
export function cursorAcpSpec(apiKey: string): AcpAgentSpec {
  return {
    id: 'cursor',
    // Global flags precede the subcommand (docs pattern: `agent --api-key … acp`).
    bin: CURSOR_CLI_BIN,
    args: (model) => {
      const { modelID } = parseModelName(model);
      return modelID === 'default' ? ['acp'] : ['--model', modelID, 'acp'];
    },
    env: () => ({ env: cursorEnvForKey(apiKey) }),
    requirePlanMode: true,
  };
}

export function devinAcpSpec(credentialsHome = process.env.HOME || homedir()): AcpAgentSpec {
  return {
    id: 'devin',
    bin: DEVIN_CLI_BIN,
    args: () => ['acp'],
    // Per-spawn temp HOME: credentials copy plus the same read-only
    // permissions config the argv driver enforces — devin has no OS sandbox
    // in ACP mode, so this config + required plan mode are its agent-side
    // layers. --model argv, DEVIN_MODEL, and config-file agent.model never
    // reach the ACP session (verified via the session's own config-option
    // readout), so the model rides session/set_config_option instead.
    env: () => {
      const dir = mkdtempSync(join(tmpdir(), 'symma-devin-acp-'));
      try {
        const credentials = devinCredentialsPath(dir);
        mkdirSync(dirname(credentials), { recursive: true, mode: 0o700 });
        copyFileSync(devinCredentialsPath(credentialsHome), credentials);
        const config = join(dir, '.config', 'devin', 'config.json');
        mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
        writeFileSync(config, JSON.stringify(buildDevinReadOnlyConfig()), { mode: 0o600 });
      } catch (error) {
        // The cleanup callback is only returned on success; reclaim the dir.
        rmSync(dir, { recursive: true, force: true });
        throw error;
      }
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir };
      // XDG overrides would bypass the temp HOME's config/credentials.
      delete env.XDG_CONFIG_HOME;
      delete env.XDG_DATA_HOME;
      return { env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    },
    modelConfigCandidates: (model) => {
      const { modelID } = parseModelName(model);
      return modelID === 'default' ? [] : [modelID, model];
    },
    requirePlanMode: true,
  };
}

export function kiloAcpSpec(auth: string): AcpAgentSpec {
  return {
    id: 'kilo',
    bin: KILO_CLI_BIN,
    args: () => ['acp'],
    // kiloEnvForAuth: per-spawn temp HOME/XDG (kilo's SQLite data dir race) +
    // env-injected KILO_AUTH_CONTENT + ambient key stripping — the argv
    // driver's materialization, live-verified against `kilo acp`.
    env: () => {
      const dir = mkdtempSync(join(tmpdir(), 'symma-kilo-acp-'));
      try {
        return {
          env: kiloEnvForAuth(auth, dir),
          cleanup: () => rmSync(dir, { recursive: true, force: true }),
        };
      } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
      }
    },
    // ALWAYS select: the ACP session default is a paid model, while a caller's
    // `kilo/default` means the free gateway tier. Option values are full
    // gateway-prefixed ids (`kilo/<vendor>/<model>`), so the prefixed form
    // leads; the bare id is only a hedge against kilo dropping the prefix.
    modelConfigCandidates: (model) => {
      const { modelID } = parseModelName(model);
      const id = modelID === 'default' ? KILO_GATEWAY_FREE_MODEL : modelID;
      return [`${KILO_PROVIDER_ID}/${id}`, id];
    },
    requirePlanMode: true,
  };
}

/** `codexHome` is the member's own — only `auth.json` is read out of it.
 * `runHome` is symma's, and persists; see `prepareCodexRunHome`. */
export function codexAcpSpec(codexHome: string, runHome: string): AcpAgentSpec {
  return {
    id: 'codex',
    bin: CODEX_ACP_BIN,
    args: () => [],
    env: (model) => {
      const env = codexEnvForHome(prepareCodexRunHome(codexHome, runHome));
      // codex-acp runtime overrides (README): CODEX_PATH swaps the binary and
      // MODEL_PROVIDER redirects models, so ambient values must not reach the
      // child. CODEX_CONFIG is set rather than stripped — being per process is
      // what lets the model vary while sessions share one home.
      delete env.CODEX_PATH;
      delete env.MODEL_PROVIDER;
      const { modelID } = parseModelName(model);
      if (modelID === 'default') delete env.CODEX_CONFIG;
      else env.CODEX_CONFIG = JSON.stringify({ model: modelID });
      // Live-probed against codex-acp 1.1.7: config.toml's `sandbox_mode`
      // leaves the ACP mode reading `agent`; this is what selects read-only.
      env.INITIAL_AGENT_MODE = 'read-only';
      env.NO_BROWSER = '1';
      return { env };
    },
  };
}

export function claudeAcpSpec(): AcpAgentSpec {
  return {
    id: 'claude',
    bin: CLAUDE_ACP_BIN,
    args: () => [],
    // Ambient identity on purpose: the OAuth lives in the macOS Keychain, so
    // there is no credential file to copy into a temp HOME, and
    // ANTHROPIC_API_KEY stays — it is a way to be the account, not a shadow.
    env: () => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      // The CLI refuses to nest while CLAUDECODE is set (live-hit: a companion
      // started from a Claude Code terminal inherits it); the adapter's spawn
      // is not a nested session.
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;
      return { env };
    },
    // Model is a config option (live readout: bare ids — default, sonnet,
    // opus[1m] — with display names the matcher already handles). `default`
    // skips selection, which keeps the member's own configured model.
    modelConfigCandidates: (model) => {
      const { modelID } = parseModelName(model);
      return modelID === 'default' ? [] : [modelID];
    },
    // "Planning mode, no actual tool execution" — the agent-side layer.
    requirePlanMode: true,
  };
}

export function geminiAcpSpec(geminiHome = process.env.HOME || homedir()): AcpAgentSpec {
  return {
    id: 'gemini',
    bin: GEMINI_CLI_BIN,
    args: (model) => {
      const { modelID } = parseModelName(model);
      // The registry's current flag is --acp; this is its deprecated alias,
      // deliberately — it is the one spelling old and new installs both accept.
      return modelID === 'default' ? ['--experimental-acp'] : ['--experimental-acp', '-m', modelID];
    },
    // Temp HOME with only the OAuth material copied — settings.json is written
    // fresh rather than copied, because the member's own carries mcpServers and
    // an ACP session must not inherit those. Ambient provider keys are
    // stripped (same motive as kilo's list): a GEMINI_API_KEY would silently
    // rebill a session the member expects on their OAuth plan.
    env: () => {
      const dir = mkdtempSync(join(tmpdir(), 'symma-gemini-acp-'));
      try {
        const dest = join(dir, '.gemini');
        mkdirSync(dest, { recursive: true, mode: 0o700 });
        copyFileSync(geminiOauthPath(geminiHome), geminiOauthPath(dir));
        for (const extra of ['google_accounts.json', 'installation_id', 'google_account_id']) {
          const src = join(geminiHome, '.gemini', extra);
          if (existsSync(src)) copyFileSync(src, join(dest, extra));
        }
        writeFileSync(
          join(dest, 'settings.json'),
          `${JSON.stringify({ selectedAuthType: 'oauth-personal' })}\n`,
          { mode: 0o600 },
        );
      } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
      }
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir };
      delete env.XDG_CONFIG_HOME;
      delete env.XDG_DATA_HOME;
      for (const key of KILO_STRIPPED_ENV_KEYS) delete env[key];
      // Never a browser: authenticate() on a stale login must fail as words on
      // the companion's log, not hijack a display it may not have.
      env.NO_BROWSER = 'true';
      return { env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    },
    // No plan mode exists (approval modes are default/auto_edit/yolo — none a
    // read-only agent), so requiring one refuses every session. Deliberate:
    // invariant 1 is unconditional until the DM path exists, and "DM tier" as
    // prose alone is a tier that closes by accident — this is the mechanism.
    // Whoever builds the DM path amends this in the same commit (§3).
    requirePlanMode: true,
  };
}

export function opencodeAcpSpec(auth: string): AcpAgentSpec {
  return {
    id: 'opencode',
    bin: OPENCODE_CLI_BIN,
    args: () => ['acp'],
    // kilo's lineage, kilo's treatment (live-verified: identical handshake
    // under a temp HOME/XDG with only auth.json copied): per-spawn data dir,
    // ambient provider keys stripped so auth.json is the whole identity.
    env: () => {
      const dir = mkdtempSync(join(tmpdir(), 'symma-opencode-acp-'));
      try {
        const dataHome = join(dir, '.local', 'share');
        mkdirSync(join(dataHome, 'opencode'), { recursive: true, mode: 0o700 });
        writeFileSync(opencodeAuthPath(dataHome), auth, { mode: 0o600 });
      } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
      }
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: dir,
        XDG_DATA_HOME: join(dir, '.local', 'share'),
      };
      delete env.XDG_CONFIG_HOME;
      for (const key of KILO_STRIPPED_ENV_KEYS) delete env[key];
      return { env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    },
    // Values are provider-prefixed (`opencode/<id>`, live readout), so the
    // caller's full form leads and the bare id is the hedge.
    modelConfigCandidates: (model) => {
      const { modelID } = parseModelName(model);
      return modelID === 'default' ? [] : [model, modelID];
    },
    // plan is "the read-only agent" via the mode config option — the exact
    // contract selectPlanConfigOption was built against (kilo).
    requirePlanMode: true,
  };
}
