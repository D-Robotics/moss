/**
 * O79: mutating runGit (worktree add, add -A -N, apply --3way) must not run
 * untrusted repo filter/merge drivers.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createWorktree,
  collectWorktreePatch,
  applyWorktreePatch,
  cleanupWorktree,
} from '../dist/core/subagent/worktree-isolation.js';
import { runGit } from '../dist/utils/git-spawn.js';

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, stdio: 'ignore', ...opts });
}

async function markerWritten(marker) {
  try {
    const text = await fs.readFile(marker, 'utf8');
    return text.includes('ran');
  } catch {
    return false;
  }
}

describe('O79 worktree isolation git exec', { concurrency: 1 }, () => {
  test('createWorktree does not run untrusted filter.smudge', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-o79-smudge-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    const marker = path.join(root, 'SMUDGE_RAN');
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'o79@example.test']);
    git(repo, ['config', 'user.name', 'o79']);
    await fs.writeFile(path.join(repo, '.gitattributes'), '*.txt filter=pwn\n');
    await fs.writeFile(path.join(repo, 'a.txt'), 'hello\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);
    const cmd = `sh -c 'echo ran >> "${marker.replace(/\\/g, '/')}"; cat'`;
    git(repo, ['config', 'filter.pwn.smudge', cmd]);
    git(repo, ['config', 'filter.pwn.clean', 'cat']);

    const probe = path.join(root, 'probe');
    git(repo, ['worktree', 'add', '-q', '--detach', probe, 'HEAD']);
    assert.equal(await markerWritten(marker), true, 'fixture: plain worktree add runs smudge');
    await fs.rm(marker, { force: true });
    git(repo, ['worktree', 'remove', '--force', probe]);

    const lease = await createWorktree({ parentWorkspace: repo, runId: 'o79-smudge' });
    t.after(() => cleanupWorktree({ parentWorkspace: repo, worktreePath: lease.worktreePath }));
    assert.equal(await markerWritten(marker), false, 'createWorktree ran untrusted smudge');
  });

  test('collectWorktreePatch add -A -N path does not run filter.clean', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-o79-clean-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    const marker = path.join(root, 'CLEAN_RAN');
    const script = path.join(root, 'clean.sh');
    await fs.writeFile(script, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\ncat\n`);
    await fs.chmod(script, 0o755);

    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'o79@example.test']);
    git(repo, ['config', 'user.name', 'o79']);
    await fs.writeFile(path.join(repo, '.gitattributes'), '*.txt filter=pwn\n');
    await fs.writeFile(path.join(repo, 'a.txt'), 'hello\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);
    git(repo, ['config', 'filter.pwn.clean', script]);
    git(repo, ['config', 'filter.pwn.smudge', 'cat']);
    git(repo, ['config', 'filter.pwn.required', 'true']);

    await fs.writeFile(path.join(repo, 'a.txt'), 'hello\nchanged\n');
    const future = new Date(Date.now() + 10_000);
    await fs.utimes(path.join(repo, 'a.txt'), future, future);
    await fs.rm(marker, { force: true });
    git(repo, ['add', '-A']);
    assert.equal(await markerWritten(marker), true, 'fixture: raw git add -A runs clean');
    git(repo, ['reset', '-q']);
    await fs.rm(marker, { force: true });

    const lease = await createWorktree({ parentWorkspace: repo, runId: 'o79-clean' });
    t.after(() => cleanupWorktree({ parentWorkspace: repo, worktreePath: lease.worktreePath }));
    await fs.writeFile(path.join(lease.worktreePath, 'a.txt'), 'hello\nlease\n');
    await fs.utimes(path.join(lease.worktreePath, 'a.txt'), future, future);
    await fs.rm(marker, { force: true });

    await collectWorktreePatch({ parentWorkspace: repo, lease });
    assert.equal(
      await markerWritten(marker),
      false,
      'collectWorktreePatch (add -A -N) ran untrusted clean'
    );

    // Same hardening entry point as add -A -N: mutating runGit must blank
    // filter.clean. Plain `git add -A` runs clean; prove overrides apply.
    await fs.writeFile(path.join(lease.worktreePath, 'a.txt'), 'hello\nlease2\n');
    await fs.utimes(path.join(lease.worktreePath, 'a.txt'), future, future);
    await fs.rm(marker, { force: true });
    await runGit(['add', '-A'], { cwd: lease.worktreePath, readOnly: false, timeout: 60_000 });
    assert.equal(await markerWritten(marker), false, 'mutating runGit add -A ran untrusted clean');
  });

  test('applyWorktreePatch --3way does not run untrusted merge driver', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-o79-merge-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    const marker = path.join(root, 'MERGE_RAN');
    const script = path.join(root, 'merge.sh');
    await fs.writeFile(
      script,
      `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\necho driver > "$1"\n`
    );
    await fs.chmod(script, 0o755);

    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'o79@example.test']);
    git(repo, ['config', 'user.name', 'o79']);
    await fs.writeFile(path.join(repo, '.gitattributes'), '*.js merge=pwn\n');
    await fs.writeFile(path.join(repo, 'same.js'), 'value = 0\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);
    git(repo, ['config', 'merge.pwn.driver', `${script} %A`]);
    git(repo, ['config', 'merge.pwn.name', 'pwn']);

    const leaseA = await createWorktree({ parentWorkspace: repo, runId: 'o79-merge-a' });
    const leaseB = await createWorktree({ parentWorkspace: repo, runId: 'o79-merge-b' });
    t.after(async () => {
      await cleanupWorktree({ parentWorkspace: repo, worktreePath: leaseA.worktreePath });
      await cleanupWorktree({ parentWorkspace: repo, worktreePath: leaseB.worktreePath });
    });

    await fs.writeFile(path.join(leaseA.worktreePath, 'same.js'), 'value = 100\n');
    await fs.writeFile(path.join(leaseB.worktreePath, 'same.js'), 'value = 200\n');
    const patchA = await collectWorktreePatch({ parentWorkspace: repo, lease: leaseA });
    const patchB = await collectWorktreePatch({ parentWorkspace: repo, lease: leaseB });

    const first = await applyWorktreePatch({
      parentWorkspace: repo,
      patchPath: patchA.patchPath,
    });
    assert.equal(first.status, 'merged', 'first lease should merge cleanly');

    // Fixture: raw git apply --3way invokes the merge driver on the clash.
    const rawPatch = path.join(root, 'raw-b.patch');
    await fs.copyFile(patchB.patchPath, rawPatch);
    await fs.rm(marker, { force: true });
    try {
      execFileSync('git', ['apply', '--3way', rawPatch], { cwd: repo, stdio: 'ignore' });
    } catch {
      /* conflict or driver rewrite is fine */
    }
    assert.equal(await markerWritten(marker), true, 'fixture: raw apply --3way runs merge driver');
    git(repo, ['reset', '--hard', 'HEAD']);
    // Re-apply first lease so the second apply has a real clash again.
    const reapply = await applyWorktreePatch({
      parentWorkspace: repo,
      patchPath: patchA.patchPath,
    });
    assert.equal(reapply.status, 'merged');

    await fs.rm(marker, { force: true });
    await applyWorktreePatch({ parentWorkspace: repo, patchPath: patchB.patchPath });
    assert.equal(
      await markerWritten(marker),
      false,
      'applyWorktreePatch --3way ran untrusted merge driver'
    );
  });
});
