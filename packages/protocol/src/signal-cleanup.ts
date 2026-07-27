/**
 * Teardown that has to survive a signal. A `finally` covers return and throw but
 * not SIGINT/SIGTERM/SIGHUP, and Ctrl-C is how a long review usually ends — the
 * temp checkout and the CLI homes holding materialized credentials would
 * otherwise be left on disk. One shared registry rather than a listener per
 * call site: the first handler to re-raise would cancel every other one.
 */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

const cleanups = new Set<() => void>();

function onSignal(signal: NodeJS.Signals): void {
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // One teardown losing a race (rmSync hits ENOTEMPTY often enough) must
      // not strand the rest or skip the re-raise below.
    }
  }
  for (const other of SIGNALS) process.removeListener(other, onSignal);
  // Re-raise only once nothing else handles this signal, which drops back to the
  // default disposition and the 128+signum exit. With another listener present
  // Node skips that default, so re-sending would run the host's hook a second
  // time and still not exit — termination is the host's to decide there.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

/**
 * Runs `cleanup` if the process is signalled, then re-raises. `cleanup` must be
 * synchronous — a signal handler cannot await — but may throw; the registry
 * contains that so the other cleanups and the re-raise still happen.
 */
export function onFatalSignal(cleanup: () => void): () => void {
  if (cleanups.size === 0) for (const signal of SIGNALS) process.on(signal, onSignal);
  cleanups.add(cleanup);
  return () => {
    cleanups.delete(cleanup);
    if (cleanups.size === 0) for (const signal of SIGNALS) process.removeListener(signal, onSignal);
  };
}
