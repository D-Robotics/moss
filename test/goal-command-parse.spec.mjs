#!/usr/bin/env node
/**
 * `/goal` argument parsing and the acceptance-command shell invocation.
 */
import assert from 'node:assert/strict';
import path from 'node:path';

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
  const windows = process.platform === 'win32';
  const sentinel = windows
    ? path.resolve(`moss-venv-${process.pid}`, 'bin')
    : `/moss-venv-${process.pid}/bin`;
  const previous = process.env.PATH;
  process.env.PATH = `${sentinel}${windows ? path.delimiter : ':'}${previous ?? ''}`;
  try {
    // Print only the first PATH entry: `tail` keeps the end of the output, and
    // under `npm run verify` a long PATH pushes the sentinel out of it.
    const command = windows
      ? `"${process.execPath}" -e "process.stdout.write(process.env.PATH.split(require('node:path').delimiter)[0])"`
      : 'printf %s "${PATH%%:*}"';
    const result = await runAcceptanceCommand({ command });
    assert.equal(result.passed, true, result.tail);
    assert.ok(result.tail.startsWith(sentinel), result.tail);
    if (windows) {
      assert.equal(result.tail, sentinel, 'the real child inherited the native first PATH entry');
      const other = path.resolve(`moss-other-env-${process.pid}`, 'bin');
      process.env.PATH = `${other}${path.delimiter}${previous ?? ''}`;
      const negative = await runAcceptanceCommand({ command });
      assert.equal(negative.passed, true, negative.tail);
      assert.equal(negative.tail, other, 'the same real child observes a changed PATH');
      assert.throws(
        () => assert.ok(negative.tail.startsWith(sentinel), negative.tail),
        assert.AssertionError
      );
    }
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}

console.log('[PASS] goal command parse');
