#!/usr/bin/env node
/**
 * exec uses pwsh only at version 7+. Windows PowerShell 5.1 stays off the path.
 * Hooks, the status line, and acceptance commands stay on cmd.
 */
import assert from 'node:assert/strict';

import { acceptanceShell } from '../dist/core/task/acceptance-command.js';
import { execToolDescription } from '../dist/tools/builtin.js';
import { resolveHostShell } from '../dist/utils/host-shell.js';

const absent = () => null;

{
  const shell = resolveHostShell({ platform: 'linux' });
  assert.equal(shell.kind, 'sh');
  assert.deepEqual(shell.argsFor('echo hi'), ['-c', 'echo hi']);
  assert.equal(shell.description, '');
}

{
  const shell = resolveHostShell({
    platform: 'win32',
    comspec: 'C:\\Windows\\System32\\cmd.exe',
    lookup: absent,
    pwshMajor: () => null,
  });
  assert.equal(shell.kind, 'cmd');
  assert.equal(shell.executable, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(shell.argsFor('echo hi'), ['/c', 'echo hi']);
  assert.match(shell.description, /cmd\.exe/);
  assert.match(shell.description, /&&/);
}

{
  const shell = resolveHostShell({
    platform: 'win32',
    lookup: (name) => (name === 'pwsh' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null),
    pwshMajor: () => 5,
  });
  assert.equal(shell.kind, 'cmd', 'PowerShell 5.1 must not become the exec shell');
}

{
  const shell = resolveHostShell({
    platform: 'win32',
    lookup: (name) =>
      name === 'powershell'
        ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
        : null,
    pwshMajor: () => 7,
  });
  assert.equal(shell.kind, 'cmd', 'powershell.exe is not pwsh');
}

{
  const shell = resolveHostShell({
    platform: 'win32',
    lookup: (name) => (name === 'pwsh' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null),
    pwshMajor: () => 7,
  });
  assert.equal(shell.kind, 'pwsh');
  assert.match(shell.executable, /pwsh\.exe$/);
  assert.deepEqual(shell.argsFor('echo hi && echo there'), [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'echo hi && echo there',
  ]);
  assert.match(execToolDescription(shell), /PowerShell 7/);
  assert.match(execToolDescription(shell), /Chain with &&/);
}

{
  const cmd = acceptanceShell('echo hi && echo there', 'win32');
  assert.match(cmd.cmd, /cmd\.exe|COMSPEC/i);
  assert.ok(cmd.args.includes('/c'));
  assert.equal(
    cmd.args.some((arg) => /pwsh|powershell/i.test(arg)),
    false
  );
}

if (process.platform === 'win32') {
  const live = resolveHostShell();
  const { runProcessSync } = await import('../dist/utils/run-process.js');
  const probe = runProcessSync(
    'pwsh',
    ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'],
    {
      encoding: 'utf8',
      timeout: 8_000,
      windowsHide: true,
    }
  );
  const major = Number.parseInt(String(probe.stdout ?? '').trim(), 10);
  if (probe.status === 0 && major >= 7) {
    assert.equal(live.kind, 'pwsh');
  } else {
    assert.equal(live.kind, 'cmd');
  }
  assert.doesNotMatch(live.executable, /WindowsPowerShell/i);
}

console.log('[PASS] host shell');
