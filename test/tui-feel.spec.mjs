#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requirePyLayout } from './helpers/require-pyte.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(root, 'scripts/tui-feel/run.mjs');
const noPythonPath = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-feel-no-python-'));
try {
  const missingPython = spawnSync(process.execPath, [runner], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: noPythonPath },
    timeout: 10_000,
  });
  assert.notEqual(missingPython.status, 0, 'a missing Python must not pass the benchmark');
  assert.match(
    `${missingPython.stdout}${missingPython.stderr}`,
    process.platform === 'win32' ? /requires macOS or Linux/ : /python3|pyte/i
  );
} finally {
  fs.rmSync(noPythonPath, { recursive: true, force: true });
}
console.log('[PASS] TUI feel fails when Python is unavailable');

const windowsEntry = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `Object.defineProperty(process, 'platform', { value: 'win32' }); await import(${JSON.stringify(pathToFileURL(runner).href)});`,
  ],
  { encoding: 'utf8', timeout: 10_000 }
);
assert.notEqual(windowsEntry.status, 0, 'the entry point must fail on Windows');
assert.match(`${windowsEntry.stdout}${windowsEntry.stderr}`, /requires macOS or Linux/);

if (process.platform !== 'win32' && requirePyLayout('tui-feel')) {
  const windowsProbe = `
import builtins, os, pathlib, sys
original_import = builtins.__import__
def guarded_import(name, *args, **kwargs):
    if name == 'termios': raise ModuleNotFoundError("No module named 'termios'")
    return original_import(name, *args, **kwargs)
builtins.__import__ = guarded_import
os.name = 'nt'
path = sys.argv[1]
exec(compile(open(path, 'rb').read(), path, 'exec'), {'__name__': '__main__', '__file__': path})
`;
  const windows = spawnSync(
    'python3',
    ['-S', '-c', windowsProbe, path.join(root, 'scripts/tui-feel/driver.py')],
    {
      encoding: 'utf8',
      timeout: 10_000,
    }
  );
  assert.notEqual(windows.status, 0, 'Windows without POSIX PTYs must fail');
  assert.match(`${windows.stdout}${windows.stderr}`, /requires macOS or Linux/);
  assert.doesNotMatch(`${windows.stdout}${windows.stderr}`, /No module named 'termios'/);

  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-feel-no-build-'));
  try {
    const scriptDir = path.join(emptyRoot, 'scripts/tui-feel');
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.cpSync(path.join(root, 'scripts/tui-feel'), scriptDir, { recursive: true });
    const reportPath = path.join(emptyRoot, 'report.json');
    const missingPyte = spawnSync(
      'python3',
      ['-S', path.join(scriptDir, 'driver.py'), '--out', reportPath],
      {
        cwd: emptyRoot,
        encoding: 'utf8',
        env: { ...process.env, PYTHONPATH: '' },
        timeout: 10_000,
      }
    );
    assert.notEqual(missingPyte.status, 0, 'missing pyte must fail the driver');
    assert.match(`${missingPyte.stdout}${missingPyte.stderr}`, /pyte is required/i);
    assert.equal(fs.existsSync(reportPath), false);

    const missingBuild = spawnSync(
      'python3',
      [path.join(scriptDir, 'driver.py'), '--out', reportPath],
      {
        cwd: emptyRoot,
        encoding: 'utf8',
        timeout: 10_000,
      }
    );
    assert.notEqual(missingBuild.status, 0, 'a missing CLI build must not pass the benchmark');
    assert.match(`${missingBuild.stdout}${missingBuild.stderr}`, /dist[/\\\\]cli\.js/);
    assert.equal(
      fs.existsSync(reportPath),
      false,
      'a failed run must not publish a success report'
    );

    fs.mkdirSync(path.join(emptyRoot, 'dist'));
    fs.writeFileSync(path.join(emptyRoot, 'dist/cli.js'), 'process.exit(17);\n');
    const failedStart = spawnSync(
      'python3',
      [path.join(scriptDir, 'driver.py'), '--out', reportPath],
      {
        cwd: emptyRoot,
        encoding: 'utf8',
        timeout: 30_000,
      }
    );
    assert.notEqual(failedStart.status, 0, 'a CLI that exits during startup must fail');
    assert.match(`${failedStart.stdout}${failedStart.stderr}`, /CLI exited with status 17/);
    assert.equal(fs.existsSync(reportPath), false, 'a failed startup must not publish a report');

    fs.writeFileSync(
      path.join(emptyRoot, 'dist/cli.js'),
      "process.stdout.write('─'.repeat(70) + '\\r\\n❯ \\r\\n' + '─'.repeat(70) + '\\x1b[1A\\x1b[3G'); setTimeout(() => process.exit(0), 2000);\n"
    );
    const fakeScenario = path.join(emptyRoot, 'fake-echo.json');
    fs.writeFileSync(
      fakeScenario,
      JSON.stringify({
        name: 'kernel-echo',
        cols: 70,
        rows: 24,
        steps: [
          { type: 'keys', text: 'x' },
          { type: 'expect', target: 'composer', includes: '❯ x', metric: 'typing_echo_ms' },
        ],
      })
    );
    const kernelEcho = spawnSync(
      'python3',
      [path.join(scriptDir, 'driver.py'), '--scenario', fakeScenario, '--out', reportPath],
      { cwd: emptyRoot, encoding: 'utf8', timeout: 30_000 }
    );
    assert.notEqual(
      kernelEcho.status,
      0,
      'terminal kernel echo must not pass as an application echo'
    );
    assert.equal(
      fs.existsSync(reportPath),
      false,
      'an application that never enters raw mode must not publish a report'
    );

    fs.writeFileSync(
      path.join(emptyRoot, 'dist/cli.js'),
      "process.stdin.setRawMode(true); process.stdin.on('data', chunk => process.stdout.write(chunk)); process.stdout.write('─'.repeat(70) + '\\r\\n❯ \\r\\n' + '─'.repeat(70) + '\\x1b[1A\\x1b[3G'); setTimeout(() => process.exit(0), 2000);\n"
    );
    const applicationEcho = spawnSync(
      'python3',
      [path.join(scriptDir, 'driver.py'), '--scenario', fakeScenario, '--out', reportPath],
      { cwd: emptyRoot, encoding: 'utf8', timeout: 30_000 }
    );
    assert.equal(applicationEcho.status, 0, `${applicationEcho.stdout}\n${applicationEcho.stderr}`);
    assert.equal(
      fs.existsSync(reportPath),
      true,
      'the same screen and application echo should pass'
    );
    fs.rmSync(reportPath);

    fs.writeFileSync(
      path.join(emptyRoot, 'dist/cli.js'),
      "process.stdin.setRawMode(true); process.stdin.on('data', chunk => process.stdout.write(chunk)); process.stdout.write(' ❯ 1. Yes'); setTimeout(() => process.exit(0), 2000);\n"
    );
    fs.writeFileSync(
      fakeScenario,
      JSON.stringify({
        name: 'approval-selector',
        cols: 70,
        rows: 24,
        steps: [
          { type: 'keys', text: 'x' },
          { type: 'expect', target: 'composer', includes: '❯ 1. Yesx', metric: 'typing_echo_ms' },
        ],
      })
    );
    const selector = spawnSync(
      'python3',
      [path.join(scriptDir, 'driver.py'), '--scenario', fakeScenario, '--out', reportPath],
      { cwd: emptyRoot, encoding: 'utf8', timeout: 30_000 }
    );
    assert.notEqual(selector.status, 0, 'an approval option must not be mistaken for a composer');
    assert.equal(fs.existsSync(reportPath), false);

    // This deliberately dishonest CLI leaves the HTTP stream open after Esc.
    fs.writeFileSync(
      path.join(emptyRoot, 'dist/cli.js'),
      String.raw`
const fs = require('node:fs');
const http = require('node:http');
const cfg = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--config-file') + 1], 'utf8'));
const rule = '─'.repeat(70);
let request;
let streamed = false;
function render(header, status) {
  process.stdout.write('\x1b[2J\x1b[H' + header + '\r\n' + rule + '\r\n❯ \r\n' + rule + '\r\n' + status + '\x1b[3;3H');
}
process.stdin.setRawMode(true);
process.stdin.on('data', (data) => {
  if (data.toString() === '\r') {
    request = http.request(cfg.baseUrl + '/chat/completions', { method: 'POST' }, (response) => {
      response.on('data', () => {
        if (!streamed) { streamed = true; render('Section 1', 'Esc to interrupt'); }
      });
    });
    request.on('error', () => {});
    request.end(JSON.stringify({ messages: [{ role: 'user', content: 'longstream' }] }));
  } else if (data.toString() === '\x1b') {
    render('Interrupted', 'idle'); // Intentionally does not close request/response.
  }
});
render('ready', 'idle');
setTimeout(() => process.exit(0), 8000);
`
    );
    const fakeInterrupt = {
      name: 'fake-interrupt',
      cols: 70,
      rows: 24,
      steps: [
        { type: 'keys', text: '\r' },
        { type: 'expect', includes: 'Section 1', alsoIncludes: 'Esc to interrupt' },
        { type: 'keys', text: '\x1b' },
        {
          type: 'expect',
          includes: 'Interrupted',
          excludes: 'Esc to interrupt',
          composerReady: true,
        },
      ],
    };
    fs.writeFileSync(fakeScenario, JSON.stringify(fakeInterrupt));
    const uiOnly = spawnSync(
      'python3',
      [path.join(scriptDir, 'driver.py'), '--scenario', fakeScenario, '--out', reportPath],
      {
        cwd: emptyRoot,
        encoding: 'utf8',
        timeout: 30_000,
      }
    );
    assert.equal(
      uiOnly.status,
      0,
      `the fake CLI reproduces a misleading UI success: ${uiOnly.stderr}`
    );
    fs.rmSync(reportPath);
    fakeInterrupt.steps[3].streamCancelled = true;
    fakeInterrupt.steps[3].timeout_ms = 700;
    fs.writeFileSync(fakeScenario, JSON.stringify(fakeInterrupt));
    const fakeCancel = spawnSync(
      'python3',
      [path.join(scriptDir, 'driver.py'), '--scenario', fakeScenario, '--out', reportPath],
      {
        cwd: emptyRoot,
        encoding: 'utf8',
        timeout: 30_000,
      }
    );
    assert.notEqual(
      fakeCancel.status,
      0,
      'fake interruption must not satisfy upstream cancellation'
    );
    assert.match(
      `${fakeCancel.stdout}${fakeCancel.stderr}`,
      /timed out waiting for stub stream cancellation/
    );
    assert.equal(fs.existsSync(reportPath), false);
  } finally {
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
  console.log('[PASS] TUI feel fails when the CLI build is unavailable');

  const timeoutProbe = `
import sys, time
sys.path.insert(0, sys.argv[1])
import driver
class Process:
    def poll(self): return None
class Session:
    proc = stub = Process()
    ready = False
    def pump_once(self, timeout):
        time.sleep(0.05)
        self.ready = True
session = Session()
try:
    driver.wait_for(session, lambda: session.ready, 0.01, 'late frame')
except RuntimeError as error:
    if 'timed out' in str(error): sys.exit(0)
sys.exit(1)
`;
  const lateFrame = spawnSync(
    'python3',
    ['-c', timeoutProbe, path.join(root, 'scripts/tui-feel')],
    {
      encoding: 'utf8',
      timeout: 10_000,
    }
  );
  assert.equal(lateFrame.status, 0, 'a frame observed after the deadline must not pass');
  console.log('[PASS] TUI feel rejects frames observed after the deadline');

  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-feel-results-'));
  try {
    const driver = path.join(root, 'scripts/tui-feel/driver.py');
    const reportPath = path.join(resultsDir, 'report.json');
    const run = spawnSync('python3', [driver, '--out', reportPath], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        MOSS_NO_TUI: '1',
        MOSS_LANG: 'zh',
        MOSS_CONFIG_FILE: path.join(resultsDir, 'wrong-config.json'),
        MOSS_DEVICE_HOST: 'must-not-be-used.example',
        OPENAI_API_KEY: 'must-not-be-used',
      },
      timeout: 90_000,
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.match(report.timing, /monotonic/i);
    for (const [cols, rows] of [
      [100, 30],
      [70, 24],
    ]) {
      const result = report.scenarios.find((item) => item.cols === cols && item.rows === rows);
      assert.ok(result, `a real PTY run is required at ${cols}x${rows}`);
      assert.equal(result.status, 'passed');
      for (const metric of [
        'composer_ready_ms',
        'typing_echo_ms',
        'first_stream_ms',
        'interrupt_ms',
        'post_interrupt_echo_ms',
      ]) {
        assert.ok(Number.isFinite(result.metrics[metric]) && result.metrics[metric] >= 0, metric);
      }
      assert.equal(result.steps[0].type, 'keys');
      assert.equal(
        result.steps[0].text.length,
        1,
        'typing_echo_ms must measure a single keystroke'
      );
      assert.equal(result.steps[1].type, 'expect');
      assert.equal(result.steps[1].target, 'composer');
      assert.ok(
        result.steps[1].observed.includes(`❯ ${result.steps[0].text}`),
        'the first keystroke must be visible in the composer'
      );
      const assertions = result.steps.filter((step) => step.type === 'expect');
      assert.ok(
        assertions.some((step) => step.observed.includes('longstream')),
        'typed text was observed'
      );
      assert.ok(
        assertions.some((step) => step.observed.includes('Section 1')),
        'streamed text was observed'
      );
      assert.ok(
        assertions.some((step) => /interrupted/i.test(step.observed)),
        'interruption was observed'
      );
      const interrupted = assertions.find((step) => step.includes === 'Interrupted');
      const cancellation = interrupted?.streamCancellation;
      assert.ok(cancellation, 'the local stub must observe the interrupted stream close');
      assert.ok(cancellation.sentChunks > 0 && cancellation.sentChunks < cancellation.totalChunks);
      assert.ok(
        assertions.some(
          (step) => step.target === 'composer' && step.observed.includes('aftercancel')
        ),
        'the composer accepts input after interruption'
      );
    }
    console.log('[PASS] TUI feel measures typing and streaming interruption at both sizes');

    const customPath = path.join(resultsDir, 'custom.json');
    const customReport = path.join(resultsDir, 'custom-report.json');
    fs.writeFileSync(
      customPath,
      JSON.stringify({
        name: 'wrapped-composer',
        cols: 70,
        rows: 24,
        steps: [
          { type: 'keys', text: 'x' },
          { type: 'expect', target: 'composer', includes: '❯ x' },
          { type: 'keys', text: `${'z'.repeat(90)} WRAPPED-END` },
          {
            type: 'expect',
            target: 'composer',
            includes: 'WRAPPED-END',
            metric: 'wrapped_echo_ms',
          },
        ],
      })
    );
    const wrapped = spawnSync(
      'python3',
      [driver, '--scenario', customPath, '--out', customReport],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
      }
    );
    assert.equal(wrapped.status, 0, `wrapped composer: ${wrapped.stdout}\n${wrapped.stderr}`);
    fs.rmSync(customReport);

    fs.writeFileSync(
      customPath,
      JSON.stringify({
        name: 'existing-text-new-condition',
        cols: 70,
        rows: 24,
        steps: [
          { type: 'keys', text: 'hello' },
          { type: 'expect', target: 'composer', includes: '❯ hello' },
          { type: 'keys', text: '\r' },
          { type: 'expect', includes: 'hello', alsoIncludes: 'Done.', metric: 'reply_ms' },
        ],
      })
    );
    const existingText = spawnSync(
      'python3',
      [driver, '--scenario', customPath, '--out', customReport],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
      }
    );
    assert.equal(
      existingText.status,
      0,
      `new condition: ${existingText.stdout}\n${existingText.stderr}`
    );
    fs.rmSync(customReport);
    fs.writeFileSync(
      customPath,
      JSON.stringify({
        name: 'already-satisfied',
        cols: 70,
        rows: 24,
        steps: [
          { type: 'keys', text: 'x' },
          { type: 'expect', target: 'composer', includes: '❯ x' },
          { type: 'keys', text: 'y' },
          { type: 'expect', target: 'composer', includes: '❯ x', metric: 'stale_ms' },
        ],
      })
    );
    const stale = spawnSync('python3', [driver, '--scenario', customPath, '--out', customReport], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.notEqual(stale.status, 0, 'a metric cannot time an already satisfied condition');
    assert.match(`${stale.stdout}${stale.stderr}`, /already satisfied/);
    assert.equal(fs.existsSync(customReport), false);
    console.log('[PASS] TUI feel handles wrapped composers and existing text with a new condition');

    const impossiblePath = path.join(resultsDir, 'impossible.json');
    const failureReport = path.join(resultsDir, 'failure.json');
    fs.writeFileSync(
      impossiblePath,
      JSON.stringify({
        name: 'impossible',
        cols: 70,
        rows: 24,
        steps: [
          { type: 'keys', text: 'hello' },
          {
            type: 'expect',
            target: 'composer',
            includes: '__never_on_composer__',
            timeout_ms: 300,
          },
        ],
      })
    );
    const impossible = spawnSync(
      'python3',
      [driver, '--scenario', impossiblePath, '--out', failureReport],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
      }
    );
    assert.notEqual(impossible.status, 0, 'an unmet JSON step must fail');
    assert.match(`${impossible.stdout}${impossible.stderr}`, /timed out.*__never_on_composer__/);
    assert.equal(
      fs.existsSync(failureReport),
      false,
      'an unmet expectation must not publish a report'
    );
    console.log('[PASS] TUI feel executes JSON expectations and fails on a timeout');

    const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
    });
    assert.equal(python.status, 0);
    const noComparator = spawnSync(
      python.stdout.trim(),
      [
        path.join(root, 'scripts/tui-feel/compare_feel.py'),
        '--compare',
        'claude',
        '--out',
        failureReport,
      ],
      { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: resultsDir }, timeout: 10_000 }
    );
    assert.notEqual(noComparator.status, 0, 'a missing comparator must not pass as a comparison');
    assert.match(`${noComparator.stdout}${noComparator.stderr}`, /claude.*not available/i);
    assert.equal(fs.existsSync(failureReport), false);
    console.log('[PASS] TUI feel does not silently skip a requested comparison');
  } finally {
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }
}
