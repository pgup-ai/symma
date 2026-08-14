/**
 * The login service that brings the companion back after a reboot or a crash.
 *
 * A *user* service on both platforms, which is load-bearing rather than a
 * packaging detail (§3): the agents run on this machine's ambient auth — kilo's
 * `auth.json`, `~/.codex`, the login keychain — and a root daemon starting
 * before login can read none of it. So the companion runs while its owner is
 * logged in, and stops when they log out.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface LoginService {
  path: string;
  contents: string;
  /** Where the service sends the companion's output. Nothing rotates it: this
   * logs an attach, a detach and a line per turn, which is kilobytes a week. */
  logPath: string;
  /** What starts it now, in order. Writing the unit is the mechanism, starting
   * it the member's decision — the split §3 already makes for `loginctl
   * enable-linger`. argv rather than shell lines: these are spawned directly,
   * where `gui/$(id -u)` would arrive as four literal characters.
   *
   * Every sequence ends by restarting, so re-running this applies a rewritten
   * unit rather than leaving the old one loaded. A `soft` step is one whose
   * failure is ordinary — launchd cannot unload what was never loaded — and
   * marking them individually is what keeps a real refusal from being
   * swallowed for sitting in the same position. */
  start: { argv: string[]; soft?: boolean }[];
  /** Stops it and forgets it. No step has to succeed: nothing loaded is the
   * ordinary case for an uninstall. */
  stop: string[][];
  /** Exits 0 while the service is *loaded*, which is not the same as running:
   * launchd keeps a job that exited cleanly, and reports it as loaded forever.
   * `isRunning` is what tells the two apart. */
  probe: string[];
  /** Whether what `probe` printed describes a service that is actually up. */
  isRunning: (printed: string) => boolean;
  /** Whether a refused `probe` means there is no such service, as opposed to a
   * supervisor that could not be reached — which is no evidence that nothing
   * is running, and the difference between an uninstall that can tell it left
   * nothing behind and one that assumes so. */
  absent: (code: number | null) => boolean;
}

const LABEL = 'dev.symma.companion';
const UNIT = 'symma-companion';

/** `npx` runs from a cache its package manager may evict, so a unit pointing
 * into one starts failing silently the first time that happens — the member
 * paired successfully and then simply stops coming back after a reboot. Better
 * to write nothing and say which install is durable. */
const EPHEMERAL = /(^|[/\\])(_npx|dlx)([/\\]|$)/;

/** Quoted when it would otherwise split, and `%` doubled always: systemd reads
 * a bare one as a specifier prefix, so a path containing it launches something
 * else or fails to start. */
const systemdArgument = (value: string): string =>
  (/[\s"'\\]/.test(value) ? JSON.stringify(value) : value).replace(/%/g, '%%');

/** `systemdArgument` without the quoting: these directives take the rest of the
 * line, so a quoted path would be read with the quotes in it. */
const systemdPath = (value: string): string => value.replace(/%/g, '%%');

const xml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Undefined where there is no user service to write — Windows today, which
 * runs the companion but not across a reboot. */
export function loginService(
  platform: NodeJS.Platform,
  home: string,
  command: string[],
  uid: number,
): LoginService | undefined {
  const logPath = join(home, '.local', 'share', 'symma-companion', 'companion.log');
  if (platform === 'darwin') {
    const path = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const domain = `gui/${String(uid)}`;
    return {
      path,
      logPath,
      start: [
        // Soft: nothing loaded is the ordinary first install, and bootout says
        // so with a failure. The bootstrap after it is not allowed to fail —
        // that one is the whole of whether the service is now running.
        { argv: ['launchctl', 'bootout', `${domain}/${LABEL}`], soft: true },
        { argv: ['launchctl', 'bootstrap', domain, path] },
      ],
      stop: [['launchctl', 'bootout', `${domain}/${LABEL}`]],
      probe: ['launchctl', 'print', `${domain}/${LABEL}`],
      // Live-probed rather than assumed: a job that exited cleanly prints
      // `state = spawn scheduled` and still exits 0, so the exit code alone
      // reports a crash-looping companion as healthy.
      isRunning: (printed) => /^\s*state = running$/m.test(printed),
      // Live-probed against launchd (macOS 15): `print` answers 113 for a label
      // it does not hold, and 0 for one it does. Anything else is launchd
      // itself refusing, which says nothing about the companion.
      absent: (code) => code === 113,
      // RunAtLoad covers the reboot, KeepAlive the crash. The lid is neither
      // (§3) — a closed laptop is not running anything to supervise.
      contents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${command.map((argument) => `      <string>${xml(argument)}</string>`).join('\n')}
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
    <key>StandardOutPath</key><string>${xml(logPath)}</string>
    <key>StandardErrorPath</key><string>${xml(logPath)}</string>
  </dict>
</plist>
`,
    };
  }
  if (platform === 'linux') {
    return {
      path: join(home, '.config', 'systemd', 'user', `${UNIT}.service`),
      logPath,
      start: [
        // None soft. A rewritten unit is not read until the reload, `restart`
        // is what makes the running process the one the file now describes,
        // and a refused `enable` is a companion that works until the next
        // logout and never comes back — silence there is the failure worth
        // catching most.
        { argv: ['systemctl', '--user', 'daemon-reload'] },
        { argv: ['systemctl', '--user', 'enable', UNIT] },
        { argv: ['systemctl', '--user', 'restart', UNIT] },
      ],
      stop: [['systemctl', '--user', 'disable', '--now', UNIT]],
      probe: ['systemctl', '--user', 'is-active', '--quiet', UNIT],
      // `is-active` is already the question, so the exit code is the answer.
      isRunning: () => true,
      // systemd's documented codes for inactive and no-such-unit — not probed
      // live, unlike launchd's above. What matters is which codes are excluded:
      // an unreachable user bus answers 1, which is the case this exists for
      // and is common over SSH without a session.
      absent: (code) => code === 3 || code === 4,
      // Staying up past logout needs `loginctl enable-linger`, which §3 keeps
      // as the member's opt-in rather than a default outliving their session.
      contents: `[Unit]
Description=symma companion

[Service]
ExecStart=${command.map(systemdArgument).join(' ')}
Restart=on-failure
RestartSec=5
StandardOutput=append:${systemdPath(logPath)}
StandardError=append:${systemdPath(logPath)}

[Install]
WantedBy=default.target
`,
    };
  }
  return undefined;
}

/** Writes the unit and returns what to tell the member, and whether it is now
 * the unit on disk — a caller about to start it needs to know that it wrote,
 * not merely that a file is there, or a rewrite that failed over an older one
 * starts exactly what it was replacing. A failure is reported, never thrown:
 * the pairing it follows already succeeded, and losing that to a supervision
 * file would be worse than starting the companion by hand. */
export function installLoginService(
  platform: NodeJS.Platform,
  home: string,
  command: string[],
  uid: number,
): { written: boolean; lines: string[] } {
  const service = loginService(platform, home, command, uid);
  if (!service) return { written: false, lines: [] };
  if (command.some((argument) => EPHEMERAL.test(argument))) {
    return {
      written: false,
      lines: [
        'Not installing a login service: this ran from a temporary npx cache,',
        'which is deleted eventually. `npm i -g symma`, then pair again.',
      ],
    };
  }
  try {
    // Before the unit, so a failure here leaves nothing behind: the service
    // opens the log itself and will not create the directory it sits in —
    // absent, launchd fails the job rather than the write. `0700` because this
    // is the same directory the pairing and the signing key live in, and a
    // umask is not an access decision — chmod'd as well as created with it,
    // since the mode argument does nothing to a directory already there.
    mkdirSync(dirname(service.logPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(service.logPath), 0o700);
    mkdirSync(dirname(service.path), { recursive: true });
    writeFileSync(service.path, service.contents, { mode: 0o644 });
  } catch (error) {
    return {
      written: false,
      lines: [
        `Could not write ${service.path}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  return {
    written: true,
    lines: [`Starts at login from ${service.path}`, 'Start it now:  symma install'],
  };
}
