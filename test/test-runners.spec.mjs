import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runTestsTool, verifyFixTool } from '../dist/tools/harness-tools.js';
import { planTestRunners, renderCommandResult } from '../dist/tools/test-runners.js';

const RED = /Test Results:\s*❌|Verify Fix:\s*❌/;
const py = process.platform === 'win32' ? 'python' : 'python3';

function ctx(dir) {
  return { workspaceDir: dir, abortSignal: new AbortController().signal };
}

function hasBin(cmd, args = ['--version']) {
  return spawnSync(cmd, args, { encoding: 'utf8' }).status === 0;
}

function pytestImportable() {
  return spawnSync(py, ['-c', 'import pytest'], { encoding: 'utf8' }).status === 0;
}

const FIXTURES = [
  {
    name: 'jest passed',
    output: 'Tests: 3 passed, 3 total',
    match: [/tests_pass=true/, /Tests: 3 total, 3 passed, 0 failed/],
    not: [/❌/, /counts unknown/],
  },
  {
    name: 'jest failed',
    output: 'Tests: 1 failed, 2 passed, 3 total',
    match: [/tests_pass=false/, /Tests: 3 total, 2 passed, 1 failed/, /❌/],
  },
  {
    name: 'vitest passed',
    output: 'Tests  3 passed (3)',
    match: [/tests_pass=true/, /Tests: 3 total, 3 passed, 0 failed/],
    not: [/total\)/],
  },
  {
    name: 'vitest failed',
    output: 'Tests  1 failed | 2 passed (3)',
    match: [/tests_pass=false/, /Tests: 3 total, 2 passed, 1 failed/],
  },
  {
    name: 'mocha mixed',
    output: '3 passing\n1 failing',
    match: [/tests_pass=false/, /1 failed/, /3 passed/],
  },
  {
    name: 'node zero',
    output: 'ℹ tests 0\nℹ pass 0\nℹ fail 0\nℹ skipped 0\n',
    match: [/NO TESTS EXECUTED/, /tests_pass=false/],
    not: [/counts unknown/, /✅ ALL PASSED/],
  },
  {
    name: 'node summed',
    output:
      'ℹ tests 4\nℹ pass 4\nℹ fail 0\nℹ skipped 0\nℹ duration_ms 12.5\n' +
      'ℹ tests 7\nℹ pass 6\nℹ fail 0\nℹ skipped 1\nℹ duration_ms 20.25\n' +
      '[test] passed 2 file(s)\n',
    match: [/Test files: 2 passed/, /Tests: 11 total, 10 passed, 0 failed, 1 skipped/, /32\.75ms/],
  },
  {
    name: 'tap fail',
    output: 'not ok 1 - boom\n# tests 1\n# pass 0\n# fail 1\n# skipped 0\n',
    exitCode: 1,
    match: [/❌/, /Tests: 1 total, 0 passed, 1 failed/, /boom/],
  },
  {
    name: 'pytest counts',
    output: '1 failed, 2 passed, 1 skipped in 0.02s',
    match: [/tests_pass=false/, /Tests: 4 total, 2 passed, 1 failed, 1 skipped/],
    not: [/NO TESTS EXECUTED/],
  },
  {
    name: 'pytest expected failure',
    output: '1 xfailed in 0.01s',
    match: [/tests_pass=true/, /Tests: 1 total, 1 passed, 0 failed/],
    not: [/tests_pass=false/, /counts unknown/, /1 failed/],
  },
  {
    name: 'pytest non-strict xpass stays a pass',
    output: '1 passed, 1 xpassed in 0.01s',
    match: [/tests_pass=true/, /ALL PASSED/, /1 passed, 0 failed/],
    not: [/tests_pass=false/, /FAILED/],
  },
  {
    name: 'pytest xpass alone is not a failure',
    output: '1 xpassed in 0.01s',
    match: [/counts unknown/, /tests_pass=false/],
    not: [/1 FAILED/, /ALL PASSED/, /tests_pass=true/],
  },
  {
    name: 'pytest empty',
    output: 'no tests ran in 0.01s',
    match: [/no tests/, /tests_pass=false/],
    not: [/tests_pass=true/, /NO TESTS EXECUTED/, /counts unknown/],
  },
  {
    name: 'go json',
    output:
      '{"Action":"pass","Package":"example.com/demo","Test":"TestAdd"}\n' +
      '{"Action":"fail","Package":"example.com/demo","Test":"TestSub"}\n',
    exitCode: 1,
    match: [/Tests: 2 total, 1 passed, 1 failed/, /tests_pass=false/],
  },
  {
    name: 'go package pass is not a count',
    output:
      '{"Action":"output","Package":"example.com/demo","Output":"?   \\texample.com/demo\\t[no test files]\\n"}\n' +
      '{"Action":"pass","Package":"example.com/demo"}\n',
    match: [/no tests/, /tests_pass=false/],
    not: [/1 passed/, /tests_pass=true/],
  },
  {
    name: 'cargo passed',
    output: 'test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out',
    match: [/tests_pass=true/, /Tests: 4 total, 3 passed, 0 failed, 1 skipped/],
    not: [/NO TESTS EXECUTED/, /RED/],
  },
  {
    name: 'cargo zero',
    output: 'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out',
    match: [/no tests/, /tests_pass=false/],
    not: [/tests_pass=true/, /ALL PASSED/],
  },
  {
    name: 'echo unknown',
    output: 'suite-ok',
    match: [/exit 0, counts unknown/, /tests_pass=false/],
    not: [/tests_pass=true/, /NO TESTS EXECUTED/, /❌/, /overall tests_pass/],
  },
  {
    name: 'jest green but exit 1',
    output: 'Tests: 3 passed, 3 total',
    exitCode: 1,
    match: [/tests_pass=false/, /❌ exit 1/, /Tests: 3 total, 3 passed, 0 failed/],
    not: [/ALL PASSED/, /tests_pass=true/],
  },
  {
    name: 'pass count then timeout',
    output: '# pass 3\n',
    timedOut: true,
    match: [/timed out/, /tests_pass=false/],
    not: [/tests_pass=true/, /ALL PASSED/],
  },
  {
    name: 'go package compile fail',
    output:
      '{"Action":"pass","Package":"example.com/ok","Test":"TestOk"}\n' +
      '{"Action":"fail","Package":"example.com/broken"}\n',
    exitCode: 1,
    match: [/tests_pass=false/, /example\.com\/broken/, /1 failed/, /1 passed/],
    not: [/tests_pass=true/, /ALL PASSED/],
  },
  {
    name: 'vitest indented',
    output: '    Tests  1 failed | 2 passed (3)',
    exitCode: 1,
    match: [/tests_pass=false/, /Tests: 3 total, 2 passed, 1 failed/],
  },
  {
    name: 'pytest module missing',
    command: 'python3 -m pytest',
    output: '/usr/bin/python3: No module named pytest\n',
    exitCode: 1,
    match: [/Test Results: not run/, /pytest not installed/, /tests_pass=false/],
    not: [/❌/, /tests_pass=true/, /ISSUES FOUND/],
    notRed: true,
  },
  {
    name: 'pytest command not found',
    command: 'pytest',
    output: '/bin/sh: 1: pytest: not found\n',
    exitCode: 127,
    match: [/not run/, /pytest not installed/],
    not: [/❌/, /tests_pass=true/, /exit 127/],
    notRed: true,
  },
  {
    name: 'go command not found',
    command: 'go test -json ./...',
    output: '/bin/sh: 1: go: not found\n',
    exitCode: 127,
    match: [/Test Results: not run/, /go not installed/, /tests_pass=false/],
    not: [/❌/, /tests_pass=true/, /exit 127/],
    notRed: true,
  },
  {
    name: 'jest command not found',
    command: 'npm test --silent',
    output: 'sh: 1: jest: not found\n',
    exitCode: 127,
    match: [/Test Results: not run/, /jest not installed/, /tests_pass=false/],
    not: [/❌/, /tests_pass=true/, /exit 127/],
    notRed: true,
  },
  {
    name: 'windows runner not recognized',
    command: 'go test -json ./...',
    output:
      "'go' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n",
    exitCode: 1,
    match: [/Test Results: not run/, /go not installed/],
    not: [/❌/, /exit 1/],
    notRed: true,
  },
  {
    name: 'go plain packages',
    command: 'go test ./...',
    output:
      'ok  \texample.com/ok\t0.012s\n' +
      '--- FAIL: TestBoom (0.00s)\n' +
      '\tdemo_test.go:8: bad\n' +
      'FAIL\texample.com/bad\t0.020s\n' +
      'FAIL\n',
    exitCode: 1,
    match: [/tests_pass=false/, /2 total, 1 passed, 1 failed/, /example\.com\/bad/, /TestBoom/],
    not: [/tests_pass=true/, /ALL PASSED/],
  },
  {
    name: 'unittest ok',
    command: 'python3 -m unittest discover -s .',
    output: 'Ran 2 tests in 0.001s\n\nOK\n',
    match: [/tests_pass=true/, /Tests: 2 total, 2 passed, 0 failed/],
    not: [/tests_pass=false/, /counts unknown/, /no tests/],
  },
  {
    name: 'unittest failed',
    command: 'python3 -m unittest discover -s .',
    output:
      'FAIL: test_add (test_math.MathTest.test_add)\n' +
      'AssertionError: 1 != 2\n\n' +
      'Ran 3 tests in 0.002s\n\nFAILED (failures=1, skipped=1)\n',
    exitCode: 1,
    match: [/tests_pass=false/, /Tests: 3 total, 1 passed, 1 failed, 1 skipped/, /test_add/],
    not: [/tests_pass=true/, /ALL PASSED/],
  },
  {
    name: 'unittest none',
    command: 'python3 -m unittest discover -s .',
    output: 'Ran 0 tests in 0.000s\n\nNO TESTS RAN\n',
    match: [/no tests/, /tests_pass=false/],
    not: [/tests_pass=true/, /ALL PASSED/],
  },
  {
    name: 'unittest expected failure',
    command: 'python3 -m unittest discover -s .',
    output: 'Ran 1 test in 0.000s\n\nOK (expected failures=1)\n',
    match: [/tests_pass=true/, /Tests: 1 total, 1 passed, 0 failed/],
    not: [/tests_pass=false/, /1 failed/],
  },
  {
    name: 'unittest unexpected success',
    command: 'python3 -m unittest discover -s .',
    output:
      'UNEXPECTED SUCCESS: test_1 (test_a.T.test_1)\n\n' +
      'Ran 2 tests in 0.000s\n\nFAILED (unexpected successes=1)\n',
    exitCode: 1,
    match: [/tests_pass=false/, /Tests: 2 total, 1 passed, 1 failed/, /UNEXPECTED SUCCESS/],
    not: [/0 failed/, /ALL PASSED/, /tests_pass=true/],
  },
  {
    name: 'unittest subtest failures',
    command: 'python3 -m unittest discover -s .',
    output:
      'FAIL: test_1 (test_a.T.test_1) (i=1)\n' +
      'FAIL: test_1 (test_a.T.test_1) (i=2)\n\n' +
      'Ran 1 test in 0.000s\n\nFAILED (failures=2)\n',
    exitCode: 1,
    match: [/tests_pass=false/, /Tests: 1 total, 0 passed, 2 failed/],
    not: [/ALL PASSED/, /tests_pass=true/, /no tests/],
  },
  {
    name: 'unittest setUpClass error',
    command: 'python3 -m unittest discover -s .',
    output: 'ERROR: setUpClass (test_a.T)\n\nRan 0 tests in 0.000s\n\nFAILED (errors=1)\n',
    exitCode: 1,
    match: [/tests_pass=false/, /1 failed/, /setUpClass/],
    not: [/no tests/, /ALL PASSED/, /tests_pass=true/],
  },
  {
    name: 'go plain ok',
    command: 'go test ./...',
    output: 'ok  \texample.com/ok\t0.01s\nok  \texample.com/other\t(cached)\n',
    match: [/tests_pass=true/, /2 total, 2 passed, 0 failed/],
    not: [/❌/, /no tests/],
  },
];

for (const row of FIXTURES) {
  test(`parse ${row.name}`, () => {
    const text = renderCommandResult(
      row.command ?? 'echo fixture',
      row.exitCode ?? 0,
      row.output,
      row.timedOut ?? false
    );
    for (const re of row.match) assert.match(text, re, text);
    for (const re of row.not ?? []) assert.doesNotMatch(text, re, text);
    if (row.name === 'echo unknown' || row.notRed) assert.equal(RED.test(text), false, text);
  });
}

test('npm test still parses a jest summary', () => {
  const text = renderCommandResult('npm test', 0, 'Tests: 3 passed, 3 total');
  assert.match(text, /tests_pass=true/);
  assert.doesNotMatch(text, /overall tests_pass/);
});

async function withDir(files, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-runners-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      const abs = path.join(dir, name);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, body);
    }
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('detection order skips make unless it is alone', async () => {
  await withDir({}, async (dir) => {
    assert.deepEqual(await planTestRunners(dir), { run: [], skipped: [] });
  });
  await withDir({ Makefile: 'test:\n\t@echo x\n' }, async (dir) => {
    assert.deepEqual(await planTestRunners(dir), { run: ['make test'], skipped: [] });
  });
  await withDir(
    {
      Makefile: 'test:\n\t@echo x\n',
      'package.json': JSON.stringify({ scripts: { test: 'node -e 0' } }),
      'go.mod': 'module example.com/demo\n\ngo 1.22\n',
      'Cargo.toml': '[package]\nname = "demo"\nversion = "0.0.0"\n',
      'pytest.ini': '[pytest]\n',
    },
    async (dir) => {
      assert.deepEqual(await planTestRunners(dir), {
        run: [`${py} -m pytest`, 'npm test --silent', 'go test -json ./...', 'cargo test'],
        skipped: ['make test'],
      });
    }
  );
});

test('a real unittest discover run is tests_pass=true', async () => {
  if (!hasBin(py, ['-c', 'import unittest'])) return;
  await withDir(
    {
      'test_math.py':
        'import unittest\n\nclass MathTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(1 + 1, 2)\n\nif __name__ == "__main__":\n    unittest.main()\n',
    },
    async (dir) => {
      const output = await runTestsTool.execute({}, ctx(dir));
      assert.match(output, pytestImportable() ? /pytest/ : /unittest discover/);
      assert.match(output, /tests_pass=true/, output);
      assert.doesNotMatch(output, /tests_pass=false/);
    }
  );
});

test('unittest modules are discovered without a pytest probe', async () => {
  await withDir(
    {
      'tests/test_math.py':
        'import unittest\n\nclass MathTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(1 + 1, 2)\n',
    },
    async (dir) => {
      const planned = await planTestRunners(dir, async () => false);
      assert.deepEqual(planned.run, [`${py} -m unittest discover -s tests`]);
      assert.equal(
        planned.skipped.some((line) => line.includes('pytest')),
        false
      );
      const withPytest = await planTestRunners(dir, async () => true);
      assert.deepEqual(withPytest.run, [`${py} -m pytest`]);
    }
  );
});

test('a pytest-style assert is not hidden by a sibling unittest import', async () => {
  await withDir(
    {
      'test_a.py': 'def test_x():\n    assert 1 == 2\n',
      'test_b.py':
        'import unittest\n\nclass T(unittest.TestCase):\n    def test_1(self):\n        pass\n',
    },
    async (dir) => {
      const present = await planTestRunners(dir, async () => true);
      assert.deepEqual(present.run, [`${py} -m pytest`]);
      const absent = await planTestRunners(dir, async () => false);
      assert.deepEqual(absent.run, []);
      assert.match(absent.skipped.join('\n'), /pytest not installed/);
    }
  );
});

test('a PATH pytest shim without importable pytest falls back to unittest', async () => {
  if (!hasBin(py, ['-c', 'import unittest'])) return;
  const hidden = spawnSync(py, ['-m', 'pytest', '--version'], {
    env: { ...process.env, PYTHONNOUSERSITE: '1' },
    encoding: 'utf8',
  });
  if (hidden.status === 0) return;
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-pytest-shim-'));
  const shimName = process.platform === 'win32' ? 'pytest.cmd' : 'pytest';
  const shimBody =
    process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n';
  await fs.writeFile(path.join(binDir, shimName), shimBody);
  if (process.platform !== 'win32') await fs.chmod(path.join(binDir, shimName), 0o755);
  const savedPath = process.env.PATH;
  const savedNoUser = process.env.PYTHONNOUSERSITE;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`;
  process.env.PYTHONNOUSERSITE = '1';
  try {
    await withDir(
      {
        'test_math.py':
          'import unittest\n\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(1, 1)\n',
      },
      async (dir) => {
        const output = await runTestsTool.execute({ timeout_ms: 20000 }, ctx(dir));
        assert.match(output, /unittest discover/, output);
        assert.match(output, /tests_pass=true/, output);
        assert.doesNotMatch(output, /not run|No module named pytest/);
      }
    );
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedNoUser === undefined) delete process.env.PYTHONNOUSERSITE;
    else process.env.PYTHONNOUSERSITE = savedNoUser;
    await fs.rm(binDir, { recursive: true, force: true });
  }
});

test('unittest under tests/ runs without __init__.py', async () => {
  if (!hasBin(py, ['-c', 'import unittest'])) return;
  await withDir(
    {
      'tests/test_a.py':
        'import unittest\n\nclass T(unittest.TestCase):\n    def test_1(self):\n        pass\n',
    },
    async (dir) => {
      const output = await runTestsTool.execute({ timeout_ms: 20000 }, ctx(dir));
      assert.match(output, /tests_pass=true/, output);
      assert.doesNotMatch(output, /NO TESTS|Ran 0 tests/);
    }
  );
});

test('a timed-out run reports timeout only', async () => {
  if (!hasBin(py, ['-c', 'import unittest'])) return;
  await withDir(
    {
      'test_hang.py':
        'import unittest, time\n\nclass T(unittest.TestCase):\n    def test_hang(self):\n        time.sleep(30)\n',
    },
    async (dir) => {
      const output = await runTestsTool.execute({ timeout_ms: 5000 }, ctx(dir));
      assert.match(output, /timed out/, output);
      assert.match(output, /tests_pass=false/);
      assert.doesNotMatch(output, /Process exited with code/);
    }
  );
});

test('loose python is pytest only when the probe says it is installed', async () => {
  await withDir({ 'tests/test_one.py': 'def test_one():\n    assert True\n' }, async (dir) => {
    const absent = await planTestRunners(dir, async () => false);
    assert.deepEqual(absent.run, []);
    assert.match(absent.skipped.join('\n'), /pytest not installed/);
    const present = await planTestRunners(dir, async () => true);
    assert.deepEqual(present.run, [`${py} -m pytest`]);
  });
  await withDir(
    {
      'package.json': JSON.stringify({ scripts: { test: 'node -e 0' } }),
      'tests/test_one.py': 'def test_one():\n    assert True\n',
    },
    async (dir) => {
      const absent = await planTestRunners(dir, async () => false);
      assert.deepEqual(absent.run, ['npm test --silent']);
      assert.match(absent.skipped.join('\n'), /pytest not installed/);
      const present = await planTestRunners(dir, async () => true);
      assert.deepEqual(present.run, [`${py} -m pytest`, 'npm test --silent']);
    }
  );
  await withDir(
    {
      'pytest.ini': '[pytest]\n',
      'tests/test_one.py': 'def test_one():\n    assert True\n',
    },
    async (dir) => {
      const signaled = await planTestRunners(dir, async () => false);
      assert.deepEqual(signaled.run, [`${py} -m pytest`]);
      assert.equal(
        signaled.skipped.some((line) => line.includes('pytest not installed')),
        false
      );
    }
  );
});

test('missing pytest beside npm is not a red verify', async () => {
  await withDir(
    {
      'package.json': JSON.stringify({
        scripts: {
          test: 'node -e "process.stdout.write(\'ℹ tests 1\\nℹ pass 1\\nℹ fail 0\\nℹ skipped 0\\n\')"',
        },
      }),
      'tests/test_one.py': 'def test_one():\n    assert True\n',
    },
    async (dir) => {
      const bin = path.join(dir, 'bin');
      await fs.mkdir(bin);
      await fs.writeFile(
        path.join(bin, 'python3'),
        '#!/bin/sh\necho "No module named pytest" >&2\nexit 1\n'
      );
      await fs.writeFile(
        path.join(bin, 'python'),
        '#!/bin/sh\necho "No module named pytest" >&2\nexit 1\n'
      );
      await fs.chmod(path.join(bin, 'python3'), 0o755);
      await fs.chmod(path.join(bin, 'python'), 0o755);
      const saved = process.env.PATH;
      process.env.PATH = [bin, saved].filter(Boolean).join(path.delimiter);
      try {
        const output = await runTestsTool.execute({}, ctx(dir));
        assert.match(output, /pytest not installed/);
        assert.match(output, /overall tests_pass=true/);
        assert.match(output, /Command: npm test/);
        assert.equal(RED.test(output), false, output);
        const verify = await verifyFixTool.execute(
          { build_command: '', typecheck_command: '' },
          ctx(dir)
        );
        assert.match(verify, /pytest not installed/);
        assert.doesNotMatch(verify, /ISSUES FOUND/);
        assert.doesNotMatch(verify, /❌/);
        assert.match(verify, /ALL PASSED/);
      } finally {
        process.env.PATH = saved;
      }
    }
  );
});

test('run_tests with no runner points at exec', async () => {
  await withDir({}, async (dir) => {
    const output = await runTestsTool.execute({}, ctx(dir));
    assert.match(output, /tests_pass=false/);
    assert.match(output, /exec/);
    assert.equal(output.includes('NO TESTS EXECUTED'), false);
    assert.equal(output.includes('RED'), false);
    assert.equal(output.includes('node --test'), false);
  });
});

test(
  'echo-only make test is unknown and not an overall pass',
  { skip: !hasBin('make') },
  async () => {
    await withDir({ Makefile: 'test:\n\t@echo suite-ok\n' }, async (dir) => {
      const output = await runTestsTool.execute({}, ctx(dir));
      assert.match(output, /Command: make test/);
      assert.match(output, /exit 0, counts unknown/);
      assert.match(output, /tests_pass=false/);
      assert.doesNotMatch(output, /overall tests_pass/);
      assert.doesNotMatch(output, /tests_pass=true/);
      assert.equal(RED.test(output), false);
      assert.equal(output.includes('NO TESTS EXECUTED'), false);
      assert.equal(output.includes('node --test'), false);
    });
  }
);

test('make is skipped when npm matches, and one budget stops the next runner', async () => {
  await withDir(
    {
      Makefile: 'test:\n\t@echo suite-ok\n',
      'package.json': JSON.stringify({
        scripts: {
          test: 'node -e "process.stdout.write(\'ℹ tests 1\\nℹ pass 1\\nℹ fail 0\\nℹ skipped 0\\n\')"',
        },
      }),
    },
    async (dir) => {
      const skipped = await runTestsTool.execute({}, ctx(dir));
      assert.match(skipped, /Command: npm test/);
      assert.match(skipped, /skipped: make test/);
      assert.match(skipped, /overall tests_pass=true/);
      assert.doesNotMatch(skipped, /Command: make test/);
      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { test: 'node -e "setTimeout(()=>{}, 30000)"' } })
      );
      await fs.writeFile(path.join(dir, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n');
      const budget = await runTestsTool.execute({ timeout_ms: 5000 }, ctx(dir));
      assert.match(budget, /not run \(timeout budget\): go test -json \.\/\.\.\./);
      assert.doesNotMatch(budget, /overall tests_pass=true/);
    }
  );
});

test('quoted explicit Node test commands preserve real passing and failing outcomes', async () => {
  // Nested `node --test` must be an independent runner, not inherit the
  // parent Node test harness's private worker marker.
  const parentTestContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    await withDir(
      { 'quoted test.mjs': `import test from 'node:test'; test('quoted pass',()=>{});` },
      async (dir) => {
        const pass = await runTestsTool.execute(
          {
            command: 'node --test --test-reporter=tap "quoted test.mjs"',
          },
          ctx(dir)
        );
        assert.match(pass, /tests_pass=true/);
        assert.match(pass, /Tests: 1 total, 1 passed, 0 failed/);
        await fs.writeFile(
          path.join(dir, 'quoted test.mjs'),
          `import test from 'node:test'; test('quoted fail',()=>{throw Error('intentional')});`
        );
        const fail = await runTestsTool.execute(
          {
            command: 'node --test --test-reporter=tap "quoted test.mjs"',
          },
          ctx(dir)
        );
        assert.match(fail, /tests_pass=false/);
        assert.match(fail, /Tests: 1 total, 0 passed, 1 failed/);
        assert.match(fail, /intentional/);
        assert.doesNotMatch(fail, /tests_pass=true/);
      }
    );
  } finally {
    if (parentTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = parentTestContext;
  }
});

test('verify_fix labels a step the budget never started as not run', async () => {
  await withDir({}, async (dir) => {
    const output = await verifyFixTool.execute(
      {
        build_command: 'node -e "process.exit(0)"',
        typecheck_command: 'node -e "setTimeout(()=>{}, 30000)"',
        test_command: 'node -e "process.exit(1)"',
        timeout_ms: 5000,
      },
      ctx(dir)
    );
    assert.match(output, /Tests: not run/);
    assert.doesNotMatch(output, /Tests: ❌ FAIL/);
    assert.match(output, /Typecheck: ❌ FAIL/);
  });
});

test('verify_fix does not paint an unparsed exit 0 as FAIL or ALL PASSED', async () => {
  await withDir({}, async (dir) => {
    const output = await verifyFixTool.execute(
      { build_command: '', typecheck_command: '', test_command: "printf 'suite-ok\\n'" },
      ctx(dir)
    );
    assert.match(output, /Verify Fix: exit 0, counts unknown/);
    assert.match(output, /Tests: exit 0, counts unknown/);
    assert.equal(RED.test(output), false);
    assert.doesNotMatch(output, /ALL PASSED/);
    assert.doesNotMatch(output, /Test Failures/);
    assert.doesNotMatch(output, /verification is red/);
  });
});

function pathWithout(names) {
  const parts = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return parts
    .filter((entry) =>
      names.every(
        (name) =>
          !existsSync(path.join(entry, name)) &&
          !existsSync(path.join(entry, `${name}.exe`)) &&
          !existsSync(path.join(entry, `${name}.cmd`))
      )
    )
    .join(path.delimiter);
}

test('missing go is not run and not a red verify', async () => {
  await withDir({ 'go.mod': 'module example.com/demo\n\ngo 1.22\n' }, async (dir) => {
    const saved = process.env.PATH;
    process.env.PATH = pathWithout(['go']);
    try {
      const output = await runTestsTool.execute({}, ctx(dir));
      assert.match(output, /Test Results: not run/);
      assert.match(output, /go not installed/);
      assert.equal(RED.test(output), false, output);
      assert.doesNotMatch(output, /exit 127/);
      assert.doesNotMatch(output, /❌/);
      const verify = await verifyFixTool.execute(
        { build_command: '', typecheck_command: '' },
        ctx(dir)
      );
      assert.match(verify, /not run/);
      assert.match(verify, /go not installed/);
      assert.equal(RED.test(verify), false, verify);
      assert.doesNotMatch(verify, /ISSUES FOUND/);
      assert.doesNotMatch(verify, /❌/);
    } finally {
      process.env.PATH = saved;
    }
  });
});

test('missing jest is not run', async () => {
  await withDir({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) }, async (dir) => {
    const output = await runTestsTool.execute({}, ctx(dir));
    assert.match(output, /Test Results: not run/);
    assert.match(output, /jest not installed/);
    assert.equal(RED.test(output), false, output);
    assert.doesNotMatch(output, /❌/);
    assert.doesNotMatch(output, /exit 127/);
  });
});

test('pytest repo reports tests_pass=true', { skip: !pytestImportable() }, async () => {
  await withDir(
    {
      'pyproject.toml':
        '[project]\nname = "sample"\nversion = "0.0.1"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n',
      'tests/test_hello.py': 'def test_adds():\n    assert 1 + 1 == 2\n',
    },
    async (dir) => {
      const output = await runTestsTool.execute({}, ctx(dir));
      assert.match(output, /tests_pass=true/);
      assert.match(output, /pytest/);
      assert.equal(output.includes('NO TESTS EXECUTED'), false);
      assert.equal(output.includes('RED'), false);
      assert.equal(output.includes('node --test'), false);
    }
  );
});

test('a go module with no tests is not a pass', { skip: !hasBin('go', ['version']) }, async () => {
  await withDir(
    {
      'go.mod': 'module example.com/demo\n\ngo 1.22\n',
      'demo.go': 'package demo\n',
    },
    async (dir) => {
      const output = await runTestsTool.execute({}, ctx(dir));
      assert.match(output, /go test -json/);
      assert.match(output, /no tests/);
      assert.match(output, /tests_pass=false/);
      assert.doesNotMatch(output, /tests_pass=true/);
    }
  );
});

test('python file mode uses pytest', { skip: !pytestImportable() }, async () => {
  await withDir({ 'test_one.py': 'def test_one():\n    assert 1 + 1 == 2\n' }, async (dir) => {
    const output = await runTestsTool.execute({ file: 'test_one.py' }, ctx(dir));
    assert.match(output, /pytest/);
    assert.match(output, /tests_pass=true/);
    assert.doesNotMatch(output, /node --test/);
  });
});
