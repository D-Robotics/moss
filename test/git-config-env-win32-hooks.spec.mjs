/**
 * O76: on win32 there are no exec bits, so an untrusted workspace must always
 * get core.hooksPath pointed at the null device. POSIX keeps the exec-bit check.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { untrustedShellGitConfig } from '../dist/utils/git-config-env.js';
import { GIT_HOOKS_PATH } from '../dist/utils/git-spawn.js';

function repo(setup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o76-win32-'));
  execFileSync('git', ['init', '-q', dir]);
  setup?.(path.join(dir, '.git', 'hooks'));
  return dir;
}

async function withPlatform(platform, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...desc, value: platform });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', desc);
  }
}

function hooksPair(pairs) {
  return pairs.find((pair) => pair.key === 'core.hooksPath');
}

const nonExecHook = (hooks) => {
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho pwned\n', { mode: 0o644 });
  fs.chmodSync(path.join(hooks, 'pre-commit'), 0o644);
};

test('win32: non-executable #! hook still injects core.hooksPath', async () => {
  const dir = repo(nonExecHook);
  const pairs = await withPlatform('win32', () => untrustedShellGitConfig(dir));
  assert.equal(hooksPair(pairs)?.value, GIT_HOOKS_PATH);
});

test('win32: no hooks dir still injects core.hooksPath', async () => {
  const dir = repo((hooks) => fs.rmSync(hooks, { recursive: true, force: true }));
  const pairs = await withPlatform('win32', () => untrustedShellGitConfig(dir));
  assert.equal(hooksPair(pairs)?.value, GIT_HOOKS_PATH);
});

test(
  'posix: non-executable hook is unchanged (no injection)',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = repo(nonExecHook);
    const pairs = await untrustedShellGitConfig(dir);
    assert.equal(hooksPair(pairs), undefined);
  }
);
