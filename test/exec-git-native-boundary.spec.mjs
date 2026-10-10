import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { execTool } from '../dist/tools/builtin.js';
import { childEnv } from '../dist/tools/tool-helpers.js';
import { GIT_HOOKS_PATH } from '../dist/utils/git-spawn.js';
import { isWorkspaceTrusted, workspaceTrustKey } from '../dist/utils/workspace-trust-state.js';

const gitPath = (file) => file.split(path.sep).join('/');
const literalCommand = (file) => `'${gitPath(file).replaceAll("'", "'\\''")}'`;
const count = (file) =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;

function fixture(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const keys = [
    'MOSS_CONFIG_DIR',
    'MOSS_TRUST_WORKSPACE',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const configDir = path.join(root, 'cfg');
  fs.mkdirSync(configDir, { mode: 0o700 });
  process.env.MOSS_CONFIG_DIR = configDir;
  delete process.env.MOSS_TRUST_WORKSPACE;
  process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = process.env.GIT_CONFIG_GLOBAL;
  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cwd = path.join(root, 'ws');
  fs.mkdirSync(cwd);
  const git = (args) => execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.name', 'Moss Native Boundary']);
  git(['config', 'user.email', 'boundary@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
  const context = {
    workspaceDir: cwd,
    sessionKey: prefix,
    abortSignal: new AbortController().signal,
  };
  return { root, cwd, configDir, git, context };
}

test('a real native Git hook runs raw and trusted, but never in an untrusted exec', async (t) => {
  const { root, cwd, configDir, git, context } = fixture(t, 'moss-native-hook-');
  const marker = path.join(root, 'hook.marker');
  const hook = path.join(cwd, '.git/hooks/pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\necho ran >> ${JSON.stringify(gitPath(marker))}\n`);
  fs.chmodSync(hook, 0o755);
  git(['commit', '--allow-empty', '-qm', 'raw']);
  assert.equal(count(marker), 1, 'the native Git actually executes this hook');
  const env = await childEnv(cwd);
  const pairs = Array.from({ length: Number(env.GIT_CONFIG_COUNT || 0) }, (_, i) => ({
    key: env[`GIT_CONFIG_KEY_${i}`],
    value: env[`GIT_CONFIG_VALUE_${i}`],
  }));
  assert.equal(
    pairs.find((pair) => pair.key.toLowerCase() === 'core.hookspath')?.value,
    GIT_HOOKS_PATH
  );
  const blocked = await execTool.execute(
    { command: 'git commit --allow-empty -qm untrusted', timeout_ms: 20000 },
    context
  );
  assert.equal(count(marker), 1, 'the untrusted command cannot execute a native hook');
  assert.match(blocked, /Repo hooks in an untrusted workspace were not run/);
  fs.writeFileSync(
    path.join(configDir, 'workspace-trust.json'),
    `${JSON.stringify({ [workspaceTrustKey(cwd)]: true })}\n`
  );
  assert.equal(isWorkspaceTrusted(cwd), true);
  await execTool.execute(
    { command: 'git commit --allow-empty -qm trusted', timeout_ms: 20000 },
    { ...context, sessionKey: 'native-trusted' }
  );
  assert.equal(count(marker), 2, 'an explicit trust grant retains native hook behavior');
});

test('a builtin diff in a literal space-and-apostrophe path matches Git and never invokes the repo diff', async (t) => {
  const { root, cwd, git, context } = fixture(t, "moss-native-diff space's-");
  const marker = path.join(root, 'diff.marker');
  const evil = path.join(root, 'evil.sh');
  fs.writeFileSync(
    evil,
    `#!/bin/sh\necho ran >> ${JSON.stringify(gitPath(marker))}\necho evil-diff\n`
  );
  fs.chmodSync(evil, 0o755);
  fs.writeFileSync(path.join(cwd, 'data.txt'), 'one\n');
  const quotedName = 'space ü.txt';
  fs.writeFileSync(path.join(cwd, quotedName), 'before\n');
  git(['add', 'data.txt', quotedName]);
  git(['commit', '-qm', 'base']);
  git(['config', 'diff.external', literalCommand(evil)]);
  fs.writeFileSync(path.join(cwd, 'data.txt'), 'two\n');
  fs.writeFileSync(path.join(cwd, quotedName), 'after\n');
  assert.match(git(['--no-pager', 'diff', '--no-color']), /evil-diff/);
  assert.equal(count(marker), 2, 'the raw external diff really executes for both changed files');
  const expected = git(['--no-pager', 'diff', '--no-ext-diff', '--no-color']).trim();
  assert.match(expected, /--- "a\/space \\303\\274\.txt"\t\n/);
  const result = await execTool.execute(
    { command: 'git --no-pager diff --no-color', timeout_ms: 20000 },
    context
  );
  assert.equal(result.trim(), expected);
  assert.equal(count(marker), 2, 'the repo external diff never runs in the untrusted exec');
  assert.doesNotMatch(result, /external diff died|Command failed|evil-diff/);
});
