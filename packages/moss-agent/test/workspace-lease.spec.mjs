#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  AdaptiveWorkspaceLeaseAdapter,
  CopyWorkspaceLeaseAdapter,
  GitWorktreeWorkspaceLeaseAdapter,
} from '../dist/orchestration/index.js';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function createDirtyRepository(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init');
  git(root, 'config', 'user.name', 'Moss Test');
  git(root, 'config', 'user.email', 'moss-test@example.invalid');
  write(path.join(root, '.gitignore'), 'secret.env\nnode_modules/\n');
  write(path.join(root, 'src', 'app.txt'), 'committed\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  write(path.join(root, 'src', 'app.txt'), 'parent dirty\n');
  write(path.join(root, 'src', 'staged.txt'), 'staged\n');
  git(root, 'add', 'src/staged.txt');
  write(path.join(root, 'src', 'untracked.txt'), 'untracked\n');
  write(path.join(root, 'secret.env'), 'ignored-secret\n');
  write(path.join(root, '.env'), 'never-copy\n');
}

test('git worktree lease snapshots dirty tracked, staged, and untracked files without secrets', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-workspace-lease-'));
  const repository = path.join(temp, 'repo');
  const leases = path.join(temp, 'leases');
  createDirtyRepository(repository);
  const adapter = new GitWorktreeWorkspaceLeaseAdapter({ rootDir: leases });
  try {
    const lease = await adapter.create({
      id: 'lease-git',
      graphId: 'graph',
      nodeId: 'implement',
      parentWorkspace: repository,
      writePaths: ['src/'],
    });
    assert.equal(
      fs.readFileSync(path.join(lease.workspacePath, 'src/app.txt'), 'utf8'),
      'parent dirty\n'
    );
    assert.equal(
      fs.readFileSync(path.join(lease.workspacePath, 'src/staged.txt'), 'utf8'),
      'staged\n'
    );
    assert.equal(
      fs.readFileSync(path.join(lease.workspacePath, 'src/untracked.txt'), 'utf8'),
      'untracked\n'
    );
    assert.equal(fs.existsSync(path.join(lease.workspacePath, 'secret.env')), false);
    assert.equal(fs.existsSync(path.join(lease.workspacePath, '.env')), false);

    write(path.join(lease.workspacePath, 'src/app.txt'), 'worker change\n');
    const patch = await adapter.createPatch(lease);
    assert.deepEqual(patch.changedPaths, ['src/app.txt']);
    assert.match(patch.patch, /worker change/);
    assert.match(patch.digest, /^sha256:/);
    assert.equal(fs.readFileSync(patch.artifactRef, 'utf8'), patch.patch);

    const restored = new GitWorktreeWorkspaceLeaseAdapter({ rootDir: leases }).load('lease-git');
    assert.equal(restored?.baseRef, lease.baseRef);
    assert.equal(fs.existsSync(restored.workspacePath), true);
  } finally {
    await adapter.release('lease-git', 'cancelled');
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('adaptive leases select git worktrees with HEAD and copy snapshots otherwise', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-workspace-adaptive-'));
  const repository = path.join(temp, 'repo');
  const plain = path.join(temp, 'plain');
  createDirtyRepository(repository);
  fs.mkdirSync(plain, { recursive: true });
  write(path.join(plain, 'input.txt'), 'plain\n');
  const adapter = new AdaptiveWorkspaceLeaseAdapter({ rootDir: path.join(temp, 'leases') });
  try {
    const gitLease = await adapter.create({
      id: 'adaptive-git',
      graphId: 'graph',
      nodeId: 'git',
      parentWorkspace: repository,
      writePaths: ['src'],
    });
    const copyLease = await adapter.create({
      id: 'adaptive-copy',
      graphId: 'graph',
      nodeId: 'copy',
      parentWorkspace: plain,
      writePaths: ['input.txt'],
    });
    assert.equal(gitLease.kind, 'git-worktree');
    assert.equal(copyLease.kind, 'copy-snapshot');
    assert.deepEqual(
      adapter
        .list()
        .map((lease) => lease.id)
        .sort(),
      ['adaptive-copy', 'adaptive-git']
    );
  } finally {
    await adapter.release('adaptive-git', 'cancelled');
    await adapter.release('adaptive-copy', 'cancelled');
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('guarded merge refuses a parent race and never overwrites the edited file', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-workspace-conflict-'));
  const repository = path.join(temp, 'repo');
  const adapter = new GitWorktreeWorkspaceLeaseAdapter({ rootDir: path.join(temp, 'leases') });
  createDirtyRepository(repository);
  try {
    const lease = await adapter.create({
      id: 'lease-conflict',
      graphId: 'graph',
      nodeId: 'implement',
      parentWorkspace: repository,
      writePaths: ['src/app.txt'],
    });
    write(path.join(lease.workspacePath, 'src/app.txt'), 'worker change\n');
    const patch = await adapter.createPatch(lease);
    write(path.join(repository, 'src/app.txt'), 'user edit after lease\n');

    const merged = await adapter.merge(lease, patch);
    assert.equal(merged.status, 'merge_conflict');
    assert.deepEqual(merged.conflictingPaths, ['src/app.txt']);
    assert.equal(
      fs.readFileSync(path.join(repository, 'src/app.txt'), 'utf8'),
      'user edit after lease\n'
    );
    assert.equal(fs.existsSync(lease.workspacePath), true, 'conflicted lease must be retained');
  } finally {
    await adapter.release('lease-conflict', 'rejected');
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('copy snapshot adapter merges declared changes and rejects undeclared writes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-workspace-copy-'));
  const parent = path.join(temp, 'plain');
  const adapter = new CopyWorkspaceLeaseAdapter({ rootDir: path.join(temp, 'leases') });
  fs.mkdirSync(parent, { recursive: true });
  write(path.join(parent, 'docs', 'input.txt'), 'input\n');
  write(path.join(parent, '.env'), 'never-copy\n');
  try {
    const lease = await adapter.create({
      id: 'lease-copy',
      graphId: 'graph',
      nodeId: 'docs',
      parentWorkspace: parent,
      writePaths: ['docs'],
    });
    assert.equal(fs.existsSync(path.join(lease.workspacePath, '.env')), false);
    write(path.join(lease.workspacePath, 'docs', 'output.txt'), 'generated\n');
    const patch = await adapter.createPatch(lease);
    assert.deepEqual(patch.changedPaths, ['docs/output.txt']);
    const merged = await adapter.merge(lease, patch);
    assert.equal(merged.status, 'merged');
    assert.equal(fs.readFileSync(path.join(parent, 'docs/output.txt'), 'utf8'), 'generated\n');

    const unsafe = await adapter.create({
      id: 'lease-unsafe',
      graphId: 'graph',
      nodeId: 'docs',
      parentWorkspace: parent,
      writePaths: ['docs'],
    });
    write(path.join(unsafe.workspacePath, 'outside.txt'), 'not declared\n');
    await assert.rejects(() => adapter.createPatch(unsafe), /outside declared write paths/);
    await adapter.release('lease-unsafe', 'rejected');
  } finally {
    await adapter.release('lease-copy', 'merged');
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('workspace patches reject secret paths even under a root write lease', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-workspace-secret-'));
  const parent = path.join(temp, 'plain');
  const adapter = new CopyWorkspaceLeaseAdapter({ rootDir: path.join(temp, 'leases') });
  fs.mkdirSync(parent, { recursive: true });
  write(path.join(parent, 'safe.txt'), 'safe\n');
  try {
    const lease = await adapter.create({
      id: 'lease-secret',
      graphId: 'graph',
      nodeId: 'work',
      parentWorkspace: parent,
      writePaths: ['.'],
    });
    write(path.join(lease.workspacePath, '.env'), 'secret\n');
    await assert.rejects(() => adapter.createPatch(lease), /excluded secret or runtime paths/);
  } finally {
    await adapter.release('lease-secret', 'rejected');
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('host merge authorization runs before the parent workspace is mutated', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-workspace-approval-'));
  const parent = path.join(temp, 'plain');
  let authorizationCalls = 0;
  const adapter = new CopyWorkspaceLeaseAdapter({
    rootDir: path.join(temp, 'leases'),
    authorizeMerge(request) {
      authorizationCalls += 1;
      assert.deepEqual(request.changedPaths, ['safe.txt']);
      throw new Error('approval denied');
    },
  });
  fs.mkdirSync(parent, { recursive: true });
  write(path.join(parent, 'safe.txt'), 'before\n');
  try {
    const lease = await adapter.create({
      id: 'lease-denied',
      graphId: 'graph',
      nodeId: 'work',
      parentWorkspace: parent,
      writePaths: ['safe.txt'],
    });
    write(path.join(lease.workspacePath, 'safe.txt'), 'after\n');
    const patch = await adapter.createPatch(lease);
    await assert.rejects(() => adapter.merge(lease, patch), /approval denied/);
    assert.equal(authorizationCalls, 1);
    assert.equal(fs.readFileSync(path.join(parent, 'safe.txt'), 'utf8'), 'before\n');
  } finally {
    await adapter.release('lease-denied', 'rejected');
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
