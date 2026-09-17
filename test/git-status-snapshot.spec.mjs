import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildGitStatusSnapshot } from '../dist/context/git-status-snapshot.js';

test('buildGitStatusSnapshot returns empty outside a git repo', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-nongit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const snap = await buildGitStatusSnapshot(dir);
  assert.equal(snap, '');
});

test('buildGitStatusSnapshot reports clean and dirty trees', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-git-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'moss@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Moss Test'], { cwd: dir, stdio: 'ignore' });
  await fs.writeFile(path.join(dir, 'README.md'), 'hello\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });

  const clean = await buildGitStatusSnapshot(dir);
  assert.match(clean, /Live Git Status/);
  assert.match(clean, /clean/);

  await fs.writeFile(path.join(dir, 'dirty.txt'), 'x\n');
  const dirty = await buildGitStatusSnapshot(dir);
  assert.match(dirty, /uncommitted change/);
  assert.match(dirty, /dirty\.txt/);
  assert.match(dirty, /protect the user's work/);
});
