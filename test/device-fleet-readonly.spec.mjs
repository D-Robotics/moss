#!/usr/bin/env node
/**
 * Fleet MVP (v0.25) — the read-only multi-device fan-out boundary plus its CLI
 * surface.
 *
 * Covers the contract's invariants that matter for "which devices ran and what
 * came back":
 *   - explicit registry selection: trim/dedupe preserving order, empty selector
 *     flagged (never an implicit default or whole-registry fan-out), unknown ids
 *     collected so nothing connects;
 *   - bounded concurrency and mirrored result order;
 *   - one device failing never erases its peers (three-state outcome);
 *   - abort marks every unfinished device `fail`, never `pass`;
 *   - `moss device fleet <probe> --devices ...` over REAL in-process ssh2
 *     devices (exit 0 = all-pass; partial/all-fail distinguishable).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runFleetReadonly, FLEET_DEFAULT_CONCURRENCY } from '../dist/device/fleet-readonly.js';
import { resolveDeviceTargets } from '../dist/device/device-target.js';
import { saveDeviceRegistry } from '../dist/device/device-registry-file.js';
import { runDeviceCommand } from '../dist/cli/device-commands.js';
import { startInProcessSshDevice } from './helpers/in-process-ssh-device.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function target(id, overrides = {}) {
  return { deviceId: id, kind: 'linux', host: '127.0.0.1', port: 22, user: 'root', ...overrides };
}

/** A DeviceConnection stand-in exposing only what a read-only probe uses. */
function fakeConn(exec) {
  return { exec, readFile: async () => '', listDir: async () => [], writeFile: async () => {} };
}

function capture() {
  const out = [];
  const err = [];
  const prevOut = process.stdout.write.bind(process.stdout);
  const prevErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => (out.push(String(chunk)), true);
  process.stderr.write = (chunk) => (err.push(String(chunk)), true);
  return {
    out,
    err,
    restore: () => {
      process.stdout.write = prevOut;
      process.stderr.write = prevErr;
    },
  };
}

test('resolveDeviceTargets: registry-only, trimmed, deduped, nothing on empty', async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-fleet-select-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  saveDeviceRegistry(ws, [target('a'), target('b'), target('c')]);

  const deduped = resolveDeviceTargets([' b ', 'a', 'b', '', 'c'], { workspaceDir: ws });
  assert.deepEqual(
    deduped.targets.map((x) => x.deviceId),
    ['b', 'a', 'c'],
    'order preserved after trim + dedupe'
  );
  assert.deepEqual(deduped.missing, []);

  const empty = resolveDeviceTargets(['   '], { workspaceDir: ws });
  assert.equal(empty.empty, true);
  assert.deepEqual(empty.targets, []);
  const noArg = resolveDeviceTargets([], { workspaceDir: ws });
  assert.equal(noArg.empty, true, 'no selector is not an implicit full-registry fan-out');

  const missing = resolveDeviceTargets(['a', 'ghost', 'b', 'also-ghost'], { workspaceDir: ws });
  assert.deepEqual(missing.missing, ['ghost', 'also-ghost']);
  assert.deepEqual(
    missing.targets.map((x) => x.deviceId),
    ['a', 'b'],
    'known ids still resolve alongside the missing ones'
  );
});

test('runFleetReadonly: bounded concurrency, mirrored order, three-state outcome', async () => {
  const targets = ['t0', 't1', 't2', 't3', 't4', 't5', 't6'].map((id) => target(id));
  let inFlight = 0;
  let peak = 0;
  const getConnection = async (tgt) =>
    fakeConn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Stagger completion so the fastest device is not always the first index.
      await sleep(5 + (targets.length - targets.indexOf(tgt)) * 4);
      inFlight -= 1;
      return { stdout: `ok:${tgt.deviceId}`, stderr: '', exitCode: 0, timedOut: false };
    });

  const result = await runFleetReadonly(
    targets,
    (conn, tgt) => conn.exec('probe').then((r) => r.stdout),
    { concurrency: 3, getConnection }
  );

  assert.ok(peak <= 3, `never exceeds the concurrency cap (peak ${peak})`);
  assert.ok(peak >= 2, 'actually runs probes in parallel');
  assert.equal(result.outcome, 'all-pass');
  assert.deepEqual(
    result.selector,
    targets.map((t) => t.deviceId)
  );
  assert.deepEqual(
    result.results.map((r) => r.deviceId),
    targets.map((t) => t.deviceId),
    'results mirror input order, not completion order'
  );
  assert.deepEqual(
    result.results.map((r) => r.result),
    targets.map((t) => `ok:${t.deviceId}`)
  );
  assert.equal(FLEET_DEFAULT_CONCURRENCY, 4);
});

test('runFleetReadonly: one device failing never erases its peers', async () => {
  const targets = ['good-1', 'bad', 'good-2'].map((id) => target(id));
  const getConnection = async (tgt) =>
    fakeConn(async () => {
      if (tgt.deviceId === 'bad') throw new Error('connection refused');
      return { stdout: 'fine', stderr: '', exitCode: 0, timedOut: false };
    });

  const result = await runFleetReadonly(
    targets,
    (conn) => conn.exec('probe').then((r) => r.stdout),
    { getConnection }
  );

  assert.equal(result.outcome, 'partial');
  assert.equal(result.results[0].status, 'pass');
  assert.equal(result.results[1].status, 'fail');
  assert.match(result.results[1].error, /connection refused/);
  assert.equal(result.results[1].result, undefined);
  assert.equal(result.results[2].status, 'pass', 'the peer after the failure still ran');
  assert.equal(result.results[2].result, 'fine');
});

test('runFleetReadonly: all failing is all-fail; empty selector is all-fail with no results', async () => {
  const targets = ['x', 'y'].map((id) => target(id));
  const result = await runFleetReadonly(
    targets,
    async () => {
      throw new Error('unreachable');
    },
    { getConnection: async () => fakeConn(async () => ({ stdout: '', exitCode: 0 })) }
  );
  assert.equal(result.outcome, 'all-fail');
  assert.deepEqual(
    result.results.map((r) => r.status),
    ['fail', 'fail']
  );

  const empty = await runFleetReadonly([], async () => 'nope', {});
  assert.equal(empty.outcome, 'all-fail');
  assert.deepEqual(empty.results, []);
  assert.deepEqual(empty.selector, []);
});

test('runFleetReadonly: abort marks every unfinished device fail, never pass', async () => {
  const targets = ['a', 'b', 'c', 'd'].map((id) => target(id));
  // Abort-aware probe exactly like the real CLI probes: it forwards the signal
  // into the transport so an abort during execution surfaces as a throw.
  const probe = (conn, _tgt, signal) => conn.exec('p', { signal }).then((r) => r.stdout);
  const getConnection = async () =>
    fakeConn(async (_cmd, opts) => {
      if (opts?.signal?.aborted) throw new Error('aborted');
      await sleep(20);
      if (opts?.signal?.aborted) throw new Error('aborted during probe');
      return { stdout: 'late', stderr: '', exitCode: 0, timedOut: false };
    });

  const preAbortedCtrl = new AbortController();
  preAbortedCtrl.abort();
  const preAborted = await runFleetReadonly(targets, probe, {
    signal: preAbortedCtrl.signal,
    getConnection,
  });
  assert.equal(preAborted.outcome, 'all-fail');
  assert.ok(
    preAborted.results.every((r) => r.status === 'fail' && r.error === 'aborted before start'),
    'a pre-aborted run starts nothing and reports every device failed'
  );

  const mid = new AbortController();
  setTimeout(() => mid.abort(), 8);
  const midAborted = await runFleetReadonly(targets, probe, {
    concurrency: 1,
    signal: mid.signal,
    getConnection,
  });
  assert.equal(midAborted.outcome, 'all-fail');
  assert.ok(
    midAborted.results.every((r) => r.status === 'fail'),
    'an aborted run never reports pass'
  );
});

test('moss device fleet: real in-process devices, all-pass exits 0', async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-fleet-cli-'));
  const { INFO_PROBE_SCRIPT } = await import('../dist/device/observation.js');
  const probeOutput = [
    'S|Linux|root|6.1.0-mock|x86_64',
    'CPU|Mock CPU',
    'HW|Mock Board',
    'OS|Ubuntu 22.04.5 LTS',
    'CORES|8',
    'MEMTOTAL|16384000',
    'MEMAVAIL|8000000',
    'UPTIME|12345',
    'LOAD|0.10 0.20 0.30',
  ].join('\n');

  const s1 = await startInProcessSshDevice({
    user: 'root',
    password: 'swordfish',
    commands: { [INFO_PROBE_SCRIPT]: { stdout: probeOutput, exit: 0 } },
  });
  const s2 = await startInProcessSshDevice({
    user: 'root',
    password: 'swordfish',
    commands: { [INFO_PROBE_SCRIPT]: { stdout: probeOutput, exit: 0 } },
  });
  const passVar = 'MOSS_FLEET_TEST_PASSWORD';
  const prevPass = process.env[passVar];
  process.env[passVar] = 'swordfish';
  const { disconnectAllDevices } = await import('../dist/device/device-registry.js');

  t.after(async () => {
    await disconnectAllDevices();
    await s1.close();
    await s2.close();
    if (prevPass === undefined) delete process.env[passVar];
    else process.env[passVar] = prevPass;
    fs.rmSync(ws, { recursive: true, force: true });
  });
  saveDeviceRegistry(ws, [
    target('board-a', {
      host: '127.0.0.1',
      port: s1.port,
      user: 'root',
      auth: { method: 'password', passwordEnvVar: passVar },
    }),
    target('board-b', {
      host: '127.0.0.1',
      port: s2.port,
      user: 'root',
      auth: { method: 'password', passwordEnvVar: passVar },
    }),
  ]);

  const cap = capture();
  let code;
  try {
    code = await runDeviceCommand(['fleet', 'info', '--devices', 'board-a,board-b'], {
      workspaceDir: ws,
    });
  } finally {
    cap.restore();
  }
  const text = cap.out.join('');
  assert.equal(code, 0, `all-pass exits 0: ${cap.err.join('')}`);
  assert.match(text, /board-a/);
  assert.match(text, /board-b/);
  assert.match(text, /all-pass/);
  assert.match(text, /Mock Board/, 'the probe result body is printed');

  // Unknown id in the selector: fail before connecting anything (exit 1).
  const cap2 = capture();
  let code2;
  try {
    code2 = await runDeviceCommand(['fleet', 'info', '--devices', 'board-a,ghost'], {
      workspaceDir: ws,
    });
  } finally {
    cap2.restore();
  }
  assert.equal(code2, 1);
  assert.match(cap2.err.join(''), /ghost/);

  // Usage errors: unknown probe / missing --devices / path-requiring probe
  // without a path all exit 2 without touching a connection.
  for (const argv of [
    ['fleet', 'nonsense', '--devices', 'board-a'],
    ['fleet', 'info'],
    ['fleet', 'file_read', '--devices', 'board-a'],
  ]) {
    const c = capture();
    let rc;
    try {
      rc = await runDeviceCommand(argv, { workspaceDir: ws });
    } finally {
      c.restore();
    }
    assert.equal(rc, 2, `${argv.join(' ')} is a usage error`);
  }
});

test('moss device fleet: all-pass / partial / all-fail over two live devices + one failing device', async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-fleet-tri-'));
  const { INFO_PROBE_SCRIPT } = await import('../dist/device/observation.js');
  const probeOutput = [
    'S|Linux|root|6.1.0-mock|x86_64',
    'CPU|Mock CPU',
    'HW|Mock Board',
    'OS|Ubuntu 22.04.5 LTS',
    'CORES|8',
    'MEMTOTAL|16384000',
    'MEMAVAIL|8000000',
    'UPTIME|12345',
    'LOAD|0.10 0.20 0.30',
  ].join('\n');
  const good = () =>
    startInProcessSshDevice({
      user: 'root',
      password: 'swordfish',
      commands: { [INFO_PROBE_SCRIPT]: { stdout: probeOutput, exit: 0 } },
    });
  const s1 = await good();
  const s2 = await good();
  // A sshd that is genuinely reachable but rejects our credentials: a real
  // device-level failure, distinct from a transport that never answers. Its
  // password differs from the env var we register, so every auth attempt fails.
  const s3 = await startInProcessSshDevice({
    user: 'root',
    password: 'correct-horse',
    commands: { [INFO_PROBE_SCRIPT]: { stdout: probeOutput, exit: 0 } },
  });
  const okVar = 'MOSS_FLEET_TRI_OK';
  const badVar = 'MOSS_FLEET_TRI_BAD';
  const prevOk = process.env[okVar];
  const prevBad = process.env[badVar];
  process.env[okVar] = 'swordfish';
  process.env[badVar] = 'battery-staple'; // never the sshd's password
  const { disconnectAllDevices } = await import('../dist/device/device-registry.js');

  t.after(async () => {
    await disconnectAllDevices();
    await s1.close();
    await s2.close();
    await s3.close();
    if (prevOk === undefined) delete process.env[okVar];
    else process.env[okVar] = prevOk;
    if (prevBad === undefined) delete process.env[badVar];
    else process.env[badVar] = prevBad;
    fs.rmSync(ws, { recursive: true, force: true });
  });
  saveDeviceRegistry(ws, [
    target('good-a', {
      host: '127.0.0.1',
      port: s1.port,
      user: 'root',
      auth: { method: 'password', passwordEnvVar: okVar },
    }),
    target('good-b', {
      host: '127.0.0.1',
      port: s2.port,
      user: 'root',
      auth: { method: 'password', passwordEnvVar: okVar },
    }),
    target('locked', {
      host: '127.0.0.1',
      port: s3.port,
      user: 'root',
      auth: { method: 'password', passwordEnvVar: badVar },
    }),
  ]);

  const runFleet = async (ids) => {
    const cap = capture();
    let code;
    try {
      code = await runDeviceCommand(['fleet', 'info', '--devices', ids], { workspaceDir: ws });
    } finally {
      cap.restore();
    }
    return { code, text: cap.out.join(''), err: cap.err.join('') };
  };

  const all = await runFleet('good-a,good-b');
  assert.equal(all.code, 0, `all-pass exits 0: ${all.err}`);
  assert.match(all.text, /all-pass/);
  assert.match(all.text, /✓ good-a/);
  assert.match(all.text, /✓ good-b/);
  assert.match(all.text, /2\/2 passed/);

  // A failing peer must not erase its neighbour; each line still names its own
  // deviceId, and a non-all-pass run exits non-zero.
  const partial = await runFleet('good-a,locked');
  assert.equal(partial.code, 1, `partial exits 1: ${partial.err}`);
  assert.match(partial.text, /partial/);
  assert.match(partial.text, /✓ good-a/, 'the good device still passed');
  assert.match(partial.text, /✗ locked/, 'each result line carries its deviceId');
  assert.match(partial.text, /1\/2 passed/);

  const none = await runFleet('locked');
  assert.equal(none.code, 1, `all-fail exits 1: ${none.err}`);
  assert.match(none.text, /all-fail/);
  assert.match(none.text, /✗ locked/, 'the deviceId is present even with no peers');
  assert.match(none.text, /0\/1 passed/);
});

test('moss device fleet speaks the user locale (zh)', async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-fleet-zh-'));
  const { INFO_PROBE_SCRIPT } = await import('../dist/device/observation.js');
  const probeOutput = [
    'S|Linux|root|6.1.0-mock|x86_64',
    'CPU|Mock CPU',
    'HW|Mock Board',
    'OS|Ubuntu 22.04.5 LTS',
    'CORES|8',
    'MEMTOTAL|16384000',
    'MEMAVAIL|8000000',
    'UPTIME|12345',
    'LOAD|0.10 0.20 0.30',
  ].join('\n');
  const s1 = await startInProcessSshDevice({
    user: 'root',
    password: 'swordfish',
    commands: { [INFO_PROBE_SCRIPT]: { stdout: probeOutput, exit: 0 } },
  });
  const passVar = 'MOSS_FLEET_ZH_PASSWORD';
  const prevPass = process.env[passVar];
  const savedLang = process.env.LANG;
  const savedLcAll = process.env.LC_ALL;
  process.env[passVar] = 'swordfish';
  process.env.LANG = 'zh_CN.UTF-8';
  process.env.LC_ALL = 'zh_CN.UTF-8';
  const { disconnectAllDevices } = await import('../dist/device/device-registry.js');

  t.after(async () => {
    await disconnectAllDevices();
    await s1.close();
    if (prevPass === undefined) delete process.env[passVar];
    else process.env[passVar] = prevPass;
    if (savedLang === undefined) delete process.env.LANG;
    else process.env.LANG = savedLang;
    if (savedLcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = savedLcAll;
    fs.rmSync(ws, { recursive: true, force: true });
  });
  saveDeviceRegistry(ws, [
    target('board-zh', {
      host: '127.0.0.1',
      port: s1.port,
      user: 'root',
      auth: { method: 'password', passwordEnvVar: passVar },
    }),
  ]);

  const cap = capture();
  let code;
  try {
    code = await runDeviceCommand(['fleet', 'info', '--devices', 'board-zh'], { workspaceDir: ws });
  } finally {
    cap.restore();
  }
  const text = cap.out.join('');
  assert.equal(code, 0, cap.err.join(''));
  assert.match(text, /结果：all-pass/, 'the aggregate line is Chinese');
  assert.match(text, /1 台设备/, 'the header count is Chinese');
  assert.match(text, /board-zh/, 'device ids stay verbatim');
  assert.ok(!text.includes('outcome:'), 'zh output does not mix the English aggregate label');
});
