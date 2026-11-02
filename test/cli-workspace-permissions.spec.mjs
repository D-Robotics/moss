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
function runCli(root, workspace, { args = ['-p', 'hello'], lang = 'en', preload } = {}) {
  const dist = path.join(repo, 'dist');
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, '{}');
  const result = spawnSync(
    process.execPath,
    [
      '--permission',
      `--allow-fs-read=${dist}`,
      `--allow-fs-read=${nodeModules}`,
      `--allow-fs-read=${path.join(repo, 'package.json')}`,
      `--allow-fs-read=${path.join(repo, 'bin', 'node-version-message.cjs')}`,
      `--allow-fs-read=${root}`,
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
  assert.ok(result.stderr.includes(blockedPath), result.stderr);
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

test('an inaccessible subdirectory is identified in Chinese without blaming the workspace root', (t) => {
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
    assert.match(result.stderr, /无法访问工作区路径/);
    assert.ok(result.stderr.includes(blockedPath), result.stderr);
    assert.match(result.stderr, /检查该路径及其父目录的权限和访问限制/);
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

test('EPERM during migration reports the actual path', () => {
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
