#!/usr/bin/env node
/**
 * `/goal` argument parsing and the acceptance-command shell invocation.
 */
import assert from 'node:assert/strict';

import { parseGoalCommandLine } from '../dist/cli/commands/goal-propose.js';
import { acceptanceShell } from '../dist/core/task/acceptance-command.js';

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
  assert.deepEqual(posix, { cmd: 'bash', args: ['-lc', 'exit 0'] });
}

console.log('[PASS] goal command parse');
