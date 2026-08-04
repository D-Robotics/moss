/**
 * probeDeviceSsh on win32 — a standalone ssh probe is transient-flaky (askpass
 * race, slow handshake). A single probe failure must be retried before
 * declaring the device unreachable, otherwise startup/preflight probes flip
 * /connect to failed on a transient blip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeDeviceSsh } from '../dist/tools/device-ssh.js';
import { ProcessError } from '../dist/utils/run-process.js';

/** Fake executor that returns a ProcessError-shaped failure for the first N
 *  calls then a successful hostname echo. Mirrors DeviceSshExecutor.run(). */
function fakeExecutor({ failTimes = 0, hostname = 'ubuntu' } = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    async run(remoteCommand, options = {}) {
      calls += 1;
      if (calls <= failTimes) {
        // exit 1, no transport-failure text → transient, retryable
        throw new ProcessError(1, '', 'ssh: transient handshake blip', false);
      }
      return { stdout: `${hostname}\n`, stderr: '', exitCode: 0, timedOut: false, command: remoteCommand };
    },
  };
}

test('probeDeviceSsh on win32 retries a transient failure before giving up', async () => {
  const exec = fakeExecutor({ failTimes: 1 });
  const result = await probeDeviceSsh(
    { host: '192.168.127.10', user: 'root', port: 22, platformOverride: 'win32' },
    { executor: exec }
  );
  assert.equal(result.ok, true, 'first probe failed but retry succeeded');
  assert.equal(result.detail, 'ubuntu');
  assert.equal(exec.calls(), 2, 'one failed probe + one retry');
});

test('probeDeviceSsh on win32 still fails when every retry fails', async () => {
  const exec = fakeExecutor({ failTimes: 99 });
  const result = await probeDeviceSsh(
    { host: '192.168.127.10', user: 'root', port: 22, platformOverride: 'win32' },
    { executor: exec }
  );
  assert.equal(result.ok, false);
  assert.equal(exec.calls(), 2, 'initial probe + one retry, both failed');
});

test('probeDeviceSsh on non-win32 does NOT retry (one-strike, historical behavior)', async () => {
  const exec = fakeExecutor({ failTimes: 1 });
  const result = await probeDeviceSsh(
    { host: '192.168.127.10', user: 'root', port: 22, platformOverride: 'linux' },
    { executor: exec }
  );
  assert.equal(result.ok, false, 'non-win32 keeps historical one-strike behavior');
  assert.equal(exec.calls(), 1, 'no retry on linux');
});
