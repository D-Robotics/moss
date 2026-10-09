import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
];

for (const row of FIXTURES) {
  test(`parse ${row.name}`, () => {
    const text = renderCommandResult(
      'echo fixture',
      row.exitCode ?? 0,
      row.output,
      row.timedOut ?? false
    );
    for (const re of row.match) assert.match(text, re, text);
    for (const re of row.not ?? []) assert.doesNotMatch(text, re, text);
    if (row.name === 'echo unknown') assert.equal(RED.test(text), false);
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

test('loose python is pytest even beside an npm test script', async () => {
  await withDir({ 'tests/test_one.py': 'def test_one():\n    assert True\n' }, async (dir) => {
    assert.deepEqual((await planTestRunners(dir)).run, [`${py} -m pytest`]);
  });
  await withDir(
    {
      'package.json': JSON.stringify({ scripts: { test: 'node -e 0' } }),
      'tests/test_one.py': 'def test_one():\n    assert True\n',
    },
    async (dir) => {
      assert.deepEqual((await planTestRunners(dir)).run, [`${py} -m pytest`, 'npm test --silent']);
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

test('echo-only make test is unknown and not an overall pass', async () => {
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
});

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
