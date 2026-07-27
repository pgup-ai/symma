import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { deepenUntilBase, fetchWorkspace } from '../src/workspace.js';

describe('deepenUntilBase', () => {
  it('stops at the first depth that reaches the base', async () => {
    const asked: number[] = [];
    // Reachable only after the first deepen, so the second step must not run.
    let reachable = false;
    const failure = await deepenUntilBase(
      () => Promise.resolve(reachable),
      (depth) => {
        asked.push(depth);
        reachable = true;
        return Promise.resolve(undefined);
      },
    );

    assert.equal(failure, undefined);
    assert.deepEqual(asked, [200]);
  });

  it('skips fetching when the initial clone already reached the base', async () => {
    let deepened = false;
    const failure = await deepenUntilBase(
      () => Promise.resolve(true),
      () => {
        deepened = true;
        return Promise.resolve(undefined);
      },
    );

    assert.equal(failure, undefined);
    assert.equal(deepened, false);
  });

  it('reports the limit when no depth reaches it, and surfaces a fetch failure as-is', async () => {
    const exhausted = await deepenUntilBase(
      () => Promise.resolve(false),
      () => Promise.resolve(undefined),
    );
    assert.match(String(exhausted), /more than 1250 commits/);

    // A broken fetch must not be reported as a too-long history.
    const broken = await deepenUntilBase(
      () => Promise.resolve(false),
      () => Promise.resolve('git fetch failed: boom'),
    );
    assert.equal(broken, 'git fetch failed: boom');
  });
});

describe('fetchWorkspace', () => {
  const workspace = () => {
    const dir = mkdtempSync(join(tmpdir(), 'jbot-workspace-test-'));
    return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
  };

  it('runs git off the event loop, so one clone cannot stall other sessions', async () => {
    const { dir, clean } = workspace();
    try {
      // Ordering, not timing: a macrotask queued before the clone has to run
      // BEFORE the clone settles. Under the old spawnSync the clone blocked
      // straight through to its own microtask, landing 'git' first.
      const order: string[] = [];
      setImmediate(() => order.push('tick'));
      await fetchWorkspace(dir, join(dir, 'no-such-repo.git')).then((failure) => {
        order.push('git');
        assert.match(String(failure), /^git clone failed: /);
      });

      assert.deepEqual(order, ['tick', 'git']);
    } finally {
      clean();
    }
  });

  it('stops the clone when its open is cancelled', async () => {
    const { dir, clean } = workspace();
    const origin = mkdtempSync(join(tmpdir(), 'jbot-workspace-origin-'));
    try {
      // A repo that WOULD clone: an implementation that drops the signal
      // succeeds here and returns undefined, so this can only pass when the
      // abort is honoured — a nonexistent path would fail either way.
      execFileSync('git', ['-C', origin, 'init', '-q']);
      execFileSync('git', [
        '-C',
        origin,
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'base',
      ]);

      const failure = await fetchWorkspace(dir, origin, undefined, undefined, AbortSignal.abort());

      // Reported as a failure like any other, so the caller discards the
      // workspace instead of running an agent on an empty directory.
      assert.match(String(failure), /^git clone failed: .*abort/is);
    } finally {
      clean();
      rmSync(origin, { recursive: true, force: true });
    }
  });
});
