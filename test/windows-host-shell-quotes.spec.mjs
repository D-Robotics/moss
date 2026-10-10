import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execTool, execBackgroundTool } from '../dist/index.js';

// Exercise production tools on every platform, including Windows' cmd.exe
// argument path. A literal 1+2 or MODULE_NOT_FOUND is a failure, not a skip.
for (const [name, tool] of [
  ['foreground', execTool],
  ['background', execBackgroundTool],
]) {
  test(`${name} shell preserves quoted executable and JavaScript expression`, async () => {
    const command = `"${process.execPath}" -p "1+2"`;
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
