#!/usr/bin/env node
/**
 * `/goal` argument parsing and the acceptance-command shell invocation.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseGoalCommandLine } from '../dist/cli/commands/goal-propose.js';
import {
  acceptanceShell,
  mergeAcceptancePath,
  runAcceptanceCommand,
} from '../dist/core/task/acceptance-command.js';

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

// Profile-only tools (nvm, pyenv, Homebrew shellenv) still resolve when moss
// starts with a minimal GUI/IDE PATH, and an activated virtualenv stays first.
{
  assert.equal(
    mergeAcceptancePath('/venv/bin:/usr/bin', '/usr/bin:/home/u/.nvm/bin:/usr/bin'),
    '/venv/bin:/usr/bin:/home/u/.nvm/bin'
  );
  assert.equal(mergeAcceptancePath(undefined, ''), '');
  if (process.platform !== 'win32') {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-accept-login-'));
    try {
      const toolDir = path.join(home, 'profile-bin');
      fs.mkdirSync(toolDir);
      fs.writeFileSync(
        path.join(toolDir, 'profile-only-tool'),
        '#!/bin/sh\necho profile-tool-ok\n',
        { mode: 0o755 }
      );
      fs.writeFileSync(path.join(home, '.bash_profile'), `export PATH="${toolDir}:$PATH"\n`);
      const venvBin = path.join(home, 'venv', 'bin');
      const script = `
        const { runAcceptanceCommand } = await import(${JSON.stringify(new URL('../dist/core/task/acceptance-command.js', import.meta.url).href)});
        const tool = await runAcceptanceCommand({ command: 'profile-only-tool' });
        const first = await runAcceptanceCommand({ command: 'printf %s "\${PATH%%:*}"' });
        console.log(JSON.stringify({ tool: tool.passed, toolTail: tool.tail, first: first.tail }));`;
      const run = (extra) =>
        JSON.parse(
          execFileSync(process.execPath, ['--input-type=module', '-e', script], {
            env: { HOME: home, SHELL: '/bin/bash', PATH: `${venvBin}:/usr/bin:/bin`, ...extra },
            encoding: 'utf8',
          })
            .trim()
            .split('\n')
            .pop()
        );
      const on = run({});
      assert.equal(on.tool, true, on.toolTail);
      assert.equal(on.first, venvBin, 'inherited PATH (virtualenv) stays first');
      const off = run({ MOSS_ACCEPT_LOGIN_PATH: '0' });
      assert.equal(off.tool, false, 'opt-out keeps the plain inherited PATH');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
}

console.log('[PASS] goal command parse');
