import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateLegacyWorkspacePaths } from '../dist/utils/workspace-paths.js';

test('migration leaves an external skills symlink and its target untouched', (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-migration-link-'));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  const skills = path.join(workspace, 'skills');
  const learned = path.join(outside, 'learned');
  fs.mkdirSync(workspace);
  fs.mkdirSync(learned, { recursive: true });
  fs.writeFileSync(path.join(learned, 'marker'), 'external');
  try {
    try {
      fs.symlinkSync(outside, skills, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EACCES')) {
        return t.skip('directory symlinks are unavailable');
      }
      throw err;
    }
    const result = migrateLegacyWorkspacePaths(workspace);
    assert.equal(fs.readFileSync(path.join(learned, 'marker'), 'utf8'), 'external');
    assert.ok(fs.lstatSync(skills).isSymbolicLink());
    assert.equal(fs.existsSync(path.join(workspace, '.moss', 'skills', 'learned')), false);
    assert.ok(result.skippedPaths.some((entry) => entry.includes(path.join(skills, 'learned'))));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration records a real permission failure while checking legacy cleanup', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX mode bits are unavailable on Windows');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-migration-cleanup-'));
  const workspace = path.join(root, 'workspace');
  const agent = path.join(workspace, 'agent');
  fs.mkdirSync(path.join(agent, 'skills'), { recursive: true });
  try {
    fs.chmodSync(agent, 0o300);
    try {
      fs.readdirSync(agent);
      return t.skip('current user can still read a directory without read permission');
    } catch (err) {
      if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
    }
    const result = migrateLegacyWorkspacePaths(workspace);
    assert.equal(result.cleanupWarnings.length, 1);
    assert.equal(result.cleanupWarnings[0].path, agent);
    assert.match(result.cleanupWarnings[0].code, /EACCES|EPERM/);
    assert.ok(fs.existsSync(path.join(workspace, '.moss', 'agent', 'skills')));
  } finally {
    fs.chmodSync(agent, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function workspaceFixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-migration-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace };
}

function linkDirectory(t, target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (err) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(err.code)) {
      t.skip('directory symlinks are unavailable');
      return false;
    }
    throw err;
  }
}

for (const linkParts of [['.moss'], ['.moss', 'skills']]) {
  test(`migration does not write through external ${linkParts.join('/')} symlink`, (t) => {
    const { workspace } = workspaceFixture(t);
    // A sibling with a shared string prefix must not count as inside the workspace.
    const outside = `${workspace}-outside`;
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'marker'), 'outside');
    const learned = path.join(workspace, 'skills', 'learned');
    fs.mkdirSync(learned, { recursive: true });
    fs.writeFileSync(path.join(learned, 'marker'), 'legacy');
    const link = path.join(workspace, ...linkParts);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    if (!linkDirectory(t, outside, link)) return;

    const result = migrateLegacyWorkspacePaths(workspace);
    assert.equal(fs.readFileSync(path.join(learned, 'marker'), 'utf8'), 'legacy');
    assert.deepEqual(fs.readdirSync(outside), ['marker']);
    assert.equal(fs.readFileSync(path.join(outside, 'marker'), 'utf8'), 'outside');
    assert.ok(result.skippedPaths.some((entry) => entry.includes(learned)));
  });
}

test('migration supports a symlinked workspace and internal directory symlinks', (t) => {
  const { root, workspace } = workspaceFixture(t);
  const legacy = path.join(workspace, 'legacy');
  const runtime = path.join(workspace, 'runtime');
  const alias = path.join(root, 'workspace-alias');
  fs.mkdirSync(path.join(legacy, 'learned'), { recursive: true });
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(legacy, 'learned', 'marker'), 'inside');
  if (!linkDirectory(t, legacy, path.join(workspace, 'skills'))) return;
  if (!linkDirectory(t, runtime, path.join(workspace, '.moss'))) return;
  if (!linkDirectory(t, workspace, alias)) return;

  const result = migrateLegacyWorkspacePaths(alias);
  assert.equal(
    fs.readFileSync(path.join(runtime, 'skills', 'learned', 'marker'), 'utf8'),
    'inside'
  );
  assert.ok(fs.lstatSync(path.join(workspace, 'skills')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(workspace, '.moss')).isSymbolicLink());
  assert.equal(result.migratedPaths.length, 1);
});

test('migration accepts the operating system temporary path without canonicalizing it first', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-migration-native-'));
  const workspace = path.join(root, 'workspace');
  const learned = path.join(workspace, 'skills', 'learned');
  fs.mkdirSync(learned, { recursive: true });
  fs.writeFileSync(path.join(learned, 'marker'), 'native');
  try {
    const result = migrateLegacyWorkspacePaths(workspace);
    assert.equal(
      fs.readFileSync(path.join(workspace, '.moss', 'skills', 'learned', 'marker'), 'utf8'),
      'native'
    );
    assert.equal(result.migratedPaths.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a legacy directory symlink is preserved rather than moved', (t) => {
  const { workspace } = workspaceFixture(t);
  const target = path.join(workspace, 'linked-candidates');
  const legacy = path.join(workspace, 'skill-candidates');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'marker'), 'inside');
  const linkTarget = process.platform === 'win32' ? target : path.basename(target);
  if (!linkDirectory(t, linkTarget, legacy)) return;

  const result = migrateLegacyWorkspacePaths(workspace);
  assert.ok(fs.lstatSync(legacy).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(legacy, 'marker'), 'utf8'), 'inside');
  assert.equal(fs.existsSync(path.join(workspace, '.moss', 'skills', 'candidates')), false);
  assert.ok(result.skippedPaths.some((entry) => entry.includes(legacy)));
});

for (const side of ['source', 'destination']) {
  test(`migration skips an inaccessible final ${side} symlink without resolving its target`, (t) => {
    if (process.platform === 'win32') return t.skip('POSIX mode bits are unavailable on Windows');
    const { root, workspace } = workspaceFixture(t);
    const outside = path.join(root, 'outside');
    const target = path.join(outside, 'target');
    const learned = path.join(workspace, 'skills', 'learned');
    fs.mkdirSync(target, { recursive: true });
    const link = side === 'source' ? learned : path.join(workspace, '.moss', 'skills', 'learned');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    if (side === 'destination') fs.mkdirSync(learned, { recursive: true });
    fs.symlinkSync(target, link, 'dir');
    try {
      fs.chmodSync(outside, 0o000);
      try {
        fs.realpathSync.native(link);
        return t.skip('current user can still traverse a mode-000 directory');
      } catch (err) {
        if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
      }
      const result = migrateLegacyWorkspacePaths(workspace);
      assert.ok(fs.lstatSync(link).isSymbolicLink());
      assert.ok(result.skippedPaths.some((entry) => entry.includes(learned)));
      if (side === 'destination') assert.ok(fs.statSync(learned).isDirectory());
    } finally {
      fs.chmodSync(outside, 0o700);
    }
  });
}

test('an internal destination alias does not remove the source directory', (t) => {
  const { workspace } = workspaceFixture(t);
  const skills = path.join(workspace, 'skills');
  const learned = path.join(skills, 'learned');
  fs.mkdirSync(learned, { recursive: true });
  fs.mkdirSync(path.join(workspace, '.moss'));
  if (!linkDirectory(t, skills, path.join(workspace, '.moss', 'skills'))) return;

  const result = migrateLegacyWorkspacePaths(workspace);
  assert.ok(fs.statSync(learned).isDirectory());
  assert.ok(result.skippedPaths.some((entry) => entry.includes(learned)));
});

test('dangling destination links do not cause external directories to be created', (t) => {
  if (process.platform === 'win32') return t.skip('dangling directory symlink requires POSIX');
  const { root, workspace } = workspaceFixture(t);
  const learned = path.join(workspace, 'skills', 'learned');
  const outside = path.join(root, 'outside', 'missing');
  fs.mkdirSync(learned, { recursive: true });
  fs.writeFileSync(path.join(learned, 'marker'), 'legacy');
  fs.symlinkSync(outside, path.join(workspace, '.moss'), 'dir');

  const result = migrateLegacyWorkspacePaths(workspace);
  assert.equal(fs.readFileSync(path.join(learned, 'marker'), 'utf8'), 'legacy');
  assert.ok(fs.lstatSync(path.join(workspace, '.moss')).isSymbolicLink());
  assert.equal(fs.existsSync(path.join(root, 'outside')), false);
  assert.ok(result.skippedPaths.some((entry) => entry.includes(learned)));
});

test('dangling legacy links are left in place without traversing their targets', (t) => {
  if (process.platform === 'win32') return t.skip('dangling directory symlink requires POSIX');
  const { root, workspace } = workspaceFixture(t);
  const skills = path.join(workspace, 'skills');
  fs.symlinkSync(path.join(root, 'outside', 'missing'), skills, 'dir');

  const result = migrateLegacyWorkspacePaths(workspace);
  assert.ok(fs.lstatSync(skills).isSymbolicLink());
  assert.equal(fs.existsSync(path.join(root, 'outside')), false);
  assert.ok(result.skippedPaths.some((entry) => entry.includes(skills)));
});

test('ordinary migration merges legacy content without replacing collisions', (t) => {
  const { workspace } = workspaceFixture(t);
  const learned = path.join(workspace, 'skills', 'learned');
  const destination = path.join(workspace, '.moss', 'skills', 'learned');
  const skill = path.join(workspace, 'skills', 'custom');
  fs.mkdirSync(learned, { recursive: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.mkdirSync(skill);
  fs.mkdirSync(path.join(workspace, 'skill-candidates'));
  fs.mkdirSync(path.join(workspace, 'agent', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(learned, 'fresh'), 'fresh');
  fs.writeFileSync(path.join(learned, 'collision'), 'legacy');
  fs.writeFileSync(path.join(destination, 'collision'), 'current');
  fs.writeFileSync(path.join(skill, 'SKILL.md'), 'custom');
  fs.writeFileSync(path.join(workspace, 'skill-candidates', 'marker'), 'candidate');
  fs.writeFileSync(path.join(workspace, 'agent', 'skills', 'marker'), 'agent');

  const result = migrateLegacyWorkspacePaths(workspace);
  assert.equal(fs.readFileSync(path.join(destination, 'fresh'), 'utf8'), 'fresh');
  assert.equal(fs.readFileSync(path.join(destination, 'collision'), 'utf8'), 'current');
  assert.equal(fs.readFileSync(path.join(learned, 'collision'), 'utf8'), 'legacy');
  assert.equal(
    fs.readFileSync(path.join(workspace, '.moss', 'skills', 'custom', 'SKILL.md'), 'utf8'),
    'custom'
  );
  assert.equal(
    fs.readFileSync(path.join(workspace, '.moss', 'skills', 'candidates', 'marker'), 'utf8'),
    'candidate'
  );
  assert.equal(
    fs.readFileSync(path.join(workspace, '.moss', 'agent', 'skills', 'marker'), 'utf8'),
    'agent'
  );
  assert.ok(result.skippedPaths.some((entry) => entry.includes(path.join(learned, 'collision'))));
});

test('an empty workspace creates no migration paths', (t) => {
  const { workspace } = workspaceFixture(t);
  const result = migrateLegacyWorkspacePaths(workspace);
  assert.deepEqual(result.migratedPaths, []);
  assert.deepEqual(result.skippedPaths, []);
  assert.equal(fs.existsSync(path.join(workspace, '.moss')), false);
});

test('a missing workspace remains an empty migration', (t) => {
  const { workspace } = workspaceFixture(t);
  const missing = path.join(workspace, 'missing');
  const result = migrateLegacyWorkspacePaths(missing);
  assert.deepEqual(result.migratedPaths, []);
  assert.deepEqual(result.skippedPaths, []);
  assert.equal(fs.existsSync(missing), false);
});

for (const code of ['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EACCES', 'EPERM', 'EBUSY', 'EIO']) {
  test(`cleanup reports ${code} when it is not a benign race`, (t) => {
    const { workspace } = workspaceFixture(t);
    const agent = path.join(workspace, 'agent');
    fs.mkdirSync(path.join(agent, 'skills'), { recursive: true });
    const original = fs.rmdirSync;
    fs.rmdirSync = function (target, ...args) {
      if (target === agent) {
        const err = new Error(`${code}: synthetic cleanup failure`);
        err.code = code;
        throw err;
      }
      return original.call(this, target, ...args);
    };
    try {
      const result = migrateLegacyWorkspacePaths(workspace);
      if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') {
        assert.deepEqual(result.cleanupWarnings, []);
      } else {
        assert.deepEqual(result.cleanupWarnings, [{ path: agent, code }]);
      }
      assert.ok(fs.existsSync(path.join(workspace, '.moss', 'agent', 'skills')));
    } finally {
      fs.rmdirSync = original;
    }
  });
}
