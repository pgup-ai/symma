import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEVIN_PROVIDER_ID = 'devin';
export const DEVIN_CLI_BIN = 'devin';

export function isDevinProvider(providerID: string): boolean {
  return providerID === DEVIN_PROVIDER_ID;
}

export function devinCredentialsPath(home = process.env.HOME || homedir()): string {
  return join(home, '.local', 'share', 'devin', 'credentials.toml');
}

export function writeDevinCredentials(
  windsurfApiKey: string,
  home = process.env.HOME || homedir(),
): string {
  const key = windsurfApiKey.trim();
  if (!key)
    throw new Error('Missing Devin API key. Set devin-windsurf-api-key or DEVIN_WINDSURF_API_KEY.');

  const path = devinCredentialsPath(home);
  mkdirSync(join(home, '.local', 'share', 'devin'), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    [
      `windsurf_api_key = ${tomlString(key)}`,
      'api_server_url = "https://server.codeium.com"',
      'devin_webapp_host = "https://app.devin.ai"',
      'devin_api_url = "https://api.devin.ai"',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on filesystems that do not support chmod */
  }
  return path;
}

export interface DevinCliConfig {
  permissions: {
    allow: string[];
    deny: string[];
  };
}

export function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildDevinReadOnlyConfig(): DevinCliConfig {
  return {
    permissions: {
      allow: [
        'read',
        'grep',
        'glob',
        'Read(**)',
        'Exec(git status)',
        'Exec(git diff)',
        'Exec(git log)',
        'Exec(git show)',
        'Exec(git grep)',
        'Exec(git ls-files)',
        'Exec(git rev-parse)',
        'Exec(git merge-base)',
      ],
      deny: ['edit', 'write', 'Write(**)', 'Write(/**)'],
    },
  };
}
