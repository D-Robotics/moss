import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execTool, execBackgroundTool } from '../dist/index.js';
import { hostShellInvocation, resolveHostShell } from '../dist/utils/host-shell.js';
import { runProcess } from '../dist/utils/run-process.js';

// Exercise the actual selected production shell. A quoted executable in
// PowerShell requires &, while cmd and POSIX execute it directly.
const selectedShell = resolveHostShell();
for (const [name, tool] of [
  ['foreground', execTool],
  ['background', execBackgroundTool],
]) {
  test(`${name} shell preserves quoted executable and JavaScript expression`, async () => {
    const command = `${selectedShell.kind === 'pwsh' ? '& ' : ''}"${process.execPath}" -p "1+2"`;
    const output = await tool.execute(
      { command, timeout_ms: 5_000 },
      {
        workspaceDir: process.cwd(),
        sessionKey: 'host-shell-test',
        goalExecWait: true,
      }
    );
    assert.match(output, /(?:^|\n)3(?:\r?\n|$)/);
    assert.doesNotMatch(output, /MODULE_NOT_FOUND|(?:^|\n)1\+2(?:\r?\n|$)/);
  });
}

test('fallback shell executes quoted Node and preserves its real nonzero exit', async () => {
  // The injected absence only selects the real fallback; spawning and Node's
  // output/exit are native. On Windows this exercises cmd despite installed pwsh.
  const shell = resolveHostShell({ lookup: () => null, pwshMajor: () => null });
  assert.equal(shell.kind, process.platform === 'win32' ? 'cmd' : 'sh');
  const invoke = (expression) => {
    const invocation = hostShellInvocation(`"${process.execPath}" -p "${expression}"`, shell);
    return runProcess(invocation.executable, {
      args: invocation.args,
      windowsVerbatimArguments: shell.kind === 'cmd',
      timeout: 5_000,
      cwd: process.cwd(),
    });
  };
  const result = await invoke('1+2');
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /(?:^|\n)3(?:\r?\n|$)/);
  assert.doesNotMatch(result.stdout + result.stderr, /MODULE_NOT_FOUND|(?:^|\n)1\+2(?:\r?\n|$)/);
  await assert.rejects(invoke('process.exit(7)'), (error) => {
    assert.equal(error.exitCode, 7);
    assert.doesNotMatch(error.stdout + error.stderr, /MODULE_NOT_FOUND|(?:^|\n)3(?:\r?\n|$)/);
    return true;
  });
});
