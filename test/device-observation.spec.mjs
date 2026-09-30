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
  formatInfoSnapshot,
  formatProcessList,
  formatResourceSnapshot,
  formatTemperatureSnapshot,
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
