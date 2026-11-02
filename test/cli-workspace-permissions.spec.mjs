import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const nodeModules = path.dirname(path.dirname(require.resolve('undici/package.json')));

// Restrict CLI reads to the build, dependencies and temporary fixtures. In
// particular, startup's ancestor .env search cannot read the user's files.
function runCli(
  root,
  workspace,
  { args = ['-p', 'hello'], lang = 'en', preload, env = {}, configValue = {} } = {}
) {
  const dist = path.join(repo, 'dist');
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify(configValue));
  const result = spawnSync(
    process.execPath,
    [
      '--permission',
      `--allow-fs-read=${dist}`,
      `--allow-fs-read=${nodeModules}`,
      `--allow-fs-read=${path.join(repo, 'package.json')}`,
      `--allow-fs-read=${path.join(repo, 'bin', 'node-version-message.cjs')}`,
      `--allow-fs-read=${root}`,
      `--allow-fs-write=${root}`,
      ...(preload ? ['--require', preload] : []),
      path.join(dist, 'cli.js'),
      '--config-file',
      config,
      '--trust-workspace',
      '--lang',
      lang,
      '-C',
      workspace,
      ...args,
    ],
    {
      cwd: root,
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        LANG: 'C',
        LC_ALL: 'C',
        NO_COLOR: '1',
        MOSS_NO_TUI: '1',
        ...env,
      },
      encoding: 'utf8',
      timeout: 15_000,
    }
  );
  assert.ifError(result.error);
  assert.notEqual(result.status, null, result.stderr);
  return result;
}

function expectEnglishAccessError(result, blockedPath) {
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /Cannot access a workspace path/);
  assert.ok(!result.stderr.includes(blockedPath), result.stderr);
  assert.match(result.stderr, /Check permissions and access restrictions/);
  assert.doesNotMatch(result.stderr, /This looks like a bug|Technical details|\n\s+at /);
}

for (const [phase, args] of [
  ['agent', ['-p', 'hello']],
  ['workspace', ['tasks', 'list']],
  ['config', ['config', 'show']],
]) {
  test(`${phase} startup reports an inaccessible workspace path without a bug stack`, (t) => {
    if (process.platform === 'win32') return t.skip('POSIX mode bits are unavailable on Windows');
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-access-'));
    const workspace = path.join(root, 'workspace');
    const blockedPath = path.join(workspace, 'skills', 'learned');
    fs.mkdirSync(blockedPath, { recursive: true });
    try {
      fs.chmodSync(workspace, 0o000);
      try {
        fs.lstatSync(blockedPath);
        return t.skip('current user can still traverse a mode-000 directory');
      } catch (err) {
        if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
      }
      const result = runCli(root, workspace, { args });
      assert.match(result.stderr, /EACCES|EPERM/);
      expectEnglishAccessError(result, blockedPath);
    } finally {
      fs.chmodSync(workspace, 0o700);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('an inaccessible subdirectory is reported in Chinese without exposing its path', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX mode bits are unavailable on Windows');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-subdir-'));
  const workspace = path.join(root, 'workspace');
  const skills = path.join(workspace, 'skills');
  const blockedPath = path.join(skills, 'learned');
  fs.mkdirSync(blockedPath, { recursive: true });
  try {
    fs.chmodSync(skills, 0o000);
    try {
      fs.lstatSync(blockedPath);
      return t.skip('current user can still traverse a mode-000 directory');
    } catch (err) {
      if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
    }
    const result = runCli(root, workspace, { lang: 'zh' });
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /无法访问某个工作区路径/);
    assert.ok(!result.stderr.includes(blockedPath), result.stderr);
    assert.match(result.stderr, /检查工作区路径及其父目录的权限和访问限制/);
    assert.doesNotMatch(result.stderr, /工作区根目录|看起来像是一个 bug|技术细节|\n\s+at /);
  } finally {
    fs.chmodSync(skills, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeLstatFailure(root, target, code, message) {
  const preload = path.join(root, 'lstat-failure.cjs');
  fs.writeFileSync(
    preload,
    `const fs = require('node:fs');
const lstat = fs.lstatSync;
fs.lstatSync = function (target, ...args) {
  if (target === ${JSON.stringify(target)}) {
    const err = new Error(${JSON.stringify(message)});
    err.code = ${JSON.stringify(code)};
    throw err;
  }
  return lstat.call(this, target, ...args);
};\n`
  );
  return preload;
}

test('EPERM during migration is reported without exposing its path', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-eperm-'));
  const workspace = path.join(root, 'workspace');
  const blockedPath = path.join(workspace, 'skills', 'learned');
  fs.mkdirSync(workspace);
  try {
    const preload = writeLstatFailure(
      root,
      blockedPath,
      'EPERM',
      `EPERM: operation not permitted, lstat '${blockedPath}'`
    );
    const result = runCli(root, workspace, { preload });
    assert.match(result.stderr, /EPERM/);
    expectEnglishAccessError(result, blockedPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unexpected migration failure still reports a bug even if its message mentions EACCES', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-bug-'));
  const workspace = path.join(root, 'workspace');
  const blockedPath = path.join(workspace, 'skills', 'learned');
  fs.mkdirSync(workspace);
  try {
    const preload = writeLstatFailure(root, blockedPath, 'EIO', 'unexpected EACCES text');
    const result = runCli(root, workspace, { preload });
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /unexpected EACCES text/);
    assert.match(result.stderr, /This looks like a bug/);
    assert.doesNotMatch(result.stderr, /Cannot access a workspace path/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an EACCES code alone does not disguise a programming failure', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-bug-code-'));
  const workspace = path.join(root, 'workspace');
  const target = path.join(workspace, 'skills', 'learned');
  fs.mkdirSync(workspace);
  try {
    const preload = writeLstatFailure(root, target, 'EACCES', 'synthetic programming failure');
    const result = runCli(root, workspace, { args: ['config', 'show'], preload });
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /synthetic programming failure/);
    assert.match(result.stderr, /This looks like a bug/);
    assert.doesNotMatch(result.stderr, /Cannot access a workspace path/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI migration skips an external skills link without modifying its target', (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-external-link-'));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  const skills = path.join(workspace, 'skills');
  const learned = path.join(outside, 'learned');
  fs.mkdirSync(workspace);
  fs.mkdirSync(learned, { recursive: true });
  fs.writeFileSync(path.join(learned, 'marker'), 'outside');
  try {
    try {
      fs.symlinkSync(outside, skills, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(err.code)) {
        return t.skip('directory symlinks are unavailable');
      }
      throw err;
    }
    const result = runCli(root, workspace, { args: ['config', 'show'] });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /some legacy skill entries were not migrated/i);
    assert.ok(!result.stderr.includes(workspace), result.stderr);
    assert.match(result.stderr, /may not load/i);
    assert.match(result.stderr, /keep|move|copy/i);
    assert.match(result.stderr, /skill-candidates/);
    assert.doesNotMatch(result.stdout, /legacy skill entries were not migrated/i);
    assert.equal(fs.readFileSync(path.join(learned, 'marker'), 'utf8'), 'outside');
    assert.ok(fs.lstatSync(skills).isSymbolicLink());
    assert.equal(fs.existsSync(path.join(workspace, '.moss', 'skills', 'learned')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI warns and continues when old-directory cleanup cannot be checked', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX mode bits are unavailable on Windows');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-cleanup-'));
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
    const result = runCli(root, workspace, { args: ['config', 'show'] });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /could not be checked or cleaned/i);
    assert.ok(!result.stderr.includes(agent), result.stderr);
    assert.match(result.stderr, /may still exist/i);
    assert.doesNotMatch(result.stderr, /This looks like a bug|deleted successfully/i);
    assert.ok(fs.existsSync(path.join(workspace, '.moss', 'agent', 'skills')));
    const next = runCli(root, workspace, { args: ['config', 'show'] });
    assert.equal(next.status, 0, next.stderr);
    assert.doesNotMatch(next.stderr, /could not be checked or cleaned/i);
  } finally {
    fs.chmodSync(agent, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI leaves an already-empty legacy directory without retrying unnecessary cleanup', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX mode bits are unavailable on Windows');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-empty-'));
  const workspace = path.join(root, 'workspace');
  const agent = path.join(workspace, 'agent');
  const legacy = path.join(agent, 'skills');
  fs.mkdirSync(legacy, { recursive: true });
  fs.mkdirSync(path.join(workspace, '.moss', 'agent', 'skills'), { recursive: true });
  try {
    fs.chmodSync(agent, 0o500);
    try {
      fs.accessSync(agent, fs.constants.W_OK);
      return t.skip('current user can still write to a mode-500 directory');
    } catch (err) {
      if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
    }
    for (let run = 0; run < 2; run += 1) {
      const result = runCli(root, workspace, { args: ['config', 'show'] });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /could not be checked or cleaned/i);
      assert.ok(fs.statSync(legacy).isDirectory());
    }
  } finally {
    fs.chmodSync(agent, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI still fails when moving legacy data is denied', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX mode bits are unavailable on Windows');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-move-'));
  const workspace = path.join(root, 'workspace');
  const source = path.join(workspace, 'skill-candidates');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(path.join(workspace, '.moss', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(source, 'marker'), 'legacy');
  try {
    fs.chmodSync(workspace, 0o500);
    try {
      fs.accessSync(workspace, fs.constants.W_OK);
      return t.skip('current user can still write to a mode-500 directory');
    } catch (err) {
      if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
    }
    const result = runCli(root, workspace, { args: ['config', 'show'] });
    assert.match(result.stderr, /EACCES|EPERM/);
    expectEnglishAccessError(result, source);
    assert.doesNotMatch(result.stderr, /could not be checked or cleaned/i);
    assert.equal(fs.readFileSync(path.join(source, 'marker'), 'utf8'), 'legacy');
    assert.equal(fs.existsSync(path.join(workspace, '.moss', 'skills', 'candidates')), false);
  } finally {
    fs.chmodSync(workspace, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI still fails when legacy data cannot be read for a merge', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX mode bits are unavailable on Windows');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-read-'));
  const workspace = path.join(root, 'workspace');
  const source = path.join(workspace, 'agent', 'skills');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(path.join(workspace, '.moss', 'agent', 'skills'), { recursive: true });
  try {
    fs.chmodSync(source, 0o300);
    try {
      fs.readdirSync(source);
      return t.skip('current user can still read a directory without read permission');
    } catch (err) {
      if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
    }
    const result = runCli(root, workspace, { args: ['config', 'show'] });
    assert.match(result.stderr, /EACCES|EPERM/);
    expectEnglishAccessError(result, source);
    assert.doesNotMatch(result.stderr, /could not be checked or cleaned/i);
    assert.ok(fs.statSync(source).isDirectory());
  } finally {
    fs.chmodSync(source, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI fails when a non-permission error prevents a legacy move', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-move-eio-'));
  const workspace = path.join(root, 'workspace');
  const source = path.join(workspace, 'skill-candidates');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'marker'), 'legacy');
  const preload = path.join(root, 'move-failure.cjs');
  fs.writeFileSync(
    preload,
    `const fs = require('node:fs');
const rename = fs.renameSync;
fs.renameSync = function (from, ...args) {
  if (from === ${JSON.stringify(source)}) {
    const err = new Error('EIO: synthetic migration failure');
    err.code = 'EIO';
    throw err;
  }
  return rename.call(this, from, ...args);
};\n`
  );
  try {
    const result = runCli(root, workspace, { args: ['config', 'show'], preload });
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /EIO: synthetic migration failure/);
    assert.match(result.stderr, /This looks like a bug/);
    assert.doesNotMatch(result.stderr, /could not be checked or cleaned/i);
    assert.equal(fs.readFileSync(path.join(source, 'marker'), 'utf8'), 'legacy');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI reports recognized migration EIO without exposing its message or path', (t) => {
  if (process.platform === 'win32') return t.skip('control characters are not valid Windows paths');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-fs-eio-'));
  const secret = 'sk-syntheticFilesystemSecret123456';
  const split = `${secret.slice(0, 12)}\x1b[31m${secret.slice(12)}\x1b[0m`;
  const workspace = path.join(root, `workspace-${split}-الرابط`);
  const agent = path.join(workspace, 'agent');
  fs.mkdirSync(path.join(agent, 'skills'), { recursive: true });
  const preload = path.join(root, 'filesystem-eio.cjs');
  fs.writeFileSync(
    preload,
    `const fs = require('node:fs');
const lstat = fs.lstatSync;
fs.lstatSync = function (target, ...args) {
  if (target === ${JSON.stringify(agent)}) {
    const err = new Error(${JSON.stringify(`EIO: ${secret} \x1b[31m`)});
    err.code = 'EIO';
    err.errno = -5;
    err.syscall = 'lstat';
    err.path = target;
    throw err;
  }
  return lstat.call(this, target, ...args);
};\n`
  );
  try {
    const result = runCli(root, workspace, {
      args: ['config', 'show'],
      preload,
      env: { MOSS_TEST_SECRET: secret },
    });
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /workspace filesystem error/i);
    assert.match(result.stderr, /check.*filesystem/i);
    assert.match(result.stderr, /may already have completed/i);
    assert.ok(!result.stderr.includes(workspace), result.stderr);
    assert.ok(!result.stderr.includes(secret), result.stderr);
    assert.ok(!result.stderr.includes(secret.slice(12)), result.stderr);
    assert.ok(!result.stderr.includes(String.fromCodePoint(0x1b)), result.stderr);
    assert.ok(!result.stderr.includes('الرابط'), result.stderr);
    assert.doesNotMatch(result.stderr, /This looks like a bug|Technical details|\n\s+at /);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI reports a real symlink-loop filesystem error without a stack', (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-fs-loop-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  try {
    try {
      fs.symlinkSync('skills', path.join(workspace, 'skills'), 'dir');
    } catch (err) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(err.code)) {
        return t.skip('directory symlinks are unavailable');
      }
      throw err;
    }
    const result = runCli(root, workspace, { args: ['config', 'show'] });
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /workspace filesystem error/i);
    assert.ok(!result.stderr.includes(workspace), result.stderr);
    assert.doesNotMatch(result.stderr, /This looks like a bug|Technical details|\n\s+at /);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createCollision(workspace) {
  const source = path.join(workspace, 'skill-candidates', 'same');
  const dest = path.join(workspace, '.moss', 'skills', 'candidates', 'same');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(source, 'old');
  fs.writeFileSync(dest, 'current');
  return { source, dest };
}

for (const [phase, args] of [
  ['config', ['config', 'show']],
  ['workspace', ['tasks', 'list']],
  ['agent', ['--quiet', '-p', 'hello']],
]) {
  for (const lang of ['en', 'zh']) {
    test(`CLI ${phase} startup reports collisions in ${lang} on stderr`, () => {
      const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-collision-'));
      const workspace = path.join(root, 'workspace');
      const { source, dest } = createCollision(workspace);
      try {
        const result = runCli(root, workspace, { args, lang });
        if (phase !== 'agent') assert.equal(result.status, 0, result.stderr);
        assert.ok(!result.stderr.includes(source), result.stderr);
        assert.ok(!result.stderr.includes(dest), result.stderr);
        if (lang === 'zh') {
          assert.match(result.stderr, /部分旧技能条目未迁移/);
          assert.match(result.stderr, /保留原状或手动移动、复制/);
          assert.doesNotMatch(result.stdout, /部分旧技能条目未迁移/);
        } else {
          assert.match(result.stderr, /some legacy skill entries were not migrated/i);
          assert.match(result.stderr, /keep entries or manually move or copy/i);
          assert.doesNotMatch(result.stdout, /legacy skill entries were not migrated/i);
        }
        assert.equal(fs.readFileSync(source, 'utf8'), 'old');
        assert.equal(fs.readFileSync(dest, 'utf8'), 'current');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test('CLI keeps JSON stdout parseable when a migration path is skipped', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-json-notice-'));
  const workspace = path.join(root, 'workspace');
  createCollision(workspace);
  try {
    const result = runCli(root, workspace, { args: ['config', 'show', '--json'] });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    assert.match(result.stderr, /legacy skill entries were not migrated/i);
    assert.doesNotMatch(result.stdout, /legacy skill entries were not migrated/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI emits no migration or cleanup notice when nothing was skipped', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-clean-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  try {
    const result = runCli(root, workspace, { args: ['config', 'show'] });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(
      result.stderr,
      /legacy skill entries were not migrated|could not be checked or cleaned/i
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeCleanupFailure(root, target, code) {
  const preload = path.join(root, 'cleanup-failure.cjs');
  fs.writeFileSync(
    preload,
    `const fs = require('node:fs');
const remove = fs.rmdirSync;
fs.rmdirSync = function (target, ...args) {
  if (target === ${JSON.stringify(target)}) {
    const err = new Error('synthetic cleanup failure');
    err.code = ${JSON.stringify(code)};
    throw err;
  }
  return remove.call(this, target, ...args);
};\n`
  );
  return preload;
}

test('CLI reports cleanup errors in Chinese without blocking the command', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-cleanup-zh-'));
  const workspace = path.join(root, 'workspace');
  const agent = path.join(workspace, 'agent');
  fs.mkdirSync(path.join(agent, 'skills'), { recursive: true });
  const preload = writeCleanupFailure(root, agent, 'EBUSY');
  try {
    const result = runCli(root, workspace, { args: ['config', 'show'], lang: 'zh', preload });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /部分旧技能目录无法检查或清理/);
    assert.match(result.stderr, /可能仍然存在/);
    assert.ok(!result.stderr.includes(agent), result.stderr);
    assert.doesNotMatch(result.stdout, /部分旧技能目录无法检查或清理/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI skips untrusted names without exposing known or overlapping secrets', (t) => {
  if (process.platform === 'win32') return t.skip('control characters are not valid Windows paths');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-fixed-notice-'));
  const workspace = path.join(root, 'workspace');
  const auth = 'syntheticAuthUnshaped24680';
  const shortKey = 'sk-abcdefghijklmno123456789';
  const suffix = 'SyntheticTail987654';
  const longKey = `${shortKey}${suffix}`;
  const splitKey = `${longKey.slice(0, 12)}\x1b[31m${longKey.slice(12)}\x1b[0m`;
  const bidi = String.fromCodePoint(0x202e);
  for (const name of [longKey, `${splitKey}-${auth}-${bidi}-الرابط`]) {
    const source = path.join(workspace, 'skill-candidates', name);
    const dest = path.join(workspace, '.moss', 'skills', 'candidates', name);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(source, 'old');
    fs.writeFileSync(dest, 'current');
  }
  try {
    const result = runCli(root, workspace, {
      args: ['config', 'show', '--json'],
      env: { AUTH: auth, SHORT_KEY: shortKey, LONG_KEY: longKey },
      configValue: { apiKeyEnv: 'AUTH' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).apiKeyConfigured, false);
    assert.match(result.stderr, /some legacy skill entries were not migrated/i);
    assert.ok(!result.stderr.includes(auth), result.stderr);
    assert.ok(!result.stderr.includes(suffix), result.stderr);
    assert.ok(!result.stderr.includes('الرابط'), result.stderr);
    assert.ok(!result.stderr.includes(workspace), result.stderr);
    assert.ok(!result.stderr.includes(String.fromCodePoint(0x1b)), result.stderr);
    assert.ok(!result.stderr.includes(bidi), result.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI permission diagnostic does not expose untrusted path contents', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX mode bits are unavailable on Windows');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-fixed-error-'));
  const secret = 'sk-syntheticPermissionSecret123456';
  const split = `${secret.slice(0, 11)}\x1b[31m${secret.slice(11)}\x1b[0m`;
  const workspace = path.join(root, `workspace-${split}-الرابط`);
  const agent = path.join(workspace, 'agent');
  fs.mkdirSync(path.join(agent, 'skills'), { recursive: true });
  try {
    fs.chmodSync(agent, 0o000);
    try {
      fs.lstatSync(path.join(agent, 'skills'));
      return t.skip('current user can still traverse a mode-000 directory');
    } catch (err) {
      if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
    }
    const result = runCli(root, workspace, {
      args: ['tasks', 'list'],
      env: { MOSS_TEST_SECRET: secret },
    });
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /workspace path/i);
    assert.match(result.stderr, /EACCES|EPERM/);
    assert.ok(!result.stderr.includes(workspace), result.stderr);
    assert.ok(!result.stderr.includes(secret.slice(11)), result.stderr);
    assert.ok(!result.stderr.includes('الرابط'), result.stderr);
    assert.ok(!result.stderr.includes(String.fromCodePoint(0x1b)), result.stderr);
    assert.doesNotMatch(result.stderr, /This looks like a bug/);
  } finally {
    fs.chmodSync(agent, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI Chinese permission diagnostic uses fixed text', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-zh-error-'));
  const workspace = path.join(root, 'workspace');
  const target = path.join(workspace, 'skills', 'learned');
  const secret = 'syntheticChineseErrorSecret2468';
  fs.mkdirSync(workspace);
  const preload = writeLstatFailure(root, target, 'EACCES', `EACCES: ${secret}`);
  try {
    const result = runCli(root, workspace, { args: ['tasks', 'list'], lang: 'zh', preload });
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /无法访问某个工作区路径/);
    assert.match(result.stderr, /EACCES/);
    assert.ok(!result.stderr.includes(secret), result.stderr);
    assert.ok(!result.stderr.includes(workspace), result.stderr);
    assert.doesNotMatch(result.stderr, /看起来像是一个 bug/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const [phase, args] of [
  ['workspace', ['tasks', 'list']],
  ['agent', ['-p', 'hello']],
]) {
  test(`CLI ${phase} workspace stat permission error uses fixed text`, () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-stat-safe-'));
    const workspace = path.join(root, 'workspace');
    const secret = 'syntheticWorkspaceStatSecret3579';
    fs.mkdirSync(workspace);
    const preload = path.join(root, 'stat-failure.cjs');
    fs.writeFileSync(
      preload,
      `const fs = require('node:fs');
const stat = fs.statSync;
fs.statSync = function (target, ...args) {
  if (target === ${JSON.stringify(workspace)}) {
    const err = new Error(${JSON.stringify(`EACCES: ${secret} \x1b[31m`)});
    err.code = 'EACCES';
    throw err;
  }
  return stat.call(this, target, ...args);
};\n`
    );
    try {
      const result = runCli(root, workspace, { args, preload });
      assert.equal(result.status, 3, result.stderr);
      assert.match(result.stderr, /Cannot access a workspace path \(EACCES\)/);
      assert.ok(!result.stderr.includes(secret), result.stderr);
      assert.ok(!result.stderr.includes(workspace), result.stderr);
      assert.ok(!result.stderr.includes(String.fromCodePoint(0x1b)), result.stderr);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('CLI omits untrusted skipped and cleanup paths', (t) => {
  if (process.platform === 'win32') return t.skip('control characters are not valid Windows paths');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'moss-cli-notice-safe-'));
  const envSecret = 'syntheticEnvSecret98765';
  const apiSecret = 'syntheticConfigSecret54321';
  const bidiControl = String.fromCodePoint(0x202e);
  const splitEnv = `${envSecret.slice(0, 8)}\x1b[31m${envSecret.slice(8)}\x1b[0m`;
  const splitApi = `${apiSecret.slice(0, 8)}${bidiControl}${apiSecret.slice(8)}`;
  const workspace = path.join(root, `workspace-${splitEnv}-${splitApi}\nspoof`);
  const { source, dest } = createCollision(workspace);
  const agent = path.join(workspace, 'agent');
  fs.mkdirSync(path.join(agent, 'skills'), { recursive: true });
  const preload = writeCleanupFailure(root, agent, 'EBUSY');
  try {
    const result = runCli(root, workspace, {
      args: ['tasks', 'list'],
      preload,
      env: { MOSS_TEST_SECRET: envSecret },
      configValue: { apiKey: apiSecret },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /legacy skill entries were not migrated/i);
    assert.match(result.stderr, /could not be checked or cleaned/i);
    assert.doesNotMatch(result.stderr, /EBUSY|\[redacted\]/i);
    assert.ok(!result.stderr.includes(workspace), result.stderr);
    assert.equal(
      Array.from(result.stderr).some((char) => {
        const code = char.codePointAt(0);
        return (code < 0x20 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
      }),
      false,
      result.stderr
    );
    assert.ok(!result.stderr.includes(bidiControl), result.stderr);
    assert.ok(!result.stderr.includes(envSecret), result.stderr);
    assert.ok(!result.stderr.includes(apiSecret), result.stderr);
    assert.ok(!result.stderr.includes(apiSecret.slice(0, 8)), result.stderr);
    assert.doesNotMatch(result.stderr, /\\u202e|\\nspoof/);
    assert.equal(fs.readFileSync(source, 'utf8'), 'old');
    assert.equal(fs.readFileSync(dest, 'utf8'), 'current');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
