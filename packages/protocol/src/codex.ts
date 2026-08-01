import {
  chmodSync,
  copyFileSync,
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

/** Everything the run home holds that does not vary per spawn. */
const RUN_CONFIG = 'sandbox_mode = "read-only"\n';

/** Windows creates file symlinks only for an admin or under Developer Mode, so
 * codex there keeps the per-spawn copy this replaced — and with it the problem
 * the link solves: a refreshed token lands in the copy, and the next spawn
 * overwrites it from the member's own file. Unchanged from what shipped before;
 * carrying one back needs a hook that runs after the child exits. */
const linkable = process.platform !== 'win32';

/**
 * Whether `link` already stands for `target`, which on a linkable platform is
 * simply whether it points there.
 *
 * The Windows copy needs a different question. Rewriting one a running codex
 * still holds fails the rename outright, and a copy that is newer than the
 * source is one codex refreshed in place — overwriting it would undo that. So
 * only a source that has moved on, which is a re-login, is worth the rewrite.
 */
function isCurrentAuth(link: string, target: string): boolean {
  if (!linkable) {
    const copied = statSync(link, { throwIfNoEntry: false });
    return copied !== undefined && copied.mtimeMs >= statSync(target).mtimeMs;
  }
  return (
    lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() === true &&
    readlinkSync(link) === target
  );
}

/** Puts a file where nobody can catch it half-written: staged, then renamed,
 * which is atomic. The pid is what keeps two companion processes sharing a
 * state dir off each other's staging file. */
function place(path: string, write: (staged: string) => void): void {
  const staged = `${path}.${String(process.pid)}`;
  rmSync(staged, { force: true });
  write(staged);
  renameSync(staged, path);
}

/**
 * Builds the `CODEX_HOME` symma runs codex in, idempotently.
 *
 * It has to outlive the spawn: codex writes its rollout under
 * `$CODEX_HOME/sessions/`, so a home that dies with the run is a session that
 * can never be loaded back. And it has to be symma's rather than the member's,
 * because the read-only config is ours to write and theirs to keep.
 */
export function prepareCodexRunHome(codexHome: string, runHome: string): void {
  const target = codexAuthPath(codexHome);
  // A link to nothing is legal, and codex reports it much later as an auth
  // problem with no hint of where the file was meant to be.
  if (!statSync(target, { throwIfNoEntry: false })) {
    throw new Error(`Missing Codex auth at ${target}.`);
  }
  mkdirSync(runHome, { recursive: true, mode: 0o700 });

  // Linked rather than copied: codex refreshes the token in place, so a copy
  // would strand the refresh here and go stale without saying so. Rewritten
  // only when it points elsewhere, which also migrates a home an older build
  // left a real file in.
  const link = codexAuthPath(runHome);
  if (!isCurrentAuth(link, target)) {
    place(link, (staged) =>
      linkable ? symlinkSync(target, staged) : copyFileSync(target, staged),
    );
  }

  // Compared first, so the steady state writes nothing at all.
  const config = join(runHome, 'config.toml');
  if (!statSync(config, { throwIfNoEntry: false }) || readFileSync(config, 'utf8') !== RUN_CONFIG) {
    place(config, (staged) => writeFileSync(staged, RUN_CONFIG, { mode: 0o600 }));
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
