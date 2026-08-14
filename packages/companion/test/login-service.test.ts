import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    assert.deepEqual(service.start, [
      // Unloaded first, so the rewritten unit is the one that gets loaded —
      // launchctl bootstraps a file, and re-bootstrapping a loaded job fails.
      // Soft, because nothing loaded is the ordinary first install.
      { argv: ['launchctl', 'bootout', 'gui/501/dev.symma.companion'], soft: true },
      { argv: ['launchctl', 'bootstrap', 'gui/501', service.path] },
    ]);
    assert.deepEqual(service.stop, [['launchctl', 'bootout', 'gui/501/dev.symma.companion']]);

    // Loaded is not running. Live-probed against launchd: a job that exited
    // cleanly prints `state = spawn scheduled` and `launchctl print` still
    // exits 0, so the exit code alone calls a crash-looping companion healthy.
    assert.equal(service.isRunning('\tstate = running\n\tprogram = /usr/bin/node'), true);
    assert.equal(service.isRunning('\tstate = spawn scheduled\n\tlast exit code = 1'), false);
    assert.equal(service.isRunning('\tstate = not running'), false);

    // Live-probed too: `print` answers 113 for a label launchd does not hold.
    // Every other refusal is launchd itself, which is no evidence about the
    // companion — so an uninstall must not read it as nothing to stop.
    assert.equal(service.absent(113), true);
    assert.equal(service.absent(1), false);
    assert.equal(service.absent(null), false);

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
    // daemon-reload before, restart after: without the first systemd serves the
    // unit it already read, and without the last a running companion keeps the
    // definition this install replaced.
    assert.deepEqual(service.start, [
      { argv: ['systemctl', '--user', 'daemon-reload'] },
      { argv: ['systemctl', '--user', 'enable', 'symma-companion'] },
      { argv: ['systemctl', '--user', 'restart', 'symma-companion'] },
    ]);
    // None of them soft. A refused `enable` is a companion that works until the
    // next logout and never comes back, which is the failure silence costs most
    // — and it is not the last step, so a positional rule would swallow it.
    assert.deepEqual(
      service.start.filter((step) => step.soft),
      [],
    );
    // `is-active` asks the question directly, so its exit code is the answer.
    assert.equal(service.isRunning(''), true);
    // Inactive and no-such-unit mean nothing is there; an unreachable user bus
    // answers 1 and means only that systemd could not say.
    assert.equal(service.absent(3), true);
    assert.equal(service.absent(4), true);
    assert.equal(service.absent(1), false);
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
        const done = installLoginService('darwin', home, ['/usr/bin/node', cache], 501);
        assert.equal(done.written, false, cache);
        assert.match(done.lines.join(' '), /Not installing a login service/, cache);
        assert.match(done.lines.join(' '), /npm i -g symma/, 'and says which is durable');
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

  it('replaces a unit an older build left behind', () => {
    // The upgrade path, and the reason `install` never writes conditionally: a
    // machine paired before this build has a unit that restarts on a clean exit
    // and captures nothing, and starting *that* one ships this version's bugs
    // rather than fixing them.
    const home = mkdtempSync(join(tmpdir(), 'symma-service-'));
    try {
      const path = join(home, 'Library', 'LaunchAgents', 'dev.symma.companion.plist');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '<plist><dict><key>KeepAlive</key><true/></dict></plist>');
      installLoginService('darwin', home, COMMAND, 501);
      const written = readFileSync(path, 'utf8');
      assert.doesNotMatch(written, /<key>KeepAlive<\/key><true\/>/);
      assert.match(written, /SuccessfulExit/);
      assert.match(written, /StandardOutPath/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('locks the state directory down before writing anything into it', () => {
    // It holds the pairing and the signing key, so `symma install` reaching it
    // first must not leave it at whatever the umask allows. Written before the
    // unit, so a failure here leaves no unit pointing at a log it cannot open.
    const home = mkdtempSync(join(tmpdir(), 'symma-service-'));
    try {
      // Tightened even where an older build left it open: the mode argument
      // does nothing to a directory that already exists, and this one ends up
      // holding the log launchd captures.
      const state = join(home, '.local', 'share', 'symma-companion');
      mkdirSync(state, { recursive: true, mode: 0o755 });
      installLoginService('darwin', home, COMMAND, 501);
      assert.equal(statSync(state).mode & 0o777, 0o700);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('has nothing to install where there is no user service', () => {
    assert.equal(loginService('win32', 'C:\\Users\\nel', COMMAND, 0), undefined);
    assert.deepEqual(installLoginService('win32', 'C:\\Users\\nel', COMMAND, 0), {
      written: false,
      lines: [],
    });
  });

  it('writes the unit, and reports rather than throws when it cannot', () => {
    const home = mkdtempSync(join(tmpdir(), 'symma-service-'));
    try {
      const done = installLoginService('darwin', home, COMMAND, 501);
      assert.equal(done.written, true);
      const said = done.lines;
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
    // Never `written`, so a caller about to start it does not start whatever
    // the failed rewrite left behind.
    assert.equal(blocked.written, false);
    assert.equal(blocked.lines.length, 1);
    assert.match(blocked.lines[0]!, /Could not write/);
  });
});
