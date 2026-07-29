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
  /** What starts it now. Writing the unit is the mechanism, enabling it the
   * member's decision — the split §3 already makes for `loginctl
   * enable-linger`. */
  enable: string;
}

const LABEL = 'dev.symma.companion';

const xml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Undefined where there is no user service to write — Windows today, which
 * runs the companion but not across a reboot. */
export function loginService(
  platform: NodeJS.Platform,
  home: string,
  command: string[],
): LoginService | undefined {
  if (platform === 'darwin') {
    const path = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    return {
      path,
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
    <key>KeepAlive</key><true/>
  </dict>
</plist>
`,
      enable: `launchctl bootstrap gui/$(id -u) ${path}`,
    };
  }
  if (platform === 'linux') {
    return {
      path: join(home, '.config', 'systemd', 'user', 'symma-companion.service'),
      // Staying up past logout needs `loginctl enable-linger`, which §3 keeps
      // as the member's opt-in rather than a default outliving their session.
      contents: `[Unit]
Description=symma companion

[Service]
ExecStart=${command.map((argument) => (/[\s"'\\]/.test(argument) ? JSON.stringify(argument) : argument)).join(' ')}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`,
      enable: 'systemctl --user enable --now symma-companion',
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
): string[] {
  const service = loginService(platform, home, command);
  if (!service) return [];
  try {
    mkdirSync(dirname(service.path), { recursive: true });
    writeFileSync(service.path, service.contents, { mode: 0o644 });
  } catch (error) {
    return [
      `Could not write ${service.path}: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  return [`Starts at login from ${service.path}`, `Start it now:  ${service.enable}`];
}
