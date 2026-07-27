import { spawn, type ChildProcess } from 'node:child_process';

const DEFAULT_KILL_GRACE_MS = 2_000;

/**
 * SIGTERMs the child's process group (plain pid on Windows — no process
 * groups there), escalating to SIGKILL after graceMs unless it exits first.
 * Returns a cancel for the escalation timer; the SIGKILL also self-guards on
 * exitCode so a late signal can never land on a reused pid.
 */
export function terminateProcessTree(
  child: ChildProcess,
  graceMs = DEFAULT_KILL_GRACE_MS,
): () => void {
  const pid = child.pid;
  if (pid === undefined) return () => {};
  const target = process.platform === 'win32' ? pid : -pid;
  try {
    process.kill(target, 'SIGTERM');
  } catch {
    /* best effort */
  }
  const killTimer = setTimeout(() => {
    // A signal-terminated child keeps exitCode null and sets signalCode, so
    // check both — otherwise the escalation could fire at a reused pid.
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      /* best effort */
    }
  }, graceMs);
  killTimer.unref();
  return () => clearTimeout(killTimer);
}

export interface CliProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface CliProcessOptions {
  cwd: string;
  timeoutMs: number;
  /** Rejection message used when the wall-clock timeout fires. */
  timeoutMessage: string;
  /**
   * When provided, this is written to the child's stdin (stdin = 'pipe', then
   * closed). When omitted, stdin is ignored — a CLI that takes its prompt from
   * a file or argv needs no stdin stream.
   */
  input?: string;
  /** Child environment; defaults to inheriting the parent process env. */
  env?: NodeJS.ProcessEnv;
  killGraceMs?: number;
}

/**
 * Spawns a CLI under a hard wall-clock timeout, collecting stdout/stderr as
 * UTF-8. On timeout the whole process group is signalled SIGTERM, then SIGKILL
 * after a grace period, so a wedged agent can never outlive the review. Shared
 * by every CLI review backend (devin/commandcode/cursor) so the timeout-and-kill
 * contract lives in exactly one place.
 */
export function spawnWithTimeout(
  command: string,
  args: string[],
  options: CliProcessOptions,
): Promise<CliProcessResult> {
  const {
    cwd,
    timeoutMs,
    timeoutMessage,
    input,
    env,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
  } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      // A process group (detached) lets the timeout kill the agent AND any
      // child it spawned; Windows has no process groups, so target the pid.
      detached: process.platform !== 'win32',
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let cancelKill: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cancelKill = terminateProcessTree(child, killGraceMs);
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    timer.unref();
    const clearTimers = () => {
      clearTimeout(timer);
      cancelKill?.();
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    if (input !== undefined) {
      child.stdin?.on('error', (error: Error) => {
        // The CLI may exit before consuming stdin; record it in diagnostics
        // without racing the child close/error path.
        stderr += `\n[stdin error: ${error.message}]`;
      });
      child.stdin?.end(input);
    }
    child.on('error', (error) => {
      clearTimers();
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on('close', (exitCode) => {
      clearTimers();
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, exitCode });
    });
  });
}
