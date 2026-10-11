import assert from 'node:assert/strict';
import test from 'node:test';
import { observeHostShellProbe } from '../scripts/check-windows-host-shell.mjs';

test('native shell diagnostics preserve both probe deadlines, arguments and result identity', () => {
  for (const timeout of [3000, 5000]) {
    const receiver = { probe: timeout };
    const args =
      timeout === 3000 ? ['pwsh'] : ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'];
    const options = { timeout, encoding: 'utf8', windowsHide: true };
    const result = {
      status: null,
      signal: 'SIGTERM',
      error: Object.assign(new Error('owned probe'), { code: 'ETIMEDOUT' }),
      stdout: '',
      stderr: '',
    };
    const rows = [];
    let calls = 0;
    const observed = observeHostShellProbe(function (file, actualArgs, actualOptions) {
      calls++;
      assert.equal(this, receiver);
      assert.equal(file, 'owned executable');
      assert.equal(actualArgs, args);
      assert.equal(actualOptions, options);
      return result;
    }, rows);
    assert.equal(observed.call(receiver, 'owned executable', args, options), result);
    assert.equal(calls, 1, 'no retry or cached second probe');
    assert.equal(rows[0].timeoutMs, timeout);
    assert.equal(rows[0].errorCode, 'ETIMEDOUT');
    assert.equal(rows[0].signal, 'SIGTERM');
    assert.equal(rows[0].status, null);
  }
});

test('native observer propagates a delegate exception without manufacturing probe success', () => {
  const failure = new Error('original native exception');
  const rows = [];
  const observed = observeHostShellProbe(() => {
    throw failure;
  }, rows);
  assert.throws(
    () => observed('owned executable', [], { timeout: 3000 }),
    (error) => error === failure
  );
  assert.equal(rows.length, 0);
});
