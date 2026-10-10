#!/usr/bin/env node
/**
 * Every registered subcommand's --help is its own usage (options + examples),
 * in English by default and in Chinese when the locale is zh*.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { KNOWN_COMMANDS } from '../dist/cli/args.js';
import { renderSubcommandHelp } from '../dist/cli/subcommand-help.js';
import { isolatedCliEnv } from './helpers/isolated-cli-env.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, 'dist', 'cli.js');

/** Option tokens that belong to that command and must show up in its --help. */
const OWN_OPTIONS = {
  setup: ['--config-file'],
  auth: ['logout'],
  config: ['--project', '--json', '--strict'],
  doctor: ['--verbose', '--cd'],
  update: ['npm install -g', 'git pull', '--dir'],
  trust: ['list', 'remove'],
  uninstall: ['HOME'],
  resume: ['--last', '--session'],
  fork: ['--fork-from'],
  mcp: ['--header', '--project'],
  device: ['--port', '--devices', '--concurrency'],
  skill: ['create', 'list'],
  plugins: ['not implemented'],
  migrate: ['not implemented'],
  tasks: ['--json'],
  task: ['--accept', '--max-repairs', '--device'],
  sessions: ['--no-limit', '--out'],
  web: ['not implemented'],
  agent: ['not implemented'],
};

function run(args, locale) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: isolatedCliEnv({
      isolateHome: false,
      overrides: {
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        LANG: locale,
        LC_ALL: locale,
        LC_MESSAGES: locale,
      },
    }),
  });
}

const known = [...KNOWN_COMMANDS];
assert.deepEqual(
  Object.keys(OWN_OPTIONS).sort(),
  known.slice().sort(),
  'help coverage must match the registered subcommands'
);

const root = run(['--help'], 'C');
assert.equal(root.status, 0, root.stderr);
assert.match(root.stdout, /Most useful/);

for (const command of known) {
  const help = run([command, '--help'], 'C');
  assert.equal(help.status, 0, `${command} --help\n${help.stderr}`);
  assert.notEqual(
    help.stdout.trim(),
    root.stdout.trim(),
    `${command} --help must differ from the root help`
  );
  assert.match(help.stdout, new RegExp(`moss ${command}\\b`));
  assert.match(help.stdout, /Usage:/);
  assert.match(help.stdout, /Options:/);
  assert.match(help.stdout, /Examples:/);
  assert.doesNotMatch(help.stdout, /Most useful/);
  for (const mark of OWN_OPTIONS[command]) {
    assert.ok(
      help.stdout.includes(mark),
      `${command} --help should mention its option ${mark}\n${help.stdout}`
    );
  }
  assert.equal(help.stdout.trim(), renderSubcommandHelp(command, false));

  const short = run([command, '-h'], 'C');
  assert.equal(short.status, 0, short.stderr);
  assert.equal(short.stdout, help.stdout, `${command} -h should match --help`);

  const zh = run([command, '--help'], 'zh_CN.UTF-8');
  assert.equal(zh.status, 0, zh.stderr);
  assert.match(zh.stdout, /用法/);
  assert.match(zh.stdout, /选项/);
  assert.match(zh.stdout, /示例/);
  assert.doesNotMatch(zh.stdout, /Most useful/);
  assert.doesNotMatch(zh.stdout, /^Usage:/m);
  assert.notEqual(zh.stdout.trim(), help.stdout.trim(), `${command} zh help should differ from en`);
  assert.equal(zh.stdout.trim(), renderSubcommandHelp(command, true));
  for (const mark of OWN_OPTIONS[command]) {
    const zhMark = mark === 'not implemented' ? '尚未实现' : mark;
    assert.ok(zh.stdout.includes(zhMark), `zh ${command} --help should mention ${zhMark}`);
  }
}

console.log(`[PASS] subcommand help (${known.length} commands)`);
