#!/usr/bin/env node
// O70: a one-shot run must exit within 2 s even when a handle lingers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Uses POSIX `sleep` and process-group kill (kill(-pid)); no equivalent on win32.
const posixOnly =
  process.platform === 'win32'
    ? 'O70 spec relies on POSIX sleep and process-group kill(-pid); Windows covered by O70 follow-up'
    : false;

const guard = fileURLToPath(new URL('../dist/cli/exit-guard.js', import.meta.url));
const registry = fileURLToPath(
  new URL('../dist/core/tools/background-process-registry.js', import.meta.url)
);

function runChild(source, debug = false) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MOSS_DEBUG_EXIT: debug ? '1' : '' },
    });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    const kill = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.on('close', (code, signal) => {
      clearTimeout(kill);
      resolve({ code, signal, ms: Date.now() - started, stderr });
    });
  });
}

test(
  'baseline: a lingering detached child with pipes keeps node alive (the O70 hang)',
  { skip: posixOnly },
  async () => {
    const r = await runChild(`
    import { spawn } from 'node:child_process';
    spawn('sleep', ['30'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  `);
    assert.equal(r.signal, 'SIGKILL', 'without the guard the process should still be alive at 8 s');
  }
);

test(
  'exit guard forces exit within ~2 s and keeps the exit code',
  { skip: posixOnly },
  async () => {
    const r = await runChild(`
    import { spawn } from 'node:child_process';
    import { armExitGuard } from ${JSON.stringify(guard)};
    const c = spawn('sleep', ['30'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    setInterval(() => {}, 1000);
    process.exitCode = 3;
    armExitGuard();
    process.on('exit', () => { try { process.kill(-c.pid, 'SIGKILL'); } catch {} });
  `);
    assert.equal(r.code, 3);
    assert.ok(r.ms < 4000, `took ${r.ms} ms`);
    // Warning is printed by default (no debug flag) and reports the open-handle count.
    assert.match(
      r.stderr,
      /\[moss\] warning: forcing exit after 2000 ms; [1-9]\d* handle\(s\) still open/
    );
  }
);

test('MOSS_DEBUG_EXIT=1 adds the handle names to the warning', { skip: posixOnly }, async () => {
  const r = await runChild(
    `
    import { armExitGuard } from ${JSON.stringify(guard)};
    setInterval(() => {}, 1000);
    armExitGuard();
  `,
    true
  );
  assert.equal(r.code, 0);
  assert.match(r.stderr, /handle\(s\) still open: .+/);
});

test('exit guard does not delay a clean exit', async () => {
  const r = await runChild(`
    import { armExitGuard } from ${JSON.stringify(guard)};
    armExitGuard();
  `);
  assert.equal(r.code, 0);
  assert.ok(r.ms < 1500, `took ${r.ms} ms`);
  assert.doesNotMatch(r.stderr, /forcing exit/);
});

test('stopAllBackgroundProcesses is exported for CLI shutdown', async () => {
  const mod = await import(registry);
  assert.equal(typeof mod.stopAllBackgroundProcesses, 'function');
});
