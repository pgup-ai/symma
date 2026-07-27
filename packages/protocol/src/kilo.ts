import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnWithTimeout } from './cli-process.ts';
import { truncateForLog } from './text.ts';

const KILO_MODEL_LIST_TIMEOUT_MS = 60_000;

export const KILO_PROVIDER_ID = 'kilo';
export const KILO_CLI_BIN = 'kilo';
/** Kilo's hardcoded free smart-router; the CI default (gateway-prefixed). */
export const KILO_GATEWAY_FREE_MODEL = 'kilo-auto/free';

export function isKiloProvider(providerID: string): boolean {
  return providerID === KILO_PROVIDER_ID;
}

export const KILO_STRIPPED_ENV_KEYS = [
  'KILO_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
] as const;

/**
 * Validates the `KILO_AUTH_CONTENT` secret — the contents of
 * `~/.local/share/kilo/auth.json` — is present and JSON, returning the trimmed content.
 * Throws a clear error so a bad secret fails fast at startup.
 */
export function assertValidKiloAuth(auth: string): string {
  const content = auth.trim();
  if (!content) {
    throw new Error('Missing Kilo auth. Set kilo-auth or KILO_AUTH_CONTENT.');
  }
  try {
    JSON.parse(content);
  } catch {
    throw new Error(
      'Invalid KILO_AUTH_CONTENT: expected the JSON contents of ~/.local/share/kilo/auth.json.',
    );
  }
  return content;
}

/**
 * Child env carrying the Kilo credential via `KILO_AUTH_CONTENT` (env-injected, no file
 * written). `HOME`/`XDG_DATA_HOME` point at a per-process temp dir so concurrent
 * sessions don't race kilo's SQLite data dir (every invocation opens/migrates
 * ~/.local/share/kilo/kilo.db) or any token-refresh writeback. Ambient provider api-key
 * envs are stripped so the carried auth wins.
 */
export function kiloEnvForAuth(auth: string, home: string): NodeJS.ProcessEnv {
  const content = assertValidKiloAuth(auth);
  const h = home?.trim();
  if (!h) {
    throw new Error('Missing Kilo home. A temp HOME is required for the kilo data dir.');
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KILO_AUTH_CONTENT: content,
    HOME: h,
    XDG_DATA_HOME: join(h, '.local/share'),
  };
  for (const key of KILO_STRIPPED_ENV_KEYS) delete env[key];
  return env;
}

/**
 * Parses `kilo models` output. Each model line is a bare `provider/model-id` token; the
 * CLI's INFO log lines (which contain spaces) and headers/blanks are skipped. Pure.
 */
export function parseKiloModelList(output: string): string[] {
  const models: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (/^[A-Za-z0-9~][^\s]*\/[^\s]+$/.test(trimmed)) models.push(trimmed);
  }
  return models;
}

export async function listKiloModels(workspace: string, auth: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'jbot-kilo-'));
  try {
    const result = await spawnWithTimeout(KILO_CLI_BIN, ['models'], {
      cwd: workspace,
      env: kiloEnvForAuth(auth, dir),
      timeoutMs: KILO_MODEL_LIST_TIMEOUT_MS,
      timeoutMessage: `kilo model listing timed out after ${Math.round(
        KILO_MODEL_LIST_TIMEOUT_MS / 1000,
      )}s`,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `kilo model listing exited ${result.exitCode}: ${truncateForLog(
          result.stderr || result.stdout,
          1000,
        )}`,
      );
    }
    return parseKiloModelList(result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
