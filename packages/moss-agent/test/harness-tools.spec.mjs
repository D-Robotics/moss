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
      { command: 'node summary.mjs' },
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-run-tests-failure-'));
  await fs.writeFile(path.join(dir, 'failure.mjs'), [
    "process.stdout.write('✖ preserves zero age\\nℹ tests 1\\nℹ pass 0\\nℹ fail 1\\nℹ skipped 0\\nℹ duration_ms 3\\n');",
    "process.stderr.write('AssertionError: Expected values to be strictly equal:\\nundefined !== 0\\n');",
    'process.exitCode = 1;',
  ].join('\n'));

  try {
    const output = await runTestsTool.execute(
      { command: 'node failure.mjs' },
      {
        workspaceDir: dir,
        abortSignal: new AbortController().signal,
      }
    );

    assert.match(output, /Failure output:/);
    assert.match(output, /undefined !== 0/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('run_tests parses TAP-format output (# prefix) from non-TTY/CI node --test', async () => {
  // On Linux CI (non-TTY), node --test emits the TAP reporter:
  // "# tests N", "# pass N", "# fail N", "not ok N - name" — NOT the spec
  // reporter's "ℹ tests N" / "✖ name". parseTestOutput must handle both.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-run-tests-tap-'));
  await fs.writeFile(path.join(dir, 'tap.mjs'), [
    "process.stdout.write('TAP version 13\\nnot ok 1 - boom\\n# tests 1\\n# pass 0\\n# fail 1\\n# skipped 0\\n# duration_ms 4\\n');",
    'process.exitCode = 1;',
  ].join('\n'));

  try {
    const output = await runTestsTool.execute(
      { command: 'node tap.mjs' },
      { workspaceDir: dir, abortSignal: new AbortController().signal },
    );
    assert.match(output, /❌/, 'TAP failure is detected and rendered as ❌');
    assert.match(output, /Tests: 1 total, 0 passed, 1 failed/, 'TAP counts parsed from # prefix');
    assert.match(output, /boom/, 'TAP failing-test name extracted');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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
      // Explicit test command avoids npm script resolution edge cases in CI.
      { test_command: 'node --test basic.test.js' },
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

test('run_tests with zero executed cases is not ALL PASSED', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-run-tests-empty-'));
  await fs.writeFile(path.join(dir, 'empty.mjs'), [
    "process.stdout.write('ℹ tests 0\\nℹ pass 0\\nℹ fail 0\\nℹ skipped 0\\nℹ duration_ms 1\\n');",
  ].join('\n'));

  try {
    const output = await runTestsTool.execute(
      { command: 'node empty.mjs' },
      { workspaceDir: dir, abortSignal: new AbortController().signal },
    );
    assert.match(output, /NO TESTS EXECUTED/);
    assert.doesNotMatch(output, /✅ ALL PASSED/);
    assert.match(output, /do not treat this as green/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('run_tests all-skipped is not ALL PASSED', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-run-tests-skipped-'));
  await fs.writeFile(path.join(dir, 'skip.mjs'), [
    "process.stdout.write('ℹ tests 3\\nℹ pass 0\\nℹ fail 0\\nℹ skipped 3\\nℹ duration_ms 2\\n');",
  ].join('\n'));

  try {
    const output = await runTestsTool.execute(
      { command: 'node skip.mjs' },
      { workspaceDir: dir, abortSignal: new AbortController().signal },
    );
    assert.match(output, /NO TESTS EXECUTED/);
    assert.doesNotMatch(output, /✅ ALL PASSED/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('verify_fix all-skipped is not ALL PASSED', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-verify-all-skip-'));
  try {
    // Empty commands force every step to skip.
    const output = await verifyFixTool.execute(
      { build_command: '', typecheck_command: '', test_command: '' },
      { workspaceDir: dir, abortSignal: new AbortController().signal },
    );
    assert.match(output, /NO STEPS EXECUTED/);
    assert.doesNotMatch(output, /✅ ALL PASSED/);
    assert.match(output, /do not treat this as green/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('run_tests file= runs a single spec via node --test and parses pass results', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-run-tests-file-'));
  const spec = path.join(dir, 'single.spec.mjs');
  await fs.writeFile(spec, [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('1 plus 1 equals 2', () => assert.equal(1 + 1, 2));",
  ].join('\n'));

  try {
    const output = await runTestsTool.execute(
      { file: 'single.spec.mjs' },
      { workspaceDir: dir, abortSignal: new AbortController().signal },
    );
    assert.match(output, /✅ ALL PASSED/);
    assert.match(output, /Tests: 1 total, 1 passed/);
    // `file` mode bypasses the full `npm test` suite.
    assert.doesNotMatch(output, /npm test/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('run_tests file= surfaces structured failures from the single spec', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-run-tests-file-fail-'));
  const spec = path.join(dir, 'broken.spec.mjs');
  await fs.writeFile(spec, [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('boom', () => assert.equal(1, 2));",
  ].join('\n'));

  try {
    const output = await runTestsTool.execute(
      { file: 'broken.spec.mjs' },
      { workspaceDir: dir, abortSignal: new AbortController().signal },
    );
    assert.match(output, /❌/);
    assert.match(output, /Tests: 1 total, 0 passed, 1 failed/);
    assert.match(output, /1 !== 2|AssertionError/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('run_tests file= rejects paths escaping the workspace', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-run-tests-escape-'));
  try {
    const output = await runTestsTool.execute(
      { file: '../outside.spec.mjs' },
      { workspaceDir: dir, abortSignal: new AbortController().signal },
    );
    assert.match(output, /escapes workspace/i);
    // Must not have actually tried to run anything.
    assert.doesNotMatch(output, /ALL PASSED/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
