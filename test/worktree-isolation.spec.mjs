#!/usr/bin/env node
/**
 * Worktree isolation for writable sub-agents (v0.15-S2).
 *
 * Locks the lease lifecycle on a real git repository:
 * - two concurrent writers in separate worktrees do not stomp each other, and
 *   both patches merge cleanly back into the parent (git apply --3way)
 * - a same-line collision yields merge_conflict with conflicting paths
 * - mergeLeasePatch rejects digest mismatches and missing leases
 * - cleanup removes the worktree
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  createWorktree,
  collectWorktreePatch,
  applyWorktreePatch,
  mergeLeasePatch,
  cleanupWorktree,
} from '../dist/core/subagent/worktree-isolation.js';

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

async function makeRepo(files) {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'moss-wt-iso-'));
  sh('git', ['init', '-q'], { cwd: dir });
  sh('git', ['config', 'user.email', 't@t'], { cwd: dir });
  sh('git', ['config', 'user.name', 't'], { cwd: dir });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  sh('git', ['add', '-A'], { cwd: dir });
  sh('git', ['commit', '-q', '-m', 'base'], { cwd: dir });
  return dir;
}

// ─── 1. Concurrent writers in worktrees don't stomp; both patches merge ─────
// Changes land in DIFFERENT hunks (far apart in the file) — the realistic
// shape of independent parallel work. Same-hunk edits are a conflict by git
// semantics (covered by case 2 below).

{
  const big = ['// header', 'const version = 1;', ''].join('\n');
  const tail = ['', '// footer', 'module.exports = { version };'].join('\n');
  const body = Array.from({ length: 40 }, (_, i) => `// line ${i + 1}`).join('\n');
  const repo = await makeRepo({ 'shared.js': `${big}${body}${tail}\n` });

  const leaseA = await createWorktree({ parentWorkspace: repo, runId: 'run/writer-a' });
  const leaseB = await createWorktree({ parentWorkspace: repo, runId: 'run/writer-b' });
  assert.notEqual(leaseA.worktreePath, leaseB.worktreePath);

  const fileA = path.join(leaseA.worktreePath, 'shared.js');
  const fileB = path.join(leaseB.worktreePath, 'shared.js');
  fs.writeFileSync(
    fileA,
    fs.readFileSync(fileA, 'utf8').replace('const version = 1;', 'const version = 2;')
  );
  fs.writeFileSync(
    fileB,
    fs
      .readFileSync(fileB, 'utf8')
      .replace('module.exports = { version };', 'module.exports = { version, build: 7 };')
  );

  // Neither worktree sees the other's change (no stomping).
  assert.ok(!fs.readFileSync(fileB, 'utf8').includes('version = 2;'), 'B isolated from A');

  const patchA = await collectWorktreePatch({ parentWorkspace: repo, lease: leaseA });
  const patchB = await collectWorktreePatch({ parentWorkspace: repo, lease: leaseB });
  assert.equal(patchA.empty, false);
  assert.deepEqual(patchA.changedPaths, ['shared.js']);

  const mergedA = await mergeLeasePatch({
    parentWorkspace: repo,
    leaseId: leaseA.leaseId,
    patchId: patchA.patchId,
  });
  assert.equal(mergedA.status, 'merged', 'first patch merges');
  const mergedB = await mergeLeasePatch({
    parentWorkspace: repo,
    leaseId: leaseB.leaseId,
    patchId: patchB.patchId,
  });
  assert.equal(mergedB.status, 'merged', 'second patch merges over the first');
  const finalFile = fs.readFileSync(path.join(repo, 'shared.js'), 'utf8');
  assert.ok(
    finalFile.includes('version = 2;') && finalFile.includes('build: 7'),
    'both writers landed'
  );

  await cleanupWorktree({ parentWorkspace: repo, worktreePath: leaseA.worktreePath });
  await cleanupWorktree({ parentWorkspace: repo, worktreePath: leaseB.worktreePath });
  assert.equal(fs.existsSync(leaseA.worktreePath), false, 'worktree A cleaned');
}

// ─── 2. Same-line collision → merge_conflict with conflicting paths ─────────

{
  const repo = await makeRepo({ 'same.js': 'value = 0\n' });
  const leaseA = await createWorktree({ parentWorkspace: repo, runId: 'run/clash-a' });
  const leaseB = await createWorktree({ parentWorkspace: repo, runId: 'run/clash-b' });
  fs.writeFileSync(path.join(leaseA.worktreePath, 'same.js'), 'value = 100\n');
  fs.writeFileSync(path.join(leaseB.worktreePath, 'same.js'), 'value = 200\n');
  const patchA = await collectWorktreePatch({ parentWorkspace: repo, lease: leaseA });
  const patchB = await collectWorktreePatch({ parentWorkspace: repo, lease: leaseB });
  const mergedA = await mergeLeasePatch({
    parentWorkspace: repo,
    leaseId: leaseA.leaseId,
    patchId: patchA.patchId,
  });
  assert.equal(mergedA.status, 'merged');
  const mergedB = await mergeLeasePatch({
    parentWorkspace: repo,
    leaseId: leaseB.leaseId,
    patchId: patchB.patchId,
  });
  assert.equal(mergedB.status, 'merge_conflict', 'same-line change conflicts');
  assert.ok(mergedB.conflictingPaths.includes('same.js'), mergedB.conflictingPaths.join(','));
  // Recovery: hard-reset the conflicted state (a conflicted lease leaves the
  // parent's index unmerged by design; the model resolves it or resets).
  sh('git', ['reset', '--hard', 'HEAD'], { cwd: repo });
  await cleanupWorktree({ parentWorkspace: repo, worktreePath: leaseA.worktreePath });
  await cleanupWorktree({ parentWorkspace: repo, worktreePath: leaseB.worktreePath });
}

// ─── 3. Digest mismatch and missing lease are rejected ──────────────────────

{
  const repo = await makeRepo({ 'x.js': 'x\n' });
  const lease = await createWorktree({ parentWorkspace: repo, runId: 'run/guard' });
  fs.writeFileSync(path.join(lease.worktreePath, 'x.js'), 'x = 2\n');
  const patch = await collectWorktreePatch({ parentWorkspace: repo, lease });
  const bad = await mergeLeasePatch({
    parentWorkspace: repo,
    leaseId: lease.leaseId,
    patchId: 'deadbeefdeadbeef',
  });
  assert.equal(bad.status, 'merge_conflict');
  assert.ok(String(bad.conflictingPaths[0]).includes('digest mismatch'), 'digest guard message');

  const missing = await mergeLeasePatch({
    parentWorkspace: repo,
    leaseId: 'no-such-lease',
    patchId: patch.patchId,
  });
  assert.equal(missing.status, 'merge_conflict');
  assert.ok(String(missing.conflictingPaths[0]).includes('missing'), 'missing lease message');

  await cleanupWorktree({ parentWorkspace: repo, worktreePath: lease.worktreePath });
}

// ─── 4. applyWorktreePatch is the direct patch surface ──────────────────────

{
  const repo = await makeRepo({ 'new.txt': '' });
  const lease = await createWorktree({ parentWorkspace: repo, runId: 'run/newfile' });
  fs.writeFileSync(path.join(lease.worktreePath, 'brand-new.txt'), 'untracked file\n');
  const patch = await collectWorktreePatch({ parentWorkspace: repo, lease });
  assert.deepEqual(patch.changedPaths, ['brand-new.txt'], 'untracked files are captured');
  const applied = await applyWorktreePatch({ parentWorkspace: repo, patchPath: patch.patchPath });
  assert.equal(applied.status, 'merged');
  assert.ok(fs.existsSync(path.join(repo, 'brand-new.txt')));
  await cleanupWorktree({ parentWorkspace: repo, worktreePath: lease.worktreePath });
}

console.log('[PASS] worktree isolation (parallel writable sub-agents)');
