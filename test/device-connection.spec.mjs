#!/usr/bin/env node
/**
 * SshDeviceConnection against an in-process ssh2 server — real protocol
 * handshake, exec streams, SFTP read/write/list, timeout, auth failure,
 * reconnect, and registry connection reuse.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SshDeviceConnection } from '../dist/device/ssh-device-connection.js';
import { getDeviceConnection, disconnectAllDevices } from '../dist/device/device-registry.js';
import { startInProcessSshDevice } from './helpers/in-process-ssh-device.mjs';

const PASSWORD_ENV = 'MOSS_TEST_DEVICE_PASSWORD';

function makeTarget(port, overrides = {}) {
  return {
    deviceId: 'test-device',
    kind: 'linux',
    host: '127.0.0.1',
    port,
    user: 'tester',
    auth: { method: 'password', passwordEnvVar: PASSWORD_ENV },
    ...overrides,
  };
}

test('SSH transport: exec roundtrip, exit codes, stderr, timeout', async (t) => {
  process.env[PASSWORD_ENV] = 'swordfish';
  const device = await startInProcessSshDevice({
    commands: {
      'echo hello': { stdout: 'hello\n' },
      'failing-cmd': { stdout: 'partial\n', stderr: 'boom\n', exit: 3 },
      'hang-forever': { hang: true },
    },
  });
  t.after(() => device.close());

  const conn = new SshDeviceConnection(makeTarget(device.port));
  t.after(() => conn.disconnect());

  const ok = await conn.exec('echo hello');
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout, 'hello\n');
  assert.equal(ok.timedOut, false);

  const fail = await conn.exec('failing-cmd');
  assert.equal(fail.exitCode, 3);
  assert.equal(fail.stdout, 'partial\n');
  assert.equal(fail.stderr, 'boom\n');

  const timedOut = await conn.exec('hang-forever', { timeoutMs: 400 });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.exitCode, null);
  // Channel survived the timeout: further exec still works on the same session.
  const after = await conn.exec('echo hello');
  assert.equal(after.stdout, 'hello\n');
});

test('SSH transport: SFTP read, missing file, write, list', async (t) => {
  process.env[PASSWORD_ENV] = 'swordfish';
  const device = await startInProcessSshDevice();
  t.after(() => device.close());

  const conn = new SshDeviceConnection(makeTarget(device.port));
  t.after(() => conn.disconnect());

  const content = await conn.readFile('/etc/os-release');
  assert.match(content, /Ubuntu 22\.04\.5 LTS/);

  await assert.rejects(conn.readFile('/nope/missing.txt'), /Cannot stat/);

  await conn.writeFile('/tmp/deployed.txt', { content: 'artifact-body' });
  assert.equal(device.files.get('/tmp/deployed.txt').toString(), 'artifact-body');
  const roundtrip = await conn.readFile('/tmp/deployed.txt');
  assert.equal(roundtrip, 'artifact-body');

  const entries = await conn.listDir('/');
  const etc = entries.find((e) => e.name === 'etc');
  assert.equal(etc.type, 'dir');
  const tmp = entries.find((e) => e.name === 'tmp');
  assert.equal(tmp.type, 'dir');
  const osrelease = await conn.listDir('/etc');
  assert.equal(osrelease.find((e) => e.name === 'os-release')?.type, 'file');
});

test('SSH transport: auth failure surfaces a connective MossError, retry recovers', async (t) => {
  const device = await startInProcessSshDevice();
  t.after(() => device.close());

  process.env[PASSWORD_ENV] = 'wrong-password';
  const conn = new SshDeviceConnection(makeTarget(device.port));
  await assert.rejects(conn.connect(), /Cannot connect/);
  assert.equal(conn.status, 'error');

  process.env[PASSWORD_ENV] = 'swordfish';
  const retry = await conn.connect();
  assert.ok(retry);
  assert.equal(conn.status, 'connected');
  await conn.disconnect();
});

test('SSH transport: missing credentials rejected before connecting', async () => {
  delete process.env[PASSWORD_ENV];
  const conn = new SshDeviceConnection({
    ...makeTarget(1),
    auth: { method: 'password', passwordEnvVar: PASSWORD_ENV },
  });
  await assert.rejects(conn.connect(), /No credentials/);
});

test('device registry: single connection per endpoint, shared across callers', async (t) => {
  process.env[PASSWORD_ENV] = 'swordfish';
  const device = await startInProcessSshDevice({
    commands: { 'echo shared': { stdout: 'shared\n' } },
  });
  t.after(async () => {
    await disconnectAllDevices();
    await device.close();
  });

  const a = await getDeviceConnection(makeTarget(device.port));
  const b = await getDeviceConnection(makeTarget(device.port, { deviceId: 'other-label' }));
  assert.equal(a, b, 'same endpoint reuses one multiplexed connection');

  const result = await a.exec('echo shared');
  assert.equal(result.stdout, 'shared\n');
  assert.equal(a.execCount, 1);
});
