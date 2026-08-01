import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

/** Everything the run home holds that does not vary per spawn. The model does,
 * and rides `CODEX_CONFIG` instead — see `codexAcpSpec`. */
const RUN_CONFIG = 'sandbox_mode = "read-only"\n';

/**
 * Builds the `CODEX_HOME` symma runs codex in, idempotently.
 *
 * It has to outlive the spawn: codex writes its rollout under
 * `$CODEX_HOME/sessions/`, so a home that dies with the run is a session that
 * can never be loaded back. And it has to be symma's rather than the member's,
 * because the read-only config below is ours to write and theirs to keep.
 */
export function prepareCodexRunHome(codexHome: string, runHome: string): void {
  const target = codexAuthPath(codexHome);
  // Fail here rather than leave a link to nothing, which codex reports much
  // later as an auth problem with no hint of where the file was meant to be.
  if (!statSync(target, { throwIfNoEntry: false })) {
    throw new Error(`Missing Codex auth at ${target}.`);
  }
  mkdirSync(runHome, { recursive: true, mode: 0o700 });

  // Linked rather than copied: codex refreshes the token in place, and a copy
  // would go stale without ever saying so. Touched only when it points
  // somewhere else, which also replaces the real file older builds left here.
  const link = codexAuthPath(runHome);
  if (
    !lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() ||
    readlinkSync(link) !== target
  ) {
    rmSync(link, { force: true });
    symlinkSync(target, link);
  }

  // Compared before writing, and renamed into place when it is written: two
  // sessions can spawn at once, and a config.toml one of them catches
  // mid-write is a sandbox that silently is not there.
  const config = join(runHome, 'config.toml');
  if (!statSync(config, { throwIfNoEntry: false }) || readFileSync(config, 'utf8') !== RUN_CONFIG) {
    const staged = `${config}.staging`;
    writeFileSync(staged, RUN_CONFIG, { mode: 0o600 });
    renameSync(staged, config);
  }
}

/**
 * Child env with the run `CODEX_HOME`. The api-key/access-token envs are stripped
 * because Codex ranks them ABOVE auth.json — an ambient `OPENAI_API_KEY` would
 * silently switch the run to per-token API billing instead of the subscription.
 */
export function codexEnvForHome(codexHome: string | undefined): NodeJS.ProcessEnv {
  const home = codexHome?.trim();
  if (!home) {
    throw new Error('Missing Codex home. A CODEX_HOME is required for auth.');
  }
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CODEX_ACCESS_TOKEN;
  return env;
}
