#!/usr/bin/env node
/**
 * `/goal` argument parsing and the acceptance-command shell invocation.
 */
import assert from 'node:assert/strict';

import { parseGoalCommandLine } from '../dist/cli/commands/goal-propose.js';
import { acceptanceShell, runAcceptanceCommand } from '../dist/core/task/acceptance-command.js';

{
  assert.deepEqual(parseGoalCommandLine('fix the parser'), { goal: 'fix the parser' });
  assert.deepEqual(parseGoalCommandLine('fix it --accept "npm test"'), {
    goal: 'fix it',
    acceptance: { command: 'npm test' },
  });
  assert.deepEqual(parseGoalCommandLine("fix it --accept='node check.js'"), {
    goal: 'fix it',
    acceptance: { command: 'node check.js' },
  });
  assert.deepEqual(parseGoalCommandLine('fix it --accept node check.js'), {
    goal: 'fix it',
    acceptance: { command: 'node check.js' },
  });
  assert.equal(parseGoalCommandLine(''), null, 'empty line is malformed');
  assert.equal(parseGoalCommandLine('   '), null, 'whitespace-only is malformed');
  assert.equal(parseGoalCommandLine('--accept "npm test"'), null, 'goalless line is malformed');
  assert.equal(parseGoalCommandLine('fix it --accept ""'), null, 'empty acceptance is malformed');
  assert.equal(parseGoalCommandLine('fix it --accept'), null, 'dangling --accept is malformed');
}

// cmd.exe /s /c plus Node's default spawn quoting keeps " inside the filename.
// The invocation must match child_process.exec: one extra quote wrapper and
// windowsVerbatimArguments, so /s strips only that wrapper.
{
  const command =
    'node "D:\\a\\moss\\scripts\\lib\\device-bench-accept.mjs" --task "D:\\a\\task.json"';
  const win = acceptanceShell(command, 'win32');
  assert.equal(win.windowsVerbatimArguments, true);
  assert.deepEqual(win.args, ['/d', '/s', '/c', `"${command}"`]);
  assert.match(win.cmd, /cmd(\.exe)?$/i);
  const posix = acceptanceShell('exit 0', 'linux');
  assert.deepEqual(posix, { cmd: 'bash', args: ['-c', 'exit 0'] });
}

{
  const sentinel = `/moss-venv-${process.pid}/bin`;
  const previous = process.env.PATH;
  process.env.PATH = `${sentinel}:${previous ?? ''}`;
  try {
    // Print only the first PATH entry: `tail` keeps the end of the output, and
    // under `npm run verify` a long PATH pushes the sentinel out of it.
    const result = await runAcceptanceCommand({ command: 'printf %s "${PATH%%:*}"' });
    assert.equal(result.passed, true, result.tail);
    assert.ok(result.tail.startsWith(sentinel), result.tail);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}

console.log('[PASS] goal command parse');
