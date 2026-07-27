import { spawnWithTimeout } from './cli-process.ts';
import { truncateForLog } from './text.ts';

const CURSOR_MODEL_LIST_TIMEOUT_MS = 60_000;

export const CURSOR_PROVIDER_ID = 'cursor';
// Cursor's installer provides the `cursor-agent` binary (it also exposes a bare
// `agent` alias; use the namespaced name so a stray `agent` on PATH is never
// invoked).
export const CURSOR_CLI_BIN = 'cursor-agent';

export function isCursorProvider(providerID: string): boolean {
  return providerID === CURSOR_PROVIDER_ID;
}

/**
 * Child environment carrying the Cursor credential. The key is passed via env,
 * never argv, so it cannot leak through the process list; setting it explicitly
 * also overrides any ambient CURSOR_API_KEY so CI/local state can't shadow the
 * selected credential. NO_OPEN_BROWSER keeps any auth path strictly headless.
 */
export function cursorEnvForKey(apiKey: string): NodeJS.ProcessEnv {
  const key = apiKey.trim();
  if (!key) {
    throw new Error('Missing Cursor API key. Set cursor-api-key or CURSOR_API_KEY.');
  }
  return { ...process.env, CURSOR_API_KEY: key, NO_OPEN_BROWSER: '1' };
}

/**
 * Lists the models the supplied key can use via `cursor-agent models`, for the
 * startup observability log (mirrors listCommandCodeModels and opencode's
 * listProviderModels). Best-effort: the runner logs and continues on failure.
 */
export async function listCursorModels(workspace: string, apiKey: string): Promise<string[]> {
  const result = await spawnWithTimeout(CURSOR_CLI_BIN, ['models'], {
    cwd: workspace,
    env: cursorEnvForKey(apiKey),
    timeoutMs: CURSOR_MODEL_LIST_TIMEOUT_MS,
    timeoutMessage: `cursor model listing timed out after ${Math.round(
      CURSOR_MODEL_LIST_TIMEOUT_MS / 1000,
    )}s`,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `cursor model listing exited ${result.exitCode}: ${truncateForLog(
        result.stderr || result.stdout,
        1000,
      )}`,
    );
  }
  return parseCursorModelList(result.stdout);
}

/**
 * Parses `cursor-agent models` output. Each model line is `<id> - <displayName>`;
 * the `Available models` header, blank lines, and the trailing `Tip:` line have
 * no ` - ` separator and are skipped. Exported for unit testing (pure).
 */
export function parseCursorModelList(output: string): string[] {
  const models: string[] = [];
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*) - \S/);
    if (match) models.push(match[1]);
  }
  return models;
}
