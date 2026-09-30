#!/usr/bin/env node
/**
 * Device observation parsers — pure functions, fixture-driven (RDK X5-shaped).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseInfoProbe,
  parseProcessesProbe,
  parseResourcesProbe,
  parseTemperatureProbe,
  parseRoboticsProbe,
  formatInfoSnapshot,
  formatProcessList,
  formatResourceSnapshot,
  formatTemperatureSnapshot,
  formatRoboticsSnapshot,
  formatNetworkSnapshot,
  formatCamerasSnapshot,
  parseNetworkProbe,
  parseCamerasProbe,
  formatBytes,
  formatUptime,
} from '../dist/device/observation.js';

const INFO_FIXTURE = [
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

test('parseInfoProbe extracts a full device identity snapshot', () => {
  const snap = parseInfoProbe(INFO_FIXTURE, { deviceId: 'rdk-1', kind: 'rdk' });
  assert.equal(snap.sysname, 'Linux');
  assert.equal(snap.hostname, 'rdkx5');
  assert.equal(snap.kernel, '5.10.198');
  assert.equal(snap.arch, 'aarch64');
  assert.equal(snap.cpuModel, 'Cortex-A55');
  assert.equal(snap.hardware, 'sun55iw3');
  assert.equal(snap.osPrettyName, 'Ubuntu 22.04.5 LTS');
  assert.equal(snap.cpuCores, 8);
  assert.equal(snap.memTotalBytes, 8173408 * 1024);
  assert.equal(snap.memAvailableBytes, 1234567 * 1024);
  assert.equal(snap.uptimeSeconds, 275559);
  assert.deepEqual(snap.loadavg, [0.42, 0.35, 0.3]);
});

test('parseInfoProbe tolerates partial and garbage lines', () => {
  const snap = parseInfoProbe(
    ['S|Linux||5.10||garbage line', 'CORES|', 'LOADAVG|not numbers', ''].join('\n'),
    { deviceId: 'd', kind: 'linux' }
  );
  assert.equal(snap.sysname, 'Linux');
  assert.equal(snap.hostname, undefined);
  assert.equal(snap.cpuCores, undefined);
  assert.equal(snap.loadavg, undefined);
});

test('parseProcessesProbe parses procps rows and flags unsupported ps', () => {
  const out = [
    '  123 root                 12.3  1.2    12345  /usr/bin/python3 app.py --mode fast',
    ' 456 ubuntu                 0.5  0.1     1024  /bin/bash',
  ].join('\n');
  const snap = parseProcessesProbe(out, 'd');
  assert.equal(snap.psUnsupported, undefined);
  assert.equal(snap.processes.length, 2);
  assert.equal(snap.processes[0].pid, 123);
  assert.equal(snap.processes[0].user, 'root');
  assert.equal(snap.processes[0].cpuPercent, 12.3);
  assert.equal(snap.processes[0].rssKb, 12345);
  assert.equal(snap.processes[0].command, '/usr/bin/python3 app.py --mode fast');

  const empty = parseProcessesProbe('', 'd');
  assert.equal(empty.psUnsupported, true);
  assert.match(formatProcessList(empty, 'x@y:22'), /unavailable/);
});

test('parseResourcesProbe parses memory, load, and POSIX df rows', () => {
  const out = [
    'MEMTOTAL|8173408',
    'MEMAVAIL|6000000',
    'LOADAVG|0.1 0.2 0.3 1/8 99',
    '/dev/mmcblk0p8      30800600 12345600 16893400  43% /',
    'tmpfs                  495216     1234   493982   1% /dev/shm',
  ].join('\n');
  const snap = parseResourcesProbe(out, 'd');
  assert.equal(snap.memTotalBytes, 8173408 * 1024);
  assert.deepEqual(snap.loadavg, [0.1, 0.2, 0.3]);
  assert.equal(snap.disks.length, 2);
  assert.equal(snap.disks[0].mount, '/');
  assert.equal(snap.disks[0].usedPercent, 43);
  assert.equal(snap.disks[0].availableBytes, 16893400 * 1024);
  const text = formatResourceSnapshot(snap, 'root@1.2.3.4:22');
  assert.match(text, /resources on d/);
  assert.match(text, /\/dev\/mmcblk0p8/);
});

test('parseTemperatureProbe converts milli-celsius and handles empty zones', () => {
  const snap = parseTemperatureProbe(
    ['ZONE|thermal_zone0|cpu-thermal|45000', 'ZONE|thermal_zone1|soc-thermal|52005'].join('\n'),
    'd'
  );
  assert.equal(snap.zones.length, 2);
  assert.equal(snap.zones[0].celsius, 45);
  assert.equal(snap.zones[1].celsius, 52);
  assert.equal(snap.zones[1].label, 'soc-thermal');

  const none = parseTemperatureProbe('', 'd');
  assert.equal(none.zones.length, 0);
  assert.match(formatTemperatureSnapshot(none), /No thermal zones/);
});

test('parseRoboticsProbe detects TROS, upstream ROS, and plain Linux hosts', () => {
  const tros = parseRoboticsProbe(
    [
      'ROSDIR|/opt/tros|tros',
      'ROS2BIN|/opt/tros/bin/ros2',
      'TROSVER|/opt/tros/version|2.1.1',
      'HBM|present',
    ].join('\n'),
    'rdk-x5-001'
  );
  assert.equal(tros.installations.length, 1);
  assert.equal(tros.installations[0].distro, 'tros');
  assert.deepEqual(tros.ros2Binaries, ['/opt/tros/bin/ros2']);
  assert.equal(tros.trosVersion, '2.1.1');
  assert.equal(tros.hbmPresent, true);
  const trosText = formatRoboticsSnapshot(tros, 'root@10.0.0.1:22');
  assert.match(trosText, /\/opt\/tros \(distro: tros\)/);
  assert.match(trosText, /TROS version: 2\.1\.1/);
  assert.match(trosText, /source \/opt\/tros\/setup\.bash && ros2 node list/);

  const humble = parseRoboticsProbe(
    ['ROSDIR|/opt/ros/humble|humble', 'ROS2BIN|/opt/ros/humble/bin/ros2'].join('\n'),
    'linux-1'
  );
  assert.equal(humble.installations[0].distro, 'humble');
  assert.equal(humble.trosVersion, undefined);

  const none = parseRoboticsProbe('', 'plain');
  assert.equal(none.installations.length, 0);
  assert.match(formatRoboticsSnapshot(none, 'x:22'), /none detected/);
});

test('parseNetworkProbe parses addresses, routes, and link states', () => {
  const snap = parseNetworkProbe(
    [
      'ADDR|eth0|inet|192.168.1.10/24',
      'ADDR|eth0|inet6|fe80::1/64',
      'ROUTE|default via 192.168.1.1 dev eth0',
      'LINK|eth0|UP',
      'LINK|wlan0|DOWN',
    ].join('\n'),
    'rdk-x5-001'
  );
  assert.equal(snap.addresses.length, 2);
  assert.deepEqual(snap.addresses[0], {
    interface: 'eth0',
    family: 'inet',
    cidr: '192.168.1.10/24',
  });
  assert.equal(snap.defaultRoute, 'default via 192.168.1.1 dev eth0');
  assert.deepEqual(snap.links, [
    { interface: 'eth0', state: 'UP' },
    { interface: 'wlan0', state: 'DOWN' },
  ]);
  const text = formatNetworkSnapshot(snap, 'root@x:22');
  assert.match(text, /eth0 \(UP\): inet 192\.168\.1\.10\/24/);
  assert.match(text, /wlan0 \(DOWN\): no global address/);
  assert.match(text, /default route: default via 192\.168\.1\.1/);
  assert.match(formatNetworkSnapshot(parseNetworkProbe('', 'd'), 'x:22'), /no interfaces parsed/);
});

test('parseCamerasProbe enumerates v4l2 devices with sensor names', () => {
  const snap = parseCamerasProbe(
    [
      'CAM|video0|m00_b_rgb_8bpp_1920x1080',
      'CAM|video1|m00_b_ir_10bpp_1280x1024',
      'V4L2DEV|/dev/video0',
      'V4L2DEV|/dev/video1',
    ].join('\n'),
    'rdk-x5-001'
  );
  assert.equal(snap.cameras.length, 2);
  assert.equal(snap.cameras[0].name, 'm00_b_rgb_8bpp_1920x1080');
  const text = formatCamerasSnapshot(snap, 'root@x:22');
  assert.match(text, /2 v4l2 device\(s\)/);
  assert.match(text, /m00_b_rgb_8bpp_1920x1080/);
  assert.match(formatCamerasSnapshot(parseCamerasProbe('', 'd'), 'x:22'), /none detected/);
});

test('formatters render compact human-readable output', () => {
  assert.equal(formatBytes(1024 * 1024 * 1024 * 3.5), '3.5 GiB');
  assert.equal(formatBytes(1024 * 1024 * 512), '512.0 MiB');
  assert.equal(formatUptime(3 * 86400 + 4 * 3600), '3d 4h');
  assert.equal(formatUptime(90 * 60), '1h 30m');

  const info = parseInfoProbe(INFO_FIXTURE, { deviceId: 'rdk-1', kind: 'rdk' });
  const text = formatInfoSnapshot(info, 'root@10.0.0.1:22');
  assert.match(text, /rdk-1/);
  assert.match(text, /Ubuntu 22\.04\.5 LTS/);
  assert.match(text, /Cortex-A55 \| hardware: sun55iw3/);
  assert.match(text, /GiB total/);
});
