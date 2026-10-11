#!/usr/bin/env node
/**
 * Hook commands with quoted paths. On Windows, Node's default spawn quoting
 * turns " into \" and cmd.exe treats the backslash as a literal, so the
 * SessionStart hook never starts. The invocation must match child_process.exec:
 * one extra quote wrapper and windowsVerbatimArguments, so /s strips only
 * that wrapper. POSIX stays /bin/sh -c with the command unchanged.
 */
import assert from 'node:assert/strict';

import { hookShell } from '../dist/cli/hooks.js';

const command = '"C:\\node.exe" "C:\\x\\dump.mjs"';

{
  const win = hookShell(command, 'win32');
  assert.equal(win.windowsVerbatimArguments, true);
  assert.equal(win.cmd, process.env.COMSPEC || 'cmd.exe');
  assert.deepEqual(win.args, ['/d', '/s', '/c', `"${command}"`]);
}

{
  const linux = hookShell(command, 'linux');
  assert.deepEqual(linux, { cmd: '/bin/sh', args: ['-c', command] });
}

console.log('[PASS] hooks-shell-win32');
