import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { installLoginService, loginService } from '../src/login-service.js';

const COMMAND = ['/usr/bin/node', '--conditions=symma-source', '/opt/sym ma/index.ts'];

describe('login service', () => {
  it('installs as a user service on macOS, never a daemon', () => {
    const service = loginService('darwin', '/Users/nel', COMMAND, 501);
    assert.ok(service);
    // The directory is the whole security story: a LaunchDaemon starts before
    // login and cannot read the keychain the agents authenticate from.
    assert.equal(service.path, '/Users/nel/Library/LaunchAgents/dev.symma.companion.plist');
    assert.doesNotMatch(service.path, /LaunchDaemons/);
    // The real uid, not `$(id -u)`: these are spawned directly, and a shell
    // substitution reaches launchctl as four literal characters.
    assert.deepEqual(service.start, ['launchctl', 'bootstrap', 'gui/501', service.path]);
    assert.deepEqual(service.stop, ['launchctl', 'bootout', 'gui/501/dev.symma.companion']);

    // Reboot and crash, which is all a supervisor can cover — the closed lid
    // is physics, not packaging (§3).
    assert.match(service.contents, /<key>RunAtLoad<\/key><true\/>/);
    // A deliberate quit stays quit. The companion exits 0 only after sending
    // `goodbye`, which is the whole of how a member is told "quit on your Mac"
    // rather than "asleep" — a supervisor that restarted it would make that
    // sentence a lie about a machine it just brought back.
    assert.match(
      service.contents,
      /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/>/,
    );
    assert.doesNotMatch(service.contents, /<key>KeepAlive<\/key><true\/>/);
    for (const argument of COMMAND) {
      assert.ok(service.contents.includes(`<string>${argument}</string>`), argument);
    }
  });

  it('installs as a systemd user unit on Linux, never a system one', () => {
    const service = loginService('linux', '/home/nel', COMMAND, 1000);
    assert.ok(service);
    assert.equal(service.path, '/home/nel/.config/systemd/user/symma-companion.service');
    assert.doesNotMatch(service.path, /\/etc\/systemd/);
    assert.deepEqual(service.start, ['systemctl', '--user', 'enable', '--now', 'symma-companion']);
    // on-failure, not always, for the reason the plist is not a bare KeepAlive:
    // the goodbye that precedes a clean exit is a member quitting on purpose.
    assert.match(service.contents, /^Restart=on-failure$/m);
    assert.doesNotMatch(service.contents, /^Restart=always$/m);
    // default.target, not multi-user.target: a user unit is wanted by the
    // user's session, and a system target would not start it at all.
    assert.match(service.contents, /^WantedBy=default\.target$/m);
    // The path with a space survives as one argument rather than two.
    assert.match(
      service.contents,
      /^ExecStart=\/usr\/bin\/node --conditions=symma-source "\/opt\/sym ma\/index\.ts"$/m,
    );
  });

  it('doubles a percent systemd would read as a specifier', () => {
    // Bare `%h`, `%n` and friends expand, so a path containing one launches
    // something else or refuses to start.
    const service = loginService('linux', '/home/nel', ['/opt/100%/node', '--x=50%'], 1000);
    assert.ok(service);
    assert.match(service.contents, /^ExecStart=\/opt\/100%%\/node --x=50%%$/m);
  });

  it('escapes a command that would otherwise break the plist', () => {
    const service = loginService('darwin', '/Users/nel', ['/bin/x', '--flag=a&b<c>d'], 501);
    assert.ok(service);
    assert.ok(service.contents.includes('<string>--flag=a&amp;b&lt;c&gt;d</string>'));
    assert.doesNotMatch(service.contents, /a&b<c>d/);
  });

  it('writes nothing when it is running from a cache that will be deleted', () => {
    // `npx symma pair` is the flow the README advertises, and it runs from a
    // directory npm evicts. A unit pointing there fails silently later — the
    // member paired, and then simply stops coming back after a reboot.
    const home = mkdtempSync(join(tmpdir(), 'symma-service-'));
    try {
      for (const cache of [
        '/Users/nel/.npm/_npx/9f2/node_modules/symma/dist/index.js',
        '/Users/nel/Library/Caches/pnpm/dlx/9f2/node_modules/symma/dist/index.js',
      ]) {
        const said = installLoginService('darwin', home, ['/usr/bin/node', cache], 501).join(' ');
        assert.match(said, /Not installing a login service/, cache);
        assert.match(said, /npm i -g symma/, 'and says which install is durable');
      }
      assert.equal(
        existsSync(join(home, 'Library', 'LaunchAgents', 'dev.symma.companion.plist')),
        false,
        'a stale unit is worse than none',
      );
      // A durable install still gets one, or the guard has eaten the feature.
      installLoginService(
        'darwin',
        home,
        ['/usr/bin/node', '/usr/local/lib/node_modules/symma/dist/index.js'],
        501,
      );
      assert.ok(existsSync(join(home, 'Library', 'LaunchAgents', 'dev.symma.companion.plist')));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('sends the output somewhere a member can be pointed at', () => {
    // A hidden process with nowhere to look is one nobody can debug, and
    // `symma status` prints this path — so it is the same one on both.
    const mac = loginService('darwin', '/Users/nel', COMMAND, 501)!;
    assert.equal(mac.logPath, '/Users/nel/.local/share/symma-companion/companion.log');
    assert.ok(mac.contents.includes(`<key>StandardOutPath</key><string>${mac.logPath}</string>`));
    assert.ok(mac.contents.includes(`<key>StandardErrorPath</key><string>${mac.logPath}</string>`));

    const unit = loginService('linux', '/home/nel', COMMAND, 1000)!;
    assert.equal(unit.logPath, '/home/nel/.local/share/symma-companion/companion.log');
    assert.match(unit.contents, /^StandardOutput=append:\/home\/nel\/\.local\/share\//m);

    // The specifier prefix still has to be escaped here, but the quoting
    // `systemdArgument` does must not happen: these directives take the rest of
    // the line, so the quotes would land in the path.
    const odd = loginService('linux', '/home/100% nel', COMMAND, 1000)!;
    assert.match(odd.contents, /^StandardOutput=append:\/home\/100%% nel\/\.local\//m);
    assert.doesNotMatch(odd.contents, /StandardOutput=append:"/);
  });

  it('has nothing to install where there is no user service', () => {
    assert.equal(loginService('win32', 'C:\\Users\\nel', COMMAND, 0), undefined);
    assert.deepEqual(installLoginService('win32', 'C:\\Users\\nel', COMMAND, 0), []);
  });

  it('writes the unit, and reports rather than throws when it cannot', () => {
    const home = mkdtempSync(join(tmpdir(), 'symma-service-'));
    try {
      const said = installLoginService('darwin', home, COMMAND, 501);
      const path = join(home, 'Library', 'LaunchAgents', 'dev.symma.companion.plist');
      assert.ok(existsSync(path));
      assert.equal(statSync(path).mode & 0o777, 0o644, 'launchd must be able to read it');
      assert.match(readFileSync(path, 'utf8'), /dev\.symma\.companion/);
      assert.ok(
        said.some((line) => line.includes(path)),
        'says where it went',
      );
      assert.ok(
        said.some((line) => line.includes('symma install')),
        'and the one command that starts it, not a launchctl incantation',
      );
      // launchd creates the log file but not the directory holding it, and
      // fails the job rather than the write when it is missing.
      assert.ok(existsSync(join(home, '.local', 'share', 'symma-companion')));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }

    // A file it cannot write loses the member a supervisor, not the pairing
    // that just succeeded — so this reports and returns.
    //
    // Blocked with a file where the directory has to go, which is ENOTDIR
    // everywhere. Naming an unwritable system path instead is EPERM on macOS
    // and, under /proc on Linux, a recursive mkdir that never returns at all.
    const blocker = join(mkdtempSync(join(tmpdir(), 'symma-service-')), 'not-a-directory');
    writeFileSync(blocker, '');
    const blocked = installLoginService('darwin', blocker, COMMAND, 501);
    assert.equal(blocked.length, 1);
    assert.match(blocked[0]!, /Could not write/);
  });
});
