#!/usr/bin/env node
/**
 * Bare near-miss subcommands are refused. Ordinary words stay prompts.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCliArgs, suggestBareCommand } from '../dist/cli/args.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, 'dist', 'cli.js');

assert.equal(suggestBareCommand('upgrade'), 'update');
assert.equal(suggestBareCommand('udpate'), 'update');
assert.equal(suggestBareCommand('unistall'), 'uninstall');
assert.equal(suggestBareCommand('resum'), 'resume');
assert.equal(suggestBareCommand('statsu'), 'doctor');
assert.equal(suggestBareCommand('install'), 'setup');
assert.equal(suggestBareCommand('login'), 'auth');
assert.equal(suggestBareCommand('version'), '--version');
assert.equal(suggestBareCommand('help'), '--help');
assert.equal(suggestBareCommand('status'), 'doctor');
assert.equal(suggestBareCommand('confgi'), 'config');
assert.equal(suggestBareCommand('uninstall'), null);
assert.equal(suggestBareCommand('fix the bug'), null);

for (const word of [
  'test',
  'lint',
  'fix',
  'build',
  'deploy',
  'hello',
  'continue',
  'review',
  'commit',
  'push',
  'explain',
  'refactor',
  'docs',
  'plan',
  'run',
  'start',
  'stop',
  'clean',
  'init',
  'go',
  'yes',
  'ok',
  'x',
]) {
  assert.equal(suggestBareCommand(word), null, `${word} is a prompt, not a subcommand typo`);
}

{
  const parsed = parseCliArgs(['hello']);
  assert.equal(parsed.unknownCommand, undefined);
  assert.equal(parsed.prompt, 'hello');
}

{
  const parsed = parseCliArgs(['confgi']);
  assert.deepEqual(parsed.unknownCommand, { token: 'confgi', suggestion: 'config' });
}

{
  const result = spawnSync(process.execPath, [cli, 'confgi'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, MOSS_NO_RDK_DOCS: '1' },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command 'confgi'/);
  assert.match(result.stderr, /Did you mean 'config'\?/);
}

{
  const result = spawnSync(process.execPath, [cli, 'hello'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: '/tmp',
      MOSS_CONFIG_DIR: '/tmp/moss-hello-no-config',
      MOSS_NO_BUNDLED_DEFAULT: '1',
      MOSS_NO_RDK_DOCS: '1',
    },
  });
  assert.notEqual(result.status, 2);
  assert.equal((result.stderr || '').includes('did you mean'), false);
  assert.equal((result.stderr || '').includes('--help'), false);
}

console.log('[PASS] unknown command');
