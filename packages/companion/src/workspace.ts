import { spawn } from 'node:child_process';

/**
 * Workspace checkout for a relayed session. Kept out of index.ts so the depth
 * decision is reachable from a test without dialling the gateway, and imports
 * nothing beyond node builtins so the companion stays extractable.
 */

// Depth 1 left the agent unable to run git log/diff against the PR base.
const INITIAL_DEPTH = 50;
const DEEPEN_STEPS = [200, 1_000];
const MAX_DEPTH = INITIAL_DEPTH + DEEPEN_STEPS.reduce((a, b) => a + b);
const GIT_TIMEOUT_MS = 120_000;
/** Tail of git's output kept for the refusal reason. */
const GIT_ERROR_TAIL = 300;

/**
 * One git invocation, resolving to a failure reason or undefined. Async because
 * the companion relays every other live session's frames from this same event
 * loop — a synchronous clone freezes them all for its duration.
 */
function runGit(args: string[], signal?: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      // Nothing here may wait on a human: a repo the companion cannot read has
      // to fail now, not burn the session's timeout on a prompt no one will
      // answer. GIT_ASKPASS is emptied rather than deleted because an empty
      // value also suppresses the core.askPass config, which GIT_TERMINAL_PROMPT
      // does not gate. BatchMode because ssh asks on /dev/tty, out of reach of
      // both — appended, so an operator's identity or jump host survives.
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        GIT_SSH_COMMAND: `${process.env.GIT_SSH_COMMAND || 'ssh'} -o BatchMode=yes`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // SIGKILL so an abort cannot leave the child writing into a workspace
      // the caller is about to reclaim.
      killSignal: 'SIGKILL',
      signal,
    });
    let output = '';
    const collect = (chunk: string) => {
      output = (output + chunk).slice(-GIT_ERROR_TAIL);
    };
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', collect);
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS);
    timer.unref();
    // Settled on 'close', never on 'error': 'error' fires first (abort, ENOENT)
    // while the child is still exiting, and a caller that reclaims the
    // workspace on it would race git into recreating the directory.
    let spawnError: string | undefined;
    child.on('error', (error) => {
      spawnError = error.message;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const detail = spawnError ?? (code === 0 ? undefined : output);
      resolve(detail === undefined ? undefined : `git ${args[0]} failed: ${detail}`);
    });
  });
}

/**
 * Walks the deepen steps until the base is reachable. The caller supplies the
 * git effects, so the stop-or-fail decision stands on its own — a shallow
 * clone that cannot reach the base makes the merge-base diff the prompt
 * advertises impossible, and the agent has no way to recover the difference.
 */
export async function deepenUntilBase(
  hasBase: () => Promise<boolean>,
  deepen: (depth: number) => Promise<string | undefined>,
): Promise<string | undefined> {
  if (await hasBase()) return undefined;
  for (const depth of DEEPEN_STEPS) {
    const failure = await deepen(depth);
    if (failure) return failure;
    if (await hasBase()) return undefined;
  }
  return `PR base is more than ${MAX_DEPTH} commits behind the reviewed ref.`;
}

/** argv-only git (the ref is remote-controlled input); best-effort — a fetch
 * failure refuses the session rather than running the agent on nothing. */
export async function fetchWorkspace(
  workspace: string,
  repo: string,
  ref?: string,
  base?: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const git = (args: string[]) => runGit(args, signal);
  const depth = String(INITIAL_DEPTH);
  // `--` so a repo/ref starting with `-` can never become a git flag.
  const clone = await git(['clone', '--depth', depth, '--no-tags', '--', repo, workspace]);
  if (clone) return clone;
  if (!ref) return undefined;
  const checkout =
    (await git(['-C', workspace, 'fetch', '--depth', depth, 'origin', '--', ref])) ??
    (await git(['-C', workspace, 'checkout', '--detach', 'FETCH_HEAD']));
  if (checkout || !base) return checkout;

  // merge-base needs both sides present, so the base is fetched too — the clone
  // itself only carries the default branch plus `ref`.
  const baseFetch = await git(['-C', workspace, 'fetch', '--depth', depth, 'origin', '--', base]);
  if (baseFetch) return baseFetch;

  return deepenUntilBase(
    async () => (await git(['-C', workspace, 'merge-base', base, 'HEAD'])) === undefined,
    async (step) =>
      (await git(['-C', workspace, 'fetch', `--deepen=${step}`, 'origin', '--', ref])) ??
      (await git(['-C', workspace, 'fetch', `--deepen=${step}`, 'origin', '--', base])),
  );
}
