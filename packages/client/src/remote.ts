/**
 * Drives one ACP prompt against an agent hosted by a remote companion, through
 * the gateway, instead of spawning a CLI locally. The frames and the session
 * logic are identical — only the transport differs — so this supplies
 * `driveAcpSession` with a network-backed stream pair and reuses everything
 * above it. Spec: docs/design/m2-acp-gateway.md.
 */
import { randomBytes } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';

import {
  driveAcpSession,
  parseEnvelope,
  parseRelayControl,
  type AckControl,
  type EndpointPresence,
  type RefusalCode,
  type PromptAttachment,
  type SessionModels,
  type SessionModes,
  type TurnUsage,
} from '@symma/protocol';

const REMOTE_PROMPT_TIMEOUT_MS = 20 * 60_000;
/** Bounds every gateway round trip: POSTs, the SSE connect, and the open ack. */
const GATEWAY_TIMEOUT_MS = 60_000;

/** A refusal that reached us with a machine-readable cause. `offline` and
 * `at_capacity` are worth retrying; the others are config or a caller bug.
 * `code` is absent when the companion refused for a reason the set does not
 * name — a spawn or setup failure on that machine. */
export class RemoteRefusedError extends Error {
  constructor(
    message: string,
    readonly code?: RefusalCode,
  ) {
    super(message);
    this.name = 'RemoteRefusedError';
  }
}

export interface RemoteAcpConfig {
  gateway: string;
  token: string;
  endpoint: string;
  agent: string;
  /** Groups this run's sessions in the gateway journal and viewer. */
  runId: string;
  /** An id the endpoint advertised in `hello.workspaces[]`; the agent starts in
   * that directory instead of an empty temp one. Never a path — resolving it is
   * the companion's job, and its allowlist is the boundary (§4). */
  workspace?: string;
  /** Session mode the member picked, one the agent offers. Requires a
   * workspace — the companion refuses a write-capable mode outside one. */
  mode?: string;
  /** Receives the agent's mode roster when it serves one, for whoever renders
   * the member's picker. Absent drops it. */
  onModes?: (modes: SessionModes) => void;
  /** The same, for the model roster. */
  onModels?: (models: SessionModels) => void;
  /** Files to hand the agent with the prompt; the caller fetched them. */
  attachments?: PromptAttachment[];
  /** What the turn cost, when the agent reported it. */
  onUsage?: (usage: TurnUsage) => void;
  /** Attachments the agent advertised no block for; the caller told its member
   * they were being read, so it is the one that has to correct the record. */
  onUnsupported?: (files: { name: string; kind: string }[]) => void;
  /** What the agent stopped to ask about and the floor answered for the caller.
   * A member driving this from Slack was not at the terminal it would have
   * prompted at, so this is how they hear it happened. */
  onApprovals?: (approvals: { title: string; allowed: boolean }[]) => void;
  /** What the agent is doing right now, unthrottled — a caller rendering this
   * anywhere rate-limited does its own throttling. */
  onProgress?: (title: string) => void;
  /** Receives `AcpSessionResult.notices` — what the agent said about itself
   * rather than about the prompt. Absent drops them. */
  onNotice?: (notice: string) => void;
  /** An agent session to reattach to, and what a fresh one would need instead.
   * Which happened is not known until the load is tried, so both are handed
   * over and the driver uses the one that applies. */
  resume?: string;
  context?: string;
  /** The session the turn ran in, for a caller that means to resume it next
   * time. Equal to `resume` when that was honoured. `resumeWith` is how the
   * agent's own CLI picks it up, when it has one — the two together are the
   * whole handoff back to a terminal. */
  onSession?: (sessionId: string, resumeWith?: string) => void;
  /** Checked out by the companion so the agent can explore the code it reviews. */
  repo?: string;
  ref?: string;
  /** Merge base, so the companion deepens until the diff the prompt shows is runnable. */
  base?: string;
}

/** Session ids double as journal filenames, so keep them id-safe and unique.
 * The label is clamped, not the whole id, so the random suffix always survives. */
const sessionIdFor = (label: string): string =>
  `${label.replaceAll(/[^A-Za-z0-9._-]/g, '-').slice(0, 100)}-${randomBytes(4).toString('hex')}`;

/**
 * Fails fast when the endpoint can't serve this review. Without it a bad
 * gateway URL, a stale token, a sleeping laptop, or an agent the companion
 * doesn't offer would surface minutes in, as a refused session mid-review.
 * Returns the slots free right now — a snapshot, but a run sized to the
 * endpoint's total would collide with whatever it is already serving.
 */
export async function checkEndpointReady(
  config: Omit<RemoteAcpConfig, 'agent'>,
  agent: string,
): Promise<{ freeSessions: number }> {
  const url = `${config.gateway}/api/endpoints`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `ACP gateway unreachable at ${config.gateway}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `ACP gateway rejected the endpoint listing (${response.status}); check the gateway token.`,
    );
  }
  const endpoints = (await response.json()) as EndpointPresence[];
  const endpoint = endpoints.find((entry) => entry.endpoint === config.endpoint);
  if (!endpoint?.online) {
    const online = endpoints
      .filter((entry) => entry.online)
      .map((entry) => entry.endpoint)
      .join(', ');
    throw new Error(
      `ACP endpoint "${config.endpoint}" is offline; start its companion. Online now: ${online || 'none'}.`,
    );
  }
  if (!endpoint.agents.some((offered) => offered.agent === agent)) {
    throw new Error(
      `ACP endpoint "${config.endpoint}" does not offer agent "${agent}"; it offers: ${
        endpoint.agents.map((offered) => offered.agent).join(', ') || 'none'
      }.`,
    );
  }
  const freeSessions = endpoint.maxSessions - endpoint.activeSessions;
  if (freeSessions <= 0) {
    throw new Error(
      `ACP endpoint "${config.endpoint}" has no free session slots (${endpoint.activeSessions}/${endpoint.maxSessions} in use).`,
    );
  }
  return { freeSessions };
}

export async function runRemotePrompt(
  config: RemoteAcpConfig,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs = REMOTE_PROMPT_TIMEOUT_MS,
): Promise<string> {
  const sessionId = sessionIdFor(label);
  const base = `${config.gateway}/api/sessions/${sessionId}`;
  const auth = { authorization: `Bearer ${config.token}` };
  const output = new PassThrough();
  const stream = new AbortController();
  let seq = 0;

  const post = (payload: Record<string, unknown>): Promise<Response> =>
    fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/x-ndjson' },
      body: `${JSON.stringify(payload)}\n`,
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
  const sendFrame = (frame: Record<string, unknown>): Promise<Response> =>
    post({
      v: 1,
      runId: config.runId,
      sessionId,
      seq: (seq += 1),
      ts: Date.now(),
      agent: config.agent,
      label,
      model,
      dir: 'out',
      frame,
    });

  const acked = deferred<AckControl>();
  const closed = deferred<never>();
  // Loses most races; without a handler its rejection would surface as an
  // unhandled rejection rather than the error the caller already saw.
  closed.promise.catch(() => {});

  // Header auth, not ?token= — that form exists for browser EventSource, which
  // cannot set headers, and would put the credential in logs and caches.
  const connectTimer = setTimeout(() => stream.abort(), GATEWAY_TIMEOUT_MS);
  let sse: Response;
  try {
    sse = await fetch(`${base}/stream`, { headers: auth, signal: stream.signal });
  } finally {
    clearTimeout(connectTimer);
  }
  if (!sse.ok || !sse.body) {
    await sse.body?.cancel();
    throw new Error(`${label}: gateway stream refused (${sse.status})`);
  }
  // Agent frames feed the session's stdin-equivalent; controls resolve the
  // open handshake or fail the prompt.
  const reading = pump(sse.body, (line) => {
    const control = parseRelayControl(line);
    if (control?.kind === 'opened' || control?.kind === 'refused') {
      acked.resolve(control);
      return;
    }
    if (control?.kind === 'close') {
      closed.reject(
        new Error(`${label}: session closed by gateway: ${control.reason ?? 'closed'}`),
      );
      return;
    }
    const envelope = parseEnvelope(line);
    if (envelope) output.write(`${JSON.stringify(envelope.frame)}\n`);
  })
    // A stream that ends or errors without a close control would otherwise
    // leave the session waiting out its full timeout.
    .then(
      () => closed.reject(new Error(`${label}: gateway stream ended`)),
      (error: Error) =>
        closed.reject(new Error(`${label}: gateway stream failed: ${error.message}`)),
    );

  const input = new Writable({
    write(chunk, _encoding, callback) {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(chunk)) as Record<string, unknown>;
      } catch (error) {
        callback(error as Error);
        return;
      }
      sendFrame(frame).then(
        (res) =>
          callback(res.ok ? null : new Error(`${label}: gateway rejected a frame (${res.status})`)),
        callback,
      );
    },
  });
  // Without a listener the stream's 'error' event would take down the process,
  // and swallowing it would hang the prompt — driveAcpSession has no input
  // error path — so fail the session through the race the caller already awaits.
  input.on('error', (error: Error) =>
    closed.reject(new Error(`${label}: frame send failed: ${error.message}`)),
  );

  try {
    const opened = await post({
      kind: 'open',
      sessionId,
      runId: config.runId,
      endpoint: config.endpoint,
      agent: config.agent,
      model,
      ...(config.workspace ? { workspace: config.workspace } : {}),
      ...(config.mode ? { mode: config.mode } : {}),
      ...(config.repo ? { repo: config.repo } : {}),
      ...(config.ref ? { ref: config.ref } : {}),
      ...(config.base ? { base: config.base } : {}),
    });
    // Fail on the real status (401/413/5xx) instead of waiting out the ack.
    if (!opened.ok) throw new Error(`${label}: gateway rejected the open (${opened.status})`);
    const ack = await raceWithDeadline(
      [acked.promise, closed.promise],
      GATEWAY_TIMEOUT_MS,
      `${label}: endpoint ${config.endpoint} did not answer the open`,
    );
    if (ack.kind === 'refused') {
      throw new RemoteRefusedError(
        `${label}: endpoint ${config.endpoint} refused: ${ack.reason ?? 'no reason'}`,
        ack.code,
      );
    }
    log(`Calling ${label} prompt (agent=${config.agent}@${config.endpoint}, model=${model})`);

    const result = await raceWithDeadline(
      [
        driveAcpSession(
          { input, output },
          {
            cwd: ack.workspace ?? '.',
            prompt,
            agent: config.agent,
            label,
            log,
            model,
            ...(ack.modelCandidates ? { configOptionModelIds: ack.modelCandidates } : {}),
            ...(ack.requirePlanMode ? { requirePlanMode: true } : {}),
            ...(config.mode !== undefined ? { mode: config.mode } : {}),
            ...(config.onProgress ? { onProgress: config.onProgress } : {}),
            ...(config.attachments?.length ? { attachments: config.attachments } : {}),
            ...(config.resume !== undefined ? { resume: config.resume } : {}),
            ...(config.context !== undefined ? { context: config.context } : {}),
          },
        ),
        closed.promise,
      ],
      timeoutMs,
      `${label}: remote prompt timed out after ${Math.round(timeoutMs / 1000)}s (model=${model})`,
    );
    log(
      `${label} prompt complete via gateway: stopReason=${result.stopReason} last-message=${result.text.length} chars`,
    );
    // Fails open, and one at a time: the answer is already in hand, so neither
    // a sink that throws nor the ones after it are worth losing it for
    // (AGENTS.md, "auxiliary sessions fail open").
    const deliver = (what: string, sink: () => void): void => {
      try {
        sink();
      } catch (error) {
        log(`${label}: ${what} sink threw, dropping one: ${String(error)}`);
      }
    };
    deliver('session', () => config.onSession?.(result.sessionId, ack.resumeWith));
    const roster = result.modes;
    if (roster) deliver('modes', () => config.onModes?.(roster));
    const modelRoster = result.models;
    if (modelRoster) deliver('models', () => config.onModels?.(modelRoster));
    const spent = result.usage;
    if (spent) deliver('usage', () => config.onUsage?.(spent));
    const unsupported = result.unsupported;
    if (unsupported?.length) deliver('unsupported', () => config.onUnsupported?.(unsupported));
    const approvals = result.approvals;
    if (approvals?.length) deliver('approvals', () => config.onApprovals?.(approvals));
    for (const notice of result.notices) deliver('notice', () => config.onNotice?.(notice));
    if (!result.text) {
      throw new Error(
        `${label}: agent produced no assistant message (stopReason=${result.stopReason})`,
      );
    }
    return result.text;
  } finally {
    // Advisory teardown — the result is already in hand, and a dropped close
    // is covered by the gateway's resume window, so never block the return.
    void post({ kind: 'close', sessionId, reason: 'prompt complete' }).catch(() => {});
    stream.abort();
    // End only once the pump is provably done. Aborting does not stop a read
    // that already resolved, so ending first let a late frame write into a
    // closed stream — and on a path that never reached driveAcpSession, that
    // 'error' has no listener and takes the process down. `reading` was always
    // awaited here, so this reorders teardown rather than blocking it.
    await reading;
    output.end();
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Races `work` against a deadline, clearing the timer once anything settles —
 * a timer left armed would reject after the race and go unobserved. */
function raceWithDeadline<T>(work: Promise<T>[], ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref();
  });
  return Promise.race([...work, deadline]).finally(() => clearTimeout(timer));
}

/** Reads an SSE body, handing each `data:` payload to `onLine` unparsed. */
async function pump(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data: ')) onLine(line.slice(6));
      nl = buffer.indexOf('\n');
    }
  }
}
