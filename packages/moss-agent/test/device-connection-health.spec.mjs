import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DeviceConnectionHealth,
  DeviceConnectionLostError,
} from '../dist/tools/device-connection-health.js';
import { ProcessError } from '../dist/utils/run-process.js';
import {
  buildDeviceCamerasCommand,
  buildDeviceRoboticsStatusCommand,
} from '../dist/tools/device-diagnostics.js';
import {
  buildRosEnvironmentCommand,
  createRos1Tools,
} from '../dist/tools/device-ros1.js';
import { spawnSync } from 'node:child_process';
import { errorMessage } from '../dist/errors.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry } from '../dist/core/tools/tool-registry.js';
import {
  connectDeviceForSession,
  disconnectDeviceForSession,
} from '../dist/cli/device-connect.js';
import { installFakeSsh } from './helpers/fake-ssh.mjs';

const config = { host: '192.168.127.10', user: 'root', port: 22, platformOverride: 'linux' };

function assertShellSyntax(command, shell) {
  const syntax = spawnSync(shell, ['-n', '-c', command], { encoding: 'utf8' });
  if (syntax.error?.code === 'ENOENT') return;
  assert.equal(syntax.status, 0, syntax.stderr);
}

test('a timed-out command probes once, then opens the shared connection circuit', async () => {
  let probes = 0;
  const health = new DeviceConnectionHealth(config, {
    probe: async () => {
      probes += 1;
      return { ok: false, detail: 'Connection timed out', kind: 'unreachable' };
    },
  });

  const timeout = new ProcessError(1, '', '', true);
  await assert.rejects(
    health.handleFailure(timeout, { operation: 'device_cameras' }),
    (error) => {
      assert.ok(error instanceof DeviceConnectionLostError);
      assert.match(error.message, /Device connection lost/i);
      assert.match(error.message, /root@192\.168\.127\.10:22/);
      assert.match(errorMessage(error), /\/connect root@192\.168\.127\.10/);
      return true;
    }
  );
  assert.equal(probes, 1);

  await assert.rejects(
    health.beforeOperation('device_info'),
    (error) => {
      assert.ok(error instanceof DeviceConnectionLostError);
      assert.match(errorMessage(error), /fail(?:ed)? fast|reconnect/i);
      return true;
    }
  );
  assert.equal(probes, 1, 'an open circuit must not launch another SSH probe');
});

test('remote command failures do not mark a healthy SSH transport disconnected', async () => {
  let probes = 0;
  const health = new DeviceConnectionHealth(config, {
    probe: async () => {
      probes += 1;
      return { ok: true, detail: 'ubuntu' };
    },
  });

  const remoteExit = new ProcessError(2, '', 'ls: missing path');
  await health.handleFailure(remoteExit, { operation: 'exec' });
  await health.beforeOperation('device_info');
  assert.equal(probes, 0, 'ordinary remote exit codes must not trigger a liveness probe');
});

test('ambiguous exit 255 probes health and preserves the remote failure when connected', async () => {
  let probes = 0;
  const health = new DeviceConnectionHealth(config, {
    probe: async () => {
      probes += 1;
      return { ok: true, detail: 'ubuntu' };
    },
  });
  const remoteExit = new ProcessError(255, '', 'remote command failed');

  const runRemoteCommand = async () => {
    try {
      throw remoteExit;
    } catch (error) {
      await health.handleFailure(error, { operation: 'exec' });
      throw error;
    }
  };

  await assert.rejects(runRemoteCommand(), (error) => error === remoteExit);
  assert.equal(probes, 1);
  assert.equal(health.snapshot().state, 'connected');
  await health.beforeOperation('device_info');
});

test('explicit SSH transport failures open the circuit without an extra probe', async () => {
  let probes = 0;
  const health = new DeviceConnectionHealth(config, {
    probe: async () => {
      probes += 1;
      return { ok: true, detail: 'ubuntu' };
    },
  });

  await assert.rejects(
    health.handleFailure(
      new ProcessError(255, '', 'ssh: connect to host 192.168.127.10 port 22: No route to host'),
      { operation: 'device_network' }
    ),
    DeviceConnectionLostError
  );
  assert.equal(probes, 0);
  await assert.rejects(health.beforeOperation('exec'), DeviceConnectionLostError);
});

test('probeRetries tolerates a transient probe failure on win32 (one-shot ssh is flaky)', async () => {
  // On win32 each probe is a standalone ssh (no ControlMaster reuse); a single
  // transient probe failure must not flip the circuit to disconnected. With
  // probeRetries: 1, the first failed probe is retried; if the retry succeeds
  // the connection stays healthy.
  let probes = 0;
  const health = new DeviceConnectionHealth(config, {
    probe: async () => {
      probes += 1;
      return probes === 1
        ? { ok: false, detail: 'SSH probe failed (exit 1)', kind: 'unreachable' }
        : { ok: true, detail: 'ubuntu' };
    },
    probeRetries: 1,
  });

  const timeout = new ProcessError(1, '', '', true);
  await health.handleFailure(timeout, { operation: 'device_cameras' });
  assert.equal(probes, 2, 'one failed probe is retried before disconnecting');
  assert.equal(health.snapshot().state, 'connected', 'transient probe failure did not disconnect');
  await health.beforeOperation('device_info');
});

test('probeRetries still disconnects when every retry fails', async () => {
  let probes = 0;
  const health = new DeviceConnectionHealth(config, {
    probe: async () => {
      probes += 1;
      return { ok: false, detail: 'Connection timed out', kind: 'unreachable' };
    },
    probeRetries: 1,
  });

  const timeout = new ProcessError(1, '', '', true);
  await assert.rejects(
    health.handleFailure(timeout, { operation: 'device_cameras' }),
    DeviceConnectionLostError
  );
  assert.equal(probes, 2, 'initial probe + one retry both failed');
  assert.equal(health.snapshot().state, 'disconnected');
});

test('camera discovery command is valid shell and treats no cameras as a result', () => {
  const command = buildDeviceCamerasCommand();
  assertShellSyntax(command, '/bin/sh');
  assert.match(command, /No video devices found/);
  assert.match(command, /media-ctl/);
  assert.match(command, /\/dev\/v4l-subdev/);
  assert.match(command, /sensor|csi|mipi/i);
});

test('ROS1 commands discover installed distro and source workspaces without assuming ROS2', () => {
  const command = buildRosEnvironmentCommand('rostopic list');
  assertShellSyntax(command, '/bin/bash');
  assert.match(command, /\/opt\/ros\/\*\/setup\.bash/);
  assert.match(command, /devel\/setup\.bash/);
  assert.match(command, /install\/setup\.bash/);
  assert.match(command, /rostopic list/);
  assert.ok(createRos1Tools(config).some((tool) => tool.name === 'ros1_topic_list'));
});

test('robotics status discovers real board capabilities before choosing tools', () => {
  const command = buildDeviceRoboticsStatusCommand();
  assertShellSyntax(command, '/bin/sh');
  assert.match(command, /ROS1.*ROS2|ROS2.*ROS1/i);
  assert.match(command, /video\*.*v4l-subdev\*.*media\*/);
  assert.match(command, /ttyUSB|ttyACM/);
  assert.match(command, /can|i2c/i);
  assert.match(command, /BPU|NPU|accelerator/i);
  assert.match(command, /devel\/setup\.bash|install\/setup\.bash/);
});

test('/connect shares one circuit across board and device tools', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-fake-ssh-'));
  const binDir = path.join(dir, 'bin');
  const callsFile = path.join(dir, 'calls.log');
  await fs.mkdir(binDir);
  const fakeSsh = await installFakeSsh(binDir, {
    callsFile,
    responses: [
      { includes: 'ControlMaster=yes', exitCode: 0 },
      { includes: '-O exit', exitCode: 0 },
    ],
    defaultExitCode: 255,
    defaultStderr: 'ssh: connect to host 192.168.127.10 port 22: No route to host\n',
  });
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath}`;
  t.after(async () => {
    process.env.PATH = oldPath;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const tools = new ToolRegistry();
  tools.register({
    name: 'exec',
    description: 'local exec placeholder',
    inputSchema: { type: 'object', properties: {} },
    async execute() { return 'local'; },
  });
  const agent = { tools, config: { extraPromptLayers: [] } };
  const runtime = { device: null, deviceSession: null };
  const connected = await connectDeviceForSession(agent, runtime, { ...config, ...fakeSsh }, {
    skipVerify: true,
    mode: 'board',
  });
  assert.equal(connected.ok, true);
  assert.equal(runtime.device.connectionState, 'connected');
  assert.ok(tools.get('device_robotics_status'));
  assert.ok(tools.get('ros1_topic_list'));
  assert.ok(tools.get('ros2_topic_list'));

  const ctx = { workspaceDir: dir, sessionKey: 'test', abortSignal: new AbortController().signal };
  await assert.rejects(tools.get('exec').execute({ command: 'true' }, ctx), /Device connection lost/);
  assert.equal(runtime.device.connectionState, 'disconnected');
  assert.match(runtime.device.connectionReason, /No route to host/);

  await assert.rejects(tools.get('device_info').execute({}, ctx), /Device connection lost/);
  const callsBeforeDisconnect = (await fs.readFile(callsFile, 'utf8')).trim().split('\n');
  assert.equal(
    callsBeforeDisconnect.filter((line) => line.includes('ControlMaster=yes')).length,
    1,
    'connect must establish exactly one SSH master'
  );
  assert.equal(
    callsBeforeDisconnect.length,
    3,
    'connect performs one fixed identity probe; the second tool still fails before another SSH command'
  );

  await disconnectDeviceForSession(agent, runtime);
  const calls = (await fs.readFile(callsFile, 'utf8')).trim().split('\n');
  assert.equal(calls.filter((line) => line.includes('-O exit')).length, 1);
});

test('/connect reuses one persistent SSH session across robotics, camera, ROS1, and ROS2 tools', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-robotics-session-'));
  const binDir = path.join(dir, 'bin');
  const callsFile = path.join(dir, 'calls.log');
  await fs.mkdir(binDir);
  const fakeSsh = await installFakeSsh(binDir, {
    callsFile,
    responses: [
      { includes: 'Robot Development Environment', stdout: 'ROS1: available\nROS2: available\n' },
      { includes: 'Camera Device Nodes', stdout: '/dev/video0\n/dev/v4l-subdev0\n' },
      { includes: 'rostopic list', stdout: '/camera/image_raw\n' },
      { includes: 'ros2 topic list', stdout: '/camera/image_raw [sensor_msgs/msg/Image]\n' },
    ],
  });
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath}`;
  t.after(async () => {
    process.env.PATH = oldPath;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const tools = new ToolRegistry();
  const agent = { tools, config: { extraPromptLayers: [] } };
  const runtime = { device: null, deviceSession: null };
  const connected = await connectDeviceForSession(agent, runtime, { ...config, ...fakeSsh }, {
    skipVerify: true,
    mode: 'hybrid',
  });
  assert.equal(connected.ok, true);
  const ctx = { workspaceDir: dir, sessionKey: 'test', abortSignal: new AbortController().signal };

  assert.match(await tools.get('device_robotics_status').execute({}, ctx), /ROS1: available/);
  assert.match(await tools.get('device_cameras').execute({}, ctx), /v4l-subdev0/);
  assert.match(await tools.get('ros1_topic_list').execute({}, ctx), /camera\/image_raw/);
  assert.match(await tools.get('ros2_topic_list').execute({}, ctx), /sensor_msgs/);
  await disconnectDeviceForSession(agent, runtime);

  const calls = (await fs.readFile(callsFile, 'utf8')).trim().split('\n');
  assert.equal(calls.filter((line) => line.includes('ControlMaster=yes')).length, 1);
  assert.equal(calls.filter((line) => line.includes('-O check')).length, 5, 'four tools plus one cached connection identity probe');
  assert.equal(calls.filter((line) => line.includes('-O exit')).length, 1);
  const controlPaths = calls
    .map((line) => line.match(/ControlPath=([^ ]+)/)?.[1])
    .filter(Boolean);
  assert.equal(new Set(controlPaths).size, 1);
});

test('/connect cleans the persistent session when initial SSH establishment fails', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-connect-fail-cleanup-'));
  const binDir = path.join(dir, 'bin');
  await fs.mkdir(binDir);
  const fakeSsh = await installFakeSsh(binDir, {
    defaultExitCode: 255,
    defaultStderr: 'ssh: connect to host offline.local port 22: No route to host\n',
  });
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath}`;
  t.after(async () => {
    process.env.PATH = oldPath;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const before = process.listenerCount('exit');
  const tools = new ToolRegistry();
  const agent = { tools, config: { extraPromptLayers: [] } };
  const runtime = { device: null, deviceSession: null };
  const result = await connectDeviceForSession(
    agent,
    runtime,
    { host: 'offline.local', user: 'root', port: 22, platformOverride: 'linux', ...fakeSsh },
    { skipVerify: true, mode: 'hybrid' }
  );

  assert.equal(result.ok, false);
  assert.equal(process.listenerCount('exit'), before);
  assert.equal(runtime.deviceSession, null);
  assert.equal(tools.size, 0);
});
