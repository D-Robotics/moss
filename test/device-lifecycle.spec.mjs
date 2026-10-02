#!/usr/bin/env node
/**
 * `moss device` lifecycle — the registry writes .moss/devices.json with env-var
 * auth references (never secret values); device test connects over a REAL
 * in-process ssh2 server and runs the identity probe; the resolver cascade
 * (host > env > registry) lands registered devices into device tools.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildTargetFromArgv, runDeviceCommand } from '../dist/cli/device-commands.js';
import {
  saveDeviceRegistry,
  registryIsCredentialSafe,
} from '../dist/device/device-registry-file.js';
import { resolveDefaultDeviceTarget } from '../dist/device/device-target.js';
import { startInProcessSshDevice } from './helpers/in-process-ssh-device.mjs';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-device-ws-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-device-home-'));
const ctx = { workspaceDir: ws, env: { ...process.env } };

const stdout = [];
const stderr = [];
const prevOut = process.stdout.write.bind(process.stdout);
const prevErr = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk) => {
  stdout.push(String(chunk));
  return true;
};
process.stderr.write = (chunk) => {
  stderr.push(String(chunk));
  return true;
};

let ssh;
try {
  // ─── argv → target parsing ───────────────────────────────────────────────
  const target = buildTargetFromArgv('board-1', [
    '192.168.1.50',
    '--user',
    'root',
    '--kind',
    'rdk',
    '--password-env',
    'MOSS_DEVICE_PASSWORD',
  ]);
  assert.ok(!('error' in target), 'argv parses');
  assert.equal(target.auth.passwordEnvVar, 'MOSS_DEVICE_PASSWORD', 'auth is a reference');
  const bad = buildTargetFromArgv('b', ['h', '--kind', 'windows']);
  assert.ok('error' in bad, 'bad kind rejected');

  // Credential-safety gate: reference auth passes, embedded values fail.
  assert.ok(registryIsCredentialSafe([target]));
  assert.ok(
    !registryIsCredentialSafe([
      {
        deviceId: 'x',
        kind: 'linux',
        host: 'h',
        auth: { method: 'password', password: 'hunter2' },
      },
    ])
  );

  // ─── add → devices.json → resolver cascade ──────────────────────────────
  let code = await runDeviceCommand(
    [
      'add',
      'board-1',
      '192.168.1.50',
      '--user',
      'root',
      '--kind',
      'rdk',
      '--password-env',
      'MOSS_DEVICE_PASSWORD',
    ],
    ctx
  );
  assert.equal(code, 0, 'add exits 0');
  const file = JSON.parse(fs.readFileSync(path.join(ws, '.moss', 'devices.json'), 'utf8'));
  assert.equal(file.devices[0].deviceId, 'board-1');
  assert.equal(file.devices[0].auth.passwordEnvVar, 'MOSS_DEVICE_PASSWORD');
  assert.ok(!JSON.stringify(file).includes('swordfish'), 'no secret value in the file');

  // Env unset → registry tier resolves.
  const savedHost = process.env.MOSS_DEVICE_HOST;
  delete process.env.MOSS_DEVICE_HOST;
  const resolved = resolveDefaultDeviceTarget({ workspaceDir: ws });
  assert.equal(resolved?.deviceId, 'board-1', 'registry tier resolves the default target');
  // Env present → env wins over the registry (documented precedence).
  process.env.MOSS_DEVICE_HOST = '10.0.0.9';
  assert.equal(
    resolveDefaultDeviceTarget({ workspaceDir: ws })?.host,
    '10.0.0.9',
    'env tier overrides the registry'
  );
  if (savedHost === undefined) delete process.env.MOSS_DEVICE_HOST;
  else process.env.MOSS_DEVICE_HOST = savedHost;

  // ─── list / remove / roundtrip ───────────────────────────────────────────
  stdout.length = 0;
  code = await runDeviceCommand(['list'], ctx);
  assert.equal(code, 0);
  assert.ok(stdout.join('').includes('board-1'));
  code = await runDeviceCommand(['remove', 'nope'], ctx);
  assert.equal(code, 1, 'unknown remove fails');

  // ─── test against a REAL in-process ssh2 server ──────────────────────────
  const { INFO_PROBE_SCRIPT } = await import('../dist/device/observation.js');
  const probeOutput = [
    'S|Linux|tester|6.1.0-mock|x86_64',
    'CPU|Mock CPU',
    'HW|Mock Board',
    'OS|Ubuntu 22.04.5 LTS',
    'CORES|8',
    'MEMTOTAL|16384000',
    'MEMAVAIL|8000000',
    'UPTIME|12345',
    'LOAD|0.10 0.20 0.30',
  ].join('\n');
  ssh = await startInProcessSshDevice({
    user: 'root',
    password: 'swordfish',
    commands: { [INFO_PROBE_SCRIPT]: { stdout: probeOutput, exit: 0 } },
  });
  saveDeviceRegistry(ws, [
    {
      deviceId: 'live-1',
      kind: 'linux',
      host: '127.0.0.1',
      port: ssh.port,
      user: 'root',
      auth: { method: 'password', passwordEnvVar: 'MOSS_DEVICE_TEST_PASSWORD' },
    },
  ]);
  const prevPass = process.env.MOSS_DEVICE_TEST_PASSWORD;
  process.env.MOSS_DEVICE_TEST_PASSWORD = 'swordfish';
  try {
    const savedHost2 = process.env.MOSS_DEVICE_HOST;
    delete process.env.MOSS_DEVICE_HOST;
    stdout.length = 0;
    stderr.length = 0;
    code = await runDeviceCommand(['test', 'live-1'], ctx);
    assert.equal(code, 0, `device test connects: ${stderr.join('')}`);
    assert.ok(stdout.join('').includes('connected'), 'test reports connected');
    if (savedHost2 === undefined) delete process.env.MOSS_DEVICE_HOST;
    else process.env.MOSS_DEVICE_HOST = savedHost2;
  } finally {
    if (prevPass === undefined) delete process.env.MOSS_DEVICE_TEST_PASSWORD;
    else process.env.MOSS_DEVICE_TEST_PASSWORD = prevPass;
  }

  // Wrong password → clear failure with a next step, exit 1. The connection
  // cache keys by target (not credentials), so drop it first to force a fresh
  // handshake with the wrong password.
  process.env.MOSS_DEVICE_TEST_PASSWORD = 'wrong';
  const { disconnectAllDevices } = await import('../dist/device/device-registry.js');
  await disconnectAllDevices();
  const prev2 = process.env.MOSS_DEVICE_HOST;
  delete process.env.MOSS_DEVICE_HOST;
  stderr.length = 0;
  code = await runDeviceCommand(['test', 'live-1'], ctx);
  assert.equal(code, 1, 'bad credentials fail');
  assert.ok(stderr.join('').includes('check host/port/user'), 'failure names the next step');
  if (prev2 === undefined) delete process.env.MOSS_DEVICE_HOST;
  else process.env.MOSS_DEVICE_HOST = prev2;
  process.env.MOSS_DEVICE_TEST_PASSWORD = prevPass ?? 'swordfish';
} finally {
  process.stdout.write = prevOut;
  process.stderr.write = prevErr;
  await ssh?.close();
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('[PASS] device lifecycle (registry + real-ssh test)');
process.exit(0);
