import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runTestsTool, verifyFixTool } from '../dist/tools/harness-tools.js';

test('run_tests aggregates per-file Node test summaries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-run-tests-summary-'));
  const fixture = path.join(dir, 'summary.mjs');
  await fs.writeFile(fixture, [
    "process.stdout.write('ℹ tests 4\\nℹ pass 4\\nℹ fail 0\\nℹ skipped 0\\nℹ duration_ms 12.5\\n');",
    "process.stdout.write('ℹ tests 7\\nℹ pass 6\\nℹ fail 0\\nℹ skipped 1\\nℹ duration_ms 20.25\\n');",
    "process.stderr.write('[test] passed 2 file(s)\\n');",
  ].join('\n'));

  try {
    const output = await runTestsTool.execute(
      { command: `"${process.execPath}" "${fixture}"` },
      {
        workspaceDir: dir,
        abortSignal: new AbortController().signal,
      }
    );

    assert.match(output, /Test files: 2 passed/);
    assert.match(output, /Tests: 11 total, 10 passed, 0 failed, 1 skipped/);
    assert.match(output, /Duration: 32\.75ms/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('run_tests includes actionable raw diagnostics when tests fail', async () => {
  const command = [
    "printf '✖ preserves zero age\\nℹ tests 1\\nℹ pass 0\\nℹ fail 1\\nℹ skipped 0\\nℹ duration_ms 3\\n'",
    "printf 'AssertionError: Expected values to be strictly equal:\\nundefined !== 0\\n'",
    'exit 1',
  ].join('; ');

  const output = await runTestsTool.execute(
    { command },
    {
      workspaceDir: os.tmpdir(),
      abortSignal: new AbortController().signal,
    }
  );

  assert.match(output, /Failure output:/);
  assert.match(output, /undefined !== 0/);
});

test('verify_fix skips absent package scripts and still runs available tests', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-verify-fix-'));
  try {
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      type: 'module',
      scripts: { test: 'node --test' },
    }));
    await fs.writeFile(path.join(dir, 'basic.test.js'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('ok', () => assert.equal(1, 1));",
    ].join('\n'));

    const output = await verifyFixTool.execute(
      {},
      { workspaceDir: dir, abortSignal: new AbortController().signal },
    );

    assert.match(output, /Verify Fix: ✅ ALL PASSED/);
    assert.match(output, /Build: ⏭ skipped/);
    assert.match(output, /Typecheck: ⏭ skipped/);
    assert.match(output, /Tests: ✅ pass/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
