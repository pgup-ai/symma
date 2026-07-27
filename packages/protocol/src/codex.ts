import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CODEX_PROVIDER_ID = 'codex';

export function isCodexProvider(providerID: string): boolean {
  return providerID === CODEX_PROVIDER_ID;
}

export function codexAuthPath(codexHome: string): string {
  return join(codexHome, 'auth.json');
}

/**
 * Writes the `CODEX_AUTH_JSON` secret — the raw contents of `~/.codex/auth.json`
 * — to `$CODEX_HOME/auth.json`. The whole file is carried so Codex keeps
 * subscription mode and its refresh_token; JSON-validated so a bad secret fails fast.
 */
export function writeCodexAuth(auth: string, codexHome: string): string {
  const content = auth.trim();
  if (!content) {
    throw new Error('Missing Codex auth. Set codex-auth or CODEX_AUTH_JSON.');
  }
  try {
    JSON.parse(content);
  } catch {
    throw new Error('Invalid CODEX_AUTH_JSON: expected the JSON contents of ~/.codex/auth.json.');
  }

  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const path = codexAuthPath(codexHome);
  writeFileSync(path, `${content}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on filesystems that do not support chmod */
  }
  return path;
}

/**
 * Child env with the temp `CODEX_HOME`. The api-key/access-token envs are stripped
 * because Codex ranks them ABOVE auth.json — an ambient `OPENAI_API_KEY` would
 * silently switch the run to per-token API billing instead of the subscription.
 */
export function codexEnvForHome(codexHome: string | undefined): NodeJS.ProcessEnv {
  const home = codexHome?.trim();
  if (!home) {
    throw new Error('Missing Codex home. A temp CODEX_HOME is required for auth.');
  }
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CODEX_ACCESS_TOKEN;
  return env;
}
