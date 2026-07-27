/**
 * Drives one ACP prompt against an agent spawned on this machine: process
 * lifecycle, stderr capture, wall-clock deadline and temp-home teardown. The
 * local counterpart to remote.ts — both hand `driveAcpSession` a stream pair
 * and differ only in where the other end lives.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import {
  driveAcpSession,
  terminateProcessTree,
  truncateForLog,
  type AcpAgentSpec,
  type AcpSessionOptions,
} from '@symma/protocol';

const ACP_PROMPT_TIMEOUT_MS = 20 * 60_000;
const ACP_KILL_GRACE_MS = 2_000;
const ACP_STDERR_TAIL_BYTES = 64 * 1024;
// A stdout that just ended means the child is on its way out; this only has to
// outlast the gap between the pipe closing and 'close' firing.
const ACP_EXIT_SETTLE_MS = 250;

/** Exit code or signal if the child is already gone, or goes within `ms`. */
function exitWithin(child: ChildProcess, ms: number): Promise<number | string | undefined> {
  const settled = child.exitCode ?? child.signalCode;
  if (settled !== null) return Promise.resolve(settled);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref();
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve(code ?? signal ?? undefined);
    });
  });
}

export interface LocalAcpPromptOptions {
  /** Wall-clock budget for the whole prompt. */
  timeoutMs?: number;
  /** Observe every frame in both directions — the same tee `driveAcpSession`
   * takes. A caller whose frames are already journaled elsewhere passes none. */
  tee?: AcpSessionOptions['tee'];
}

export async function runLocalAcpPrompt(
  spec: AcpAgentSpec,
  workspace: string,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  { timeoutMs = ACP_PROMPT_TIMEOUT_MS, tee }: LocalAcpPromptOptions = {},
): Promise<string> {
  const { env, cleanup } = spec.env(model);
  const configOptionModelIds = spec.modelConfigCandidates?.(model);
  log(`Calling ${label} prompt (agent=acp:${spec.id}, model=${model})`);
  const child = spawn(spec.bin, spec.args(model), {
    cwd: workspace,
    // Same process-group contract as cli-process.ts: a wedged agent (and any
    // child it spawned) can never outlive the review.
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-ACP_STDERR_TAIL_BYTES);
  });
  child.stdin?.on('error', (error: Error) => {
    stderr += `\n[stdin error: ${error.message}]`;
  });
  let timer: NodeJS.Timeout | undefined;
  let result: { text: string; stopReason: string };
  try {
    result = await Promise.race([
      driveAcpSession(
        { input: child.stdin as Writable, output: child.stdout as Readable },
        {
          cwd: workspace,
          prompt,
          agent: spec.id,
          label,
          log,
          model,
          configOptionModelIds,
          requirePlanMode: spec.requirePlanMode,
          tee,
        },
      ),
      new Promise<never>((_, reject) => {
        child.on('error', reject);
        child.on('close', (code) =>
          reject(
            new Error(
              `acp:${spec.id} ${label} exited ${code} before responding: ${truncateForLog(stderr, 1000)}`,
            ),
          ),
        );
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `acp:${spec.id} ${label} prompt timed out after ${Math.round(timeoutMs / 1000)}s (model=${model})`,
              ),
            ),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } catch (error) {
    // An agent's stdout ends before its process 'close' fires, so
    // driveAcpSession's transport error wins the race above — and on its own
    // it says nothing about why the agent died. Expired credentials are the
    // common case and the reason is on stderr, so wait briefly for the exit
    // and report that instead.
    const exit = await exitWithin(child, ACP_EXIT_SETTLE_MS);
    if (exit === undefined) throw error;
    throw new Error(
      `acp:${spec.id} ${label} exited ${exit} before responding: ${truncateForLog(stderr, 1000)}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      terminateProcessTree(child, ACP_KILL_GRACE_MS);
    }
    // Wait (bounded) for the exit before removing the temp home: a dying
    // agent still writing there (kilo's SQLite) races rmSync into ENOTEMPTY.
    await exitWithin(child, ACP_KILL_GRACE_MS + 500);
    try {
      cleanup?.();
    } catch {
      // Teardown must never mask the session result; tmpdir reclaims leftovers.
    }
  }
  // Outside the guard above: a turn that ends with no text is a session result,
  // not a transport failure, and must keep its own stopReason.
  log(
    `${label} prompt complete via acp:${spec.id}: stopReason=${result.stopReason} last-message=${result.text.length} chars`,
  );
  if (!result.text) {
    throw new Error(
      `acp:${spec.id} ${label} produced no assistant message (stopReason=${result.stopReason}); stderr: ${truncateForLog(stderr, 1000)}`,
    );
  }
  return result.text;
}
