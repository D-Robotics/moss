import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runTestsTool, verifyFixTool } from '../dist/tools/harness-tools.js';

const SYNTHETIC_NAMES = [
  'MOSS_DEVICE_HOST',
  'MOSS_DEVICE_SYNTHETIC',
  'MOSS_BENCH_API_KEY',
  'OPENAI_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'MOSS_SYNTHETIC_ORDINARY',
  'AUTH',
];

async function withEnvOverrides(overrides, fn) {
  const previous = new Map(Object.keys(overrides).map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, overrides);
    await fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function withSyntheticEnv(fn) {
  await withEnvOverrides(
    Object.fromEntries(SYNTHETIC_NAMES.map((name) => [name, 'synthetic'])),
    fn
  );
}

const probeSource = `
const fs = require('node:fs');
const presence = {
  device: Boolean(process.env.MOSS_DEVICE_HOST),
  deviceExtension: Boolean(process.env.MOSS_DEVICE_SYNTHETIC),
  benchmarkKey: Boolean(process.env.MOSS_BENCH_API_KEY),
  apiKey: Boolean(process.env.OPENAI_API_KEY),
  accessKey: Boolean(process.env.AWS_ACCESS_KEY_ID),
  ordinary: process.env.MOSS_SYNTHETIC_ORDINARY === 'synthetic',
  path: Boolean(process.env.PATH || process.env.Path),
  auth: Boolean(process.env.AUTH)
};
fs.writeFileSync('presence.json', JSON.stringify(presence));
process.stdout.write(JSON.stringify(presence));
`;

async function assertSafeProbe(dir, label, expectedDevice = false, file = 'presence.json') {
  const { auth, ...visible } = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
  console.error(`custom AUTH visible to ${label} child: ${auth}`);
  assert.equal(typeof auth, 'boolean');
  assert.deepEqual(visible, {
    device: expectedDevice,
    deviceExtension: false,
    benchmarkKey: false,
    apiKey: false,
    accessKey: false,
    ordinary: true,
    path: true,
  });
}

test('verify_fix filters synthetic credentials from build and typecheck children', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-verify-child-env-'));
  try {
    await fs.writeFile(path.join(dir, 'env-probe.cjs'), probeSource);
    await withSyntheticEnv(async () => {
      for (const field of ['build_command', 'typecheck_command']) {
        const input = { build_command: '', typecheck_command: '', test_command: '' };
        input[field] = 'node env-probe.cjs';
        const output = await verifyFixTool.execute(input, {
          workspaceDir: dir,
          abortSignal: new AbortController().signal,
        });
        assert.match(output, field === 'build_command' ? /Build: ✅ pass/ : /Typecheck: ✅ pass/);
        await assertSafeProbe(dir, field);
      }
      // A shell command can still opt in to an explicit environment assignment.
      const assignment =
        process.platform === 'win32'
          ? 'set "MOSS_DEVICE_HOST=synthetic" && node env-probe.cjs'
          : 'MOSS_DEVICE_HOST=synthetic node env-probe.cjs';
      const output = await verifyFixTool.execute(
        { build_command: assignment, typecheck_command: '', test_command: '' },
        { workspaceDir: dir, abortSignal: new AbortController().signal }
      );
      assert.match(output, /Build: ✅ pass/);
      await assertSafeProbe(dir, 'explicit override', true);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('test commands filter synthetic credentials', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-tests-child-env-'));
  try {
    await fs.writeFile(path.join(dir, 'env-probe.cjs'), probeSource);
    await withSyntheticEnv(async () => {
      const ctx = { workspaceDir: dir, abortSignal: new AbortController().signal };
      const run = await runTestsTool.execute({ command: 'node env-probe.cjs' }, ctx);
      assert.match(run, /Command: node env-probe\.cjs/);
      await assertSafeProbe(dir, 'run_tests command');
      await fs.rm(path.join(dir, 'presence.json'));
      await verifyFixTool.execute(
        { build_command: '', typecheck_command: '', test_command: 'node env-probe.cjs' },
        ctx
      );
      await assertSafeProbe(dir, 'verify_fix test command');
      await fs.rm(path.join(dir, 'presence.json'));
      const assignment =
        process.platform === 'win32'
          ? 'set "MOSS_DEVICE_HOST=synthetic" && node env-probe.cjs'
          : 'MOSS_DEVICE_HOST=synthetic node env-probe.cjs';
      await runTestsTool.execute({ command: assignment }, ctx);
      await assertSafeProbe(dir, 'test command explicit override', true);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('run_tests keeps Node file and npm runners usable with a safe environment', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-runners-child-env-'));
  try {
    await fs.writeFile(path.join(dir, 'env-probe.cjs'), probeSource);
    await withSyntheticEnv(async () => {
      await withEnvOverrides(
        {
          npm_config_userconfig: os.devNull,
          npm_config_globalconfig: path.join(dir, 'no-global-npmrc'),
          npm_config_cache: path.join(dir, 'npm-cache'),
          npm_config_offline: 'true',
          npm_config_update_notifier: 'false',
        },
        async () => {
          const ctx = { workspaceDir: dir, abortSignal: new AbortController().signal };
          const direct = await runTestsTool.execute({ file: 'env-probe.cjs' }, ctx);
          assert.match(direct, /ALL PASSED/);
          await assertSafeProbe(dir, 'Node file');
          await fs.rm(path.join(dir, 'presence.json'));
          await fs.writeFile(
            path.join(dir, 'package.json'),
            JSON.stringify({ scripts: { test: 'node env-probe.cjs' } })
          );
          const npm = await runTestsTool.execute({}, ctx);
          assert.match(npm, /Command: npm test --silent/);
          await assertSafeProbe(dir, 'npm');
        }
      );
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const python = process.platform === 'win32' ? 'python' : 'python3';
const pythonAvailable =
  spawnSync(python, ['-c', 'print(True)'], {
    env: {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      PYTHONNOUSERSITE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    },
    encoding: 'utf8',
  }).status === 0;

function pythonProbe(file) {
  return `
import json
import os
presence = {
    'device': bool(os.environ.get('MOSS_DEVICE_HOST')),
    'deviceExtension': bool(os.environ.get('MOSS_DEVICE_SYNTHETIC')),
    'benchmarkKey': bool(os.environ.get('MOSS_BENCH_API_KEY')),
    'apiKey': bool(os.environ.get('OPENAI_API_KEY')),
    'accessKey': bool(os.environ.get('AWS_ACCESS_KEY_ID')),
    'ordinary': os.environ.get('MOSS_SYNTHETIC_ORDINARY') == 'synthetic',
    'path': bool(os.environ.get('PATH') or os.environ.get('Path')),
    'auth': bool(os.environ.get('AUTH')),
}
with open(${JSON.stringify(file)}, 'w', encoding='utf8') as out:
    json.dump(presence, out)
print(json.dumps(presence))
`;
}

test(
  'Python availability probe and unittest receive the safe environment',
  { skip: !pythonAvailable },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-python-child-env-'));
    try {
      // Force the real Python interpreter down the unittest fallback while
      // recording what its pytest-availability subprocess received.
      await fs.writeFile(
        path.join(dir, 'pytest.py'),
        `${pythonProbe('probe-presence.json')}\nraise SystemExit(1)\n`
      );
      await fs.writeFile(
        path.join(dir, 'test_probe.py'),
        `import unittest\n${pythonProbe('presence.json')}\nclass TestEnv(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n`
      );
      await withSyntheticEnv(async () => {
        await withEnvOverrides(
          { PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
          async () => {
            const result = await runTestsTool.execute(
              { file: 'test_probe.py' },
              { workspaceDir: dir, abortSignal: new AbortController().signal }
            );
            assert.match(result, /Command: .* -m unittest test_probe\.py/);
            assert.match(result, /ALL PASSED/);
            await assertSafeProbe(dir, 'Python availability probe', false, 'probe-presence.json');
            await assertSafeProbe(dir, 'Python unittest');
          }
        );
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
);

test('run_tests aggregates per-file Node test summaries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-run-tests-summary-'));
  const fixture = path.join(dir, 'summary.mjs');
  await fs.writeFile(
    fixture,
    [
      "process.stdout.write('ℹ tests 4\\nℹ pass 4\\nℹ fail 0\\nℹ skipped 0\\nℹ duration_ms 12.5\\n');",
      "process.stdout.write('ℹ tests 7\\nℹ pass 6\\nℹ fail 0\\nℹ skipped 1\\nℹ duration_ms 20.25\\n');",
      "process.stderr.write('[test] passed 2 file(s)\\n');",
    ].join('\n')
  );

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
  await fs.writeFile(
    path.join(dir, 'failure.mjs'),
    [
      "process.stdout.write('✖ preserves zero age\\nℹ tests 1\\nℹ pass 0\\nℹ fail 1\\nℹ skipped 0\\nℹ duration_ms 3\\n');",
      "process.stderr.write('AssertionError: Expected values to be strictly equal:\\nundefined !== 0\\n');",
      'process.exitCode = 1;',
    ].join('\n')
  );

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
  await fs.writeFile(
    path.join(dir, 'tap.mjs'),
    [
      "process.stdout.write('TAP version 13\\nnot ok 1 - boom\\n# tests 1\\n# pass 0\\n# fail 1\\n# skipped 0\\n# duration_ms 4\\n');",
      'process.exitCode = 1;',
    ].join('\n')
  );

  try {
    const output = await runTestsTool.execute(
      { command: 'node tap.mjs' },
      { workspaceDir: dir, abortSignal: new AbortController().signal }
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
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        type: 'module',
        scripts: { test: 'node --test' },
      })
    );
    await fs.writeFile(
      path.join(dir, 'basic.test.js'),
      [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "test('ok', () => assert.equal(1, 1));",
      ].join('\n')
    );

    const output = await verifyFixTool.execute(
      // Explicit test command avoids npm script resolution edge cases in CI.
      { test_command: 'node --test basic.test.js' },
      { workspaceDir: dir, abortSignal: new AbortController().signal }
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
  await fs.writeFile(
    path.join(dir, 'empty.mjs'),
    [
      "process.stdout.write('ℹ tests 0\\nℹ pass 0\\nℹ fail 0\\nℹ skipped 0\\nℹ duration_ms 1\\n');",
    ].join('\n')
  );

  try {
    const output = await runTestsTool.execute(
      { command: 'node empty.mjs' },
      { workspaceDir: dir, abortSignal: new AbortController().signal }
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
  await fs.writeFile(
    path.join(dir, 'skip.mjs'),
    [
      "process.stdout.write('ℹ tests 3\\nℹ pass 0\\nℹ fail 0\\nℹ skipped 3\\nℹ duration_ms 2\\n');",
    ].join('\n')
  );

  try {
    const output = await runTestsTool.execute(
      { command: 'node skip.mjs' },
      { workspaceDir: dir, abortSignal: new AbortController().signal }
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
      { workspaceDir: dir, abortSignal: new AbortController().signal }
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
  await fs.writeFile(
    spec,
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('1 plus 1 equals 2', () => assert.equal(1 + 1, 2));",
    ].join('\n')
  );

  try {
    const output = await runTestsTool.execute(
      { file: 'single.spec.mjs' },
      { workspaceDir: dir, abortSignal: new AbortController().signal }
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
  await fs.writeFile(
    spec,
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('boom', () => assert.equal(1, 2));",
    ].join('\n')
  );

  try {
    const output = await runTestsTool.execute(
      { file: 'broken.spec.mjs' },
      { workspaceDir: dir, abortSignal: new AbortController().signal }
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
      { workspaceDir: dir, abortSignal: new AbortController().signal }
    );
    assert.match(output, /escapes workspace/i);
    // Must not have actually tried to run anything.
    assert.doesNotMatch(output, /ALL PASSED/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
