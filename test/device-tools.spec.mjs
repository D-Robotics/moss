#!/usr/bin/env node
/**
 * Device tools end-to-end against the in-process SSH device: observation
 * probes, exec formatting/safety, file read/list/write, target resolution,
 * and side-effect metadata contracts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  deviceInfoTool,
  deviceExecTool,
  deviceFileReadTool,
  deviceFileListTool,
  deviceFileWriteTool,
  deviceProcessesTool,
  deviceResourcesTool,
  deviceTemperatureTool,
  deviceTools,
} from '../dist/tools/device-tools.js';
import { configureDefaultDeviceTarget } from '../dist/device/device-target.js';
import { disconnectAllDevices } from '../dist/device/device-registry.js';
import {
  INFO_PROBE_SCRIPT,
  PROCESSES_PROBE_SCRIPT,
  RESOURCES_PROBE_SCRIPT,
  TEMPERATURE_PROBE_SCRIPT,
} from '../dist/device/observation.js';
import { startInProcessSshDevice } from './helpers/in-process-ssh-device.mjs';

const PASSWORD_ENV = 'MOSS_TEST_DEVICE_PASSWORD';

const INFO_OUTPUT = [
  'S|Linux|rdkx5|5.10.198|aarch64',
  'CPU|Cortex-A55',
  'HW|sun55iw3',
  'OS|Ubuntu 22.04.5 LTS',
  'CORES|8',
  'MEMTOTAL|8173408',
  'MEMAVAIL|1234567',
  'UPTIME|275559.36',
  'LOADAVG|0.42 0.35 0.30 1/512 9876',
].join('\n');

const PROCESSES_OUTPUT = [
  '  123 root                 12.3  1.2    12345  /usr/bin/python3 app.py',
  ' 456 ubuntu                 0.5  0.1     1024  /bin/bash',
].join('\n');

const RESOURCES_OUTPUT = [
  'MEMTOTAL|8173408',
  'MEMAVAIL|6000000',
  'LOADAVG|0.1 0.2 0.3 1/8 99',
  '/dev/mmcblk0p8      30800600 12345600 16893400  43% /',
].join('\n');

const TEMPERATURE_OUTPUT = 'ZONE|thermal_zone0|cpu-thermal|45000\n';

function makeCtx(workspaceDir) {
  return {
    workspaceDir,
    sessionKey: 'device-tools-test',
    abortSignal: new AbortController().signal,
  };
}

test('device tools: observation, exec, and file lifecycle over a real SSH session', async (t) => {
  process.env[PASSWORD_ENV] = 'swordfish';
  const device = await startInProcessSshDevice({
    commands: {
      [INFO_PROBE_SCRIPT]: { stdout: INFO_OUTPUT },
      [PROCESSES_PROBE_SCRIPT]: { stdout: PROCESSES_OUTPUT },
      [RESOURCES_PROBE_SCRIPT]: { stdout: RESOURCES_OUTPUT },
      [TEMPERATURE_PROBE_SCRIPT]: { stdout: TEMPERATURE_OUTPUT },
      'echo hello device': { stdout: 'hello device\n' },
      'systemctl status broken': {
        stdout: '',
        stderr: 'Unit broken.service not loaded.\n',
        exit: 5,
      },
    },
  });
  t.after(async () => {
    await disconnectAllDevices();
    await device.close();
  });
  configureDefaultDeviceTarget({
    deviceId: 'rdk-test',
    kind: 'rdk',
    host: '127.0.0.1',
    port: device.port,
    user: 'tester',
    auth: { method: 'password', passwordEnvVar: PASSWORD_ENV },
  });

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-device-tools-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const ctx = makeCtx(workspace);

  const info = await deviceInfoTool.execute({}, ctx);
  assert.match(info, /rdk-test \(kind=rdk\) @ tester@127\.0\.0\.1:\d+ — connected/);
  assert.match(info, /hostname: rdkx5/);
  assert.match(info, /Ubuntu 22\.04\.5 LTS/);
  assert.match(info, /hardware: sun55iw3/);

  const procs = await deviceProcessesTool.execute({}, ctx);
  assert.match(procs, /python3 app\.py/);

  const resources = await deviceResourcesTool.execute({}, ctx);
  assert.match(resources, /\/dev\/mmcblk0p8/);

  const temp = await deviceTemperatureTool.execute({}, ctx);
  assert.match(temp, /cpu-thermal\): 45°C/);

  const exec = await deviceExecTool.execute({ command: 'echo hello device' }, ctx);
  assert.match(exec, /hello device/);

  const failed = await deviceExecTool.execute({ command: 'systemctl status broken' }, ctx);
  assert.match(failed, /^exit_code: 5\n/);
  assert.match(failed, /--- stderr ---/);
  assert.match(failed, /not loaded/);

  const read = await deviceFileReadTool.execute({ path: '/etc/os-release' }, ctx);
  assert.match(read, /Ubuntu 22\.04\.5 LTS/);

  const list = await deviceFileListTool.execute({ path: '/' }, ctx);
  assert.match(list, /etc\//);

  const written = await deviceFileWriteTool.execute(
    { path: '/tmp/moss-tool-write.txt', content: 'tool-wrote-this' },
    ctx
  );
  assert.match(written, /Wrote \/tmp\/moss-tool-write\.txt/);
  assert.equal(device.files.get('/tmp/moss-tool-write.txt').toString(), 'tool-wrote-this');

  // Upload path: local file must live inside the workspace.
  const artifactPath = path.join(workspace, 'artifact.bin');
  await fs.writeFile(artifactPath, 'artifact-bytes');
  const uploaded = await deviceFileWriteTool.execute(
    { path: '/tmp/artifact.bin', local_path: 'artifact.bin' },
    ctx
  );
  assert.match(uploaded, /uploaded artifact\.bin/);
  assert.equal(device.files.get('/tmp/artifact.bin').toString(), 'artifact-bytes');

  const escape = await deviceFileWriteTool.execute(
    { path: '/tmp/evil.bin', local_path: path.join(os.tmpdir(), 'outside.txt') },
    ctx
  );
  assert.match(escape, /Error: device_file_write local_path/);
});

test('device tools: dangerous commands are blocked before reaching the device', async (t) => {
  process.env[PASSWORD_ENV] = 'swordfish';
  const device = await startInProcessSshDevice({ commands: {} });
  t.after(async () => {
    await disconnectAllDevices();
    await device.close();
  });
  configureDefaultDeviceTarget({
    deviceId: 'blocked-test',
    kind: 'linux',
    host: '127.0.0.1',
    port: device.port,
    user: 'tester',
    auth: { method: 'password', passwordEnvVar: PASSWORD_ENV },
  });
  const ctx = makeCtx(os.tmpdir());
  const blocked = await deviceExecTool.execute({ command: 'rm -rf /' }, ctx);
  assert.match(blocked, /^Command blocked:/);
});

test('device tools: no target configured returns actionable guidance', async () => {
  configureDefaultDeviceTarget(null);
  const prev = { ...process.env };
  for (const key of [
    'MOSS_DEVICE_HOST',
    'MOSS_DEVICE_PORT',
    'MOSS_DEVICE_USER',
    'MOSS_DEVICE_PASSWORD',
    'MOSS_DEVICE_KEY',
    'MOSS_DEVICE_KIND',
  ]) {
    delete process.env[key];
  }
  try {
    const out = await deviceInfoTool.execute({}, makeCtx(os.tmpdir()));
    assert.match(out, /^Error: device_info: no device target configured/);
    assert.match(out, /MOSS_DEVICE_HOST/);
    assert.match(out, /MOSS_DEVICE_PASSWORD|MOSS_DEVICE_KEY/);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, prev);
  }
});

test('device tools: metadata matches the reserved scaffolding contracts', () => {
  const byName = new Map(deviceTools.map((tool) => [tool.name, tool]));
  assert.equal(byName.size, 12);

  const readonly = [
    'device_info',
    'device_file_read',
    'device_file_list',
    'device_processes',
    'device_resources',
    'device_temperature',
    'device_robotics_status',
    'device_network',
    'device_cameras',
  ];
  for (const name of readonly) {
    assert.equal(byName.get(name).metadata.sideEffectClass, 'readonly', `${name} is readonly`);
    assert.equal(
      byName.get(name).metadata.transientRetry,
      true,
      `${name} retries on transient failure`
    );
  }
  for (const name of ['device_exec', 'device_file_write', 'device_deploy']) {
    assert.equal(
      byName.get(name).metadata.sideEffectClass,
      'device_mutation',
      `${name} mutates the device`
    );
    assert.equal(byName.get(name).metadata.planMode, 'requires_user_confirmation');
  }
  for (const tool of deviceTools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 20, `${tool.name} has a real description`);
  }
});
