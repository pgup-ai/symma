/**
 * The login service that brings the companion back after a reboot or a crash.
 *
 * A *user* service on both platforms, which is load-bearing rather than a
 * packaging detail (§3): the agents run on this machine's ambient auth — kilo's
 * `auth.json`, `~/.codex`, the login keychain — and a root daemon starting
 * before login can read none of it. So the companion runs while its owner is
 * logged in, and stops when they log out.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface LoginService {
  path: string;
  contents: string;
  /** Where the service sends the companion's output. Nothing rotates it: this
   * logs an attach, a detach and a line per turn, which is kilobytes a week. */
  logPath: string;
  /** What starts it now. Writing the unit is the mechanism, starting it the
   * member's decision — the split §3 already makes for `loginctl
   * enable-linger`. argv rather than a shell line: these are spawned directly,
   * where `gui/$(id -u)` would arrive as four literal characters. */
  start: string[];
  stop: string[];
  /** Exits 0 while the service is loaded, whatever it is doing. */
  probe: string[];
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
      start: ['launchctl', 'bootstrap', domain, path],
      stop: ['launchctl', 'bootout', `${domain}/${LABEL}`],
      probe: ['launchctl', 'print', `${domain}/${LABEL}`],
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
      start: ['systemctl', '--user', 'enable', '--now', UNIT],
      stop: ['systemctl', '--user', 'disable', '--now', UNIT],
      probe: ['systemctl', '--user', 'is-active', '--quiet', UNIT],
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

/** Writes the unit and returns what to tell the member. A failure is reported,
 * never thrown: the pairing it follows already succeeded, and losing that to a
 * supervision file would be worse than starting the companion by hand. */
export function installLoginService(
  platform: NodeJS.Platform,
  home: string,
  command: string[],
  uid: number,
): string[] {
  const service = loginService(platform, home, command, uid);
  if (!service) return [];
  if (command.some((argument) => EPHEMERAL.test(argument))) {
    return [
      'Not installing a login service: this ran from a temporary npx cache,',
      'which is deleted eventually. `npm i -g symma`, then pair again.',
    ];
  }
  try {
    mkdirSync(dirname(service.path), { recursive: true });
    writeFileSync(service.path, service.contents, { mode: 0o644 });
    // The service opens the log itself and will not create the directory it
    // sits in — absent, launchd fails the job rather than the write.
    mkdirSync(dirname(service.logPath), { recursive: true });
  } catch (error) {
    return [
      `Could not write ${service.path}: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  return [`Starts at login from ${service.path}`, 'Start it now:  symma install'];
}
