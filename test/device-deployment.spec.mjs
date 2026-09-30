#!/usr/bin/env node
/**
 * Deployment lifecycle (device_deploy) — full recorded run against the
 * in-process SSH device: prepare → upload → chmod → start → health check,
 * failure paths, record persistence in .moss/deployments.jsonl.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { deviceDeployTool } from '../dist/tools/device-tools.js';
import { listDeploymentRecords } from '../dist/device/deployment.js';
import { configureDefaultDeviceTarget } from '../dist/device/device-target.js';
import { disconnectAllDevices } from '../dist/device/device-registry.js';
import { startInProcessSshDevice } from './helpers/in-process-ssh-device.mjs';

const PASSWORD_ENV = 'MOSS_TEST_DEVICE_PASSWORD';
const REMOTE = '/opt/moss-test/app.sh';

function makeCtx(workspaceDir) {
  return {
    workspaceDir,
    sessionKey: 'device-deploy-test',
    abortSignal: new AbortController().signal,
  };
}

async function makeWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-deploy-'));
  await fs.writeFile(path.join(dir, 'app.sh'), '#!/bin/sh\necho app-running\n');
  return dir;
}

test('device_deploy runs the full lifecycle and records evidence', async (t) => {
  process.env[PASSWORD_ENV] = 'swordfish';
  const device = await startInProcessSshDevice({
    commands: {
      [`mkdir -p '/opt/moss-test'`]: { exit: 0 },
      [`chmod +x '${REMOTE}'`]: { exit: 0 },
      [`nohup ${REMOTE} >/tmp/app.log 2>&1 &`]: { exit: 0 },
      'systemctl is-active moss-app': { stdout: 'active\n', exit: 0 },
    },
  });
  t.after(async () => {
    await disconnectAllDevices();
    await device.close();
  });
  configureDefaultDeviceTarget({
    deviceId: 'deploy-test',
    kind: 'linux',
    host: '127.0.0.1',
    port: device.port,
    user: 'tester',
    auth: { method: 'password', passwordEnvVar: PASSWORD_ENV },
  });

  const workspace = await makeWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const out = await deviceDeployTool.execute(
    {
      artifact_path: 'app.sh',
      remote_path: REMOTE,
      executable: true,
      start_command: `nohup ${REMOTE} >/tmp/app.log 2>&1 &`,
      health_command: 'systemctl is-active moss-app',
      health_expect: '^active$',
    },
    makeCtx(workspace)
  );

  assert.match(out, /: RUNNING$/m);
  assert.match(out, /prepare-dir: ok/);
  assert.match(out, /upload: ok/);
  assert.match(out, /chmod: ok/);
  assert.match(out, /start: ok/);
  assert.match(out, /health: PASS \(systemctl is-active moss-app\)/);
  assert.doesNotMatch(out, /^Error:/);

  assert.equal(
    device.files.get(REMOTE).toString(),
    '#!/bin/sh\necho app-running\n',
    'artifact bytes landed on the device'
  );

  const records = await listDeploymentRecords(workspace);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'running');
  assert.equal(records[0].healthCheck.passed, true);
  assert.equal(records[0].deviceId, 'deploy-test');
  assert.ok(records[0].deploymentId.startsWith('deploy_'));
});

test('device_deploy with failing health check reports failure honestly', async (t) => {
  process.env[PASSWORD_ENV] = 'swordfish';
  const device = await startInProcessSshDevice({
    commands: {
      [`mkdir -p '/opt/moss-test'`]: { exit: 0 },
      'systemctl is-active moss-app': { stdout: 'inactive\n', stderr: '', exit: 3 },
    },
  });
  t.after(async () => {
    await disconnectAllDevices();
    await device.close();
  });
  configureDefaultDeviceTarget({
    deviceId: 'deploy-fail-test',
    kind: 'linux',
    host: '127.0.0.1',
    port: device.port,
    user: 'tester',
    auth: { method: 'password', passwordEnvVar: PASSWORD_ENV },
  });

  const workspace = await makeWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const out = await deviceDeployTool.execute(
    {
      artifact_path: 'app.sh',
      remote_path: REMOTE,
      health_command: 'systemctl is-active moss-app',
    },
    makeCtx(workspace)
  );
  assert.match(out, /^Error: device_deploy failed/);
  assert.match(out, /: FAILED$/m);
  assert.match(out, /health: FAIL/);

  const [record] = await listDeploymentRecords(workspace);
  assert.equal(record.status, 'failed');
  assert.equal(record.healthCheck.passed, false);
  assert.match(record.error, /health check failed/);
});

test('device_deploy: prepare failure and workspace escape are rejected', async (t) => {
  process.env[PASSWORD_ENV] = 'swordfish';
  const device = await startInProcessSshDevice({
    commands: {
      [`mkdir -p '/opt/moss-test'`]: { stderr: 'Read-only file system\n', exit: 1 },
    },
  });
  t.after(async () => {
    await disconnectAllDevices();
    await device.close();
  });
  configureDefaultDeviceTarget({
    deviceId: 'deploy-guard-test',
    kind: 'linux',
    host: '127.0.0.1',
    port: device.port,
    user: 'tester',
    auth: { method: 'password', passwordEnvVar: PASSWORD_ENV },
  });

  const workspace = await makeWorkspace();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const prepFail = await deviceDeployTool.execute(
    { artifact_path: 'app.sh', remote_path: REMOTE },
    makeCtx(workspace)
  );
  assert.match(prepFail, /^Error: device_deploy failed/);
  assert.match(prepFail, /prepare-dir: failed/);
  assert.match(prepFail, /Read-only file system/);

  const escape = await deviceDeployTool.execute(
    { artifact_path: path.join(os.tmpdir(), 'outside.sh'), remote_path: REMOTE },
    makeCtx(workspace)
  );
  assert.match(escape, /^Error: device_deploy artifact_path/);
});
