import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { installLoginService, loginService } from '../src/login-service.js';

const COMMAND = ['/usr/bin/node', '--conditions=symma-source', '/opt/sym ma/index.ts'];

describe('login service', () => {
  it('installs as a user service on macOS, never a daemon', () => {
    const service = loginService('darwin', '/Users/nel', COMMAND);
    assert.ok(service);
    // The directory is the whole security story: a LaunchDaemon starts before
    // login and cannot read the keychain the agents authenticate from.
    assert.equal(service.path, '/Users/nel/Library/LaunchAgents/dev.symma.companion.plist');
    assert.doesNotMatch(service.path, /LaunchDaemons/);
    assert.match(service.enable, /^launchctl bootstrap gui\/\$\(id -u\) /);

    // Reboot and crash, which is all a supervisor can cover — the closed lid
    // is physics, not packaging (§3).
    assert.match(service.contents, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(service.contents, /<key>KeepAlive<\/key><true\/>/);
    for (const argument of COMMAND) {
      assert.ok(service.contents.includes(`<string>${argument}</string>`), argument);
    }
  });

  it('installs as a systemd user unit on Linux, never a system one', () => {
    const service = loginService('linux', '/home/nel', COMMAND);
    assert.ok(service);
    assert.equal(service.path, '/home/nel/.config/systemd/user/symma-companion.service');
    assert.doesNotMatch(service.path, /\/etc\/systemd/);
    assert.match(service.enable, /systemctl --user/);
    assert.match(service.contents, /^Restart=always$/m);
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
    const service = loginService('linux', '/home/nel', ['/opt/100%/node', '--x=50%']);
    assert.ok(service);
    assert.match(service.contents, /^ExecStart=\/opt\/100%%\/node --x=50%%$/m);
  });

  it('escapes a command that would otherwise break the plist', () => {
    const service = loginService('darwin', '/Users/nel', ['/bin/x', '--flag=a&b<c>d']);
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
        const said = installLoginService('darwin', home, ['/usr/bin/node', cache]).join(' ');
        assert.match(said, /Not installing a login service/, cache);
        assert.match(said, /npm i -g symma/, 'and says which install is durable');
      }
      assert.equal(
        existsSync(join(home, 'Library', 'LaunchAgents', 'dev.symma.companion.plist')),
        false,
        'a stale unit is worse than none',
      );
      // A durable install still gets one, or the guard has eaten the feature.
      installLoginService('darwin', home, [
        '/usr/bin/node',
        '/usr/local/lib/node_modules/symma/dist/index.js',
      ]);
      assert.ok(existsSync(join(home, 'Library', 'LaunchAgents', 'dev.symma.companion.plist')));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('has nothing to install where there is no user service', () => {
    assert.equal(loginService('win32', 'C:\\Users\\nel', COMMAND), undefined);
    assert.deepEqual(installLoginService('win32', 'C:\\Users\\nel', COMMAND), []);
  });

  it('writes the unit, and reports rather than throws when it cannot', () => {
    const home = mkdtempSync(join(tmpdir(), 'symma-service-'));
    try {
      const said = installLoginService('darwin', home, COMMAND);
      const path = join(home, 'Library', 'LaunchAgents', 'dev.symma.companion.plist');
      assert.ok(existsSync(path));
      assert.equal(statSync(path).mode & 0o777, 0o644, 'launchd must be able to read it');
      assert.match(readFileSync(path, 'utf8'), /dev\.symma\.companion/);
      assert.ok(
        said.some((line) => line.includes(path)),
        'says where it went',
      );
      assert.ok(
        said.some((line) => line.includes('launchctl bootstrap')),
        'and how to start it now',
      );
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
    const blocked = installLoginService('darwin', blocker, COMMAND);
    assert.equal(blocked.length, 1);
    assert.match(blocked[0]!, /Could not write/);
  });
});
