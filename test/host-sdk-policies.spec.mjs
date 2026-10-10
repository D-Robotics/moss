import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as sdk from '../dist/index.js';

test('embedded host file tools share patch parsing and workspace confinement', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-host-policy-'));
  try {
    const parsed = sdk.parsePatch(
      '*** Begin Patch\n*** Add File: result.txt\n+observed\n*** End Patch'
    );
    assert.deepEqual(parsed.errors, []);
    const target = await sdk.assertSandboxPath({ filePath: parsed.hunks[0].path, cwd: root, root });
    await sdk.atomicWriteFile(target.resolved, sdk.extractAddContent(parsed.hunks[0]));
    assert.equal((await fs.readFile(target.resolved, 'utf8')).trim(), 'observed');
    await assert.rejects(
      sdk.assertSandboxPath({ filePath: '../escape.txt', cwd: root, root }),
      (error) => sdk.isMossError(error) && error.code === sdk.ErrorCode.TOOL_NOT_ALLOWED
    );
    const update = sdk.parsePatch(
      '*** Begin Patch\n*** Update File: result.txt\n@@\n-observed\n+verified\n*** End Patch'
    );
    assert.equal(sdk.applyUpdateHunk('observed\n', update.hunks[0]).result, 'verified\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('embedded host uses the same bounded context and sanitized summarization', async () => {
  assert.equal(sdk.getEffectiveContextWindowTokens(100_000, 8_192), 91_808);
  assert.ok(sdk.getContextWarningThreshold(91_808) < sdk.getProactiveCompactThreshold(91_808));
  assert.equal(
    sdk.shouldProactiveCompactByWindowEconomics({
      estimatedPromptTokens: 1,
      effectiveContextWindowTokens: 91_808,
    }),
    false
  );
  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'The build failed; repair the failing test.' }],
      timestamp: Date.now(),
    },
  ];
  assert.ok(sdk.estimateMessagesTokens(messages) > 0);
  let requests = 0;
  const summary = await sdk.buildCompactionSummary({
    messages,
    contextWindowTokens: 100_000,
    maxTokens: 256,
    summarize: async () => {
      requests++;
      return 'Build failed. Repair the test and rerun it before acceptance.';
    },
  });
  assert.ok(requests > 0);
  assert.match(summary, /Repair the test/);
  const secret = ['sk', '0123456789abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
  assert.ok(!sdk.redactSecretsInText(secret).includes(secret));
});
