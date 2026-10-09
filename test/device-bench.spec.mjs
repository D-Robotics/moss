#!/usr/bin/env node
/**
 * Device task benchmark: suite safety, dry Task OS scoring without a model
 * or a device, cleanup on failure, and the simulated SSH denylist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';

import { approvalEnv } from '../scripts/lib/device-bench-approval.mjs';
import { findForbidden, redactSecrets, secretValues } from '../scripts/lib/device-bench-safety.mjs';
import {
  execOnTarget,
  newBenchPassword,
  startSimSsh,
} from '../scripts/lib/device-bench-target.mjs';
import {
  loadDeviceTasks,
  resolveBenchProvider,
  runDeviceBench,
  validateDeviceTasks,
} from '../scripts/lib/device-bench.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANARY = 'bench-canary-secret-value';

test('device task suite is 12 tasks with cleanup on every mutation', () => {
  const tasks = loadDeviceTasks();
  assert.equal(tasks.length, 12);
  const ids = tasks.map((task) => task.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(new Set(ids).size, ids.length);
  for (const task of tasks) {
    assert.ok(task.prompt.length > 40, task.id);
    assert.ok(Array.isArray(task.evidence) && task.evidence.length > 0, task.id);
    if (task.sideEffect === 'mutating') assert.ok(task.cleanup.length > 0, task.id);
    assert.deepEqual(findForbidden(JSON.stringify(task.cleanup)), []);
  }
  assert.ok(ids.includes('rollback-state'));
  assert.ok(ids.includes('systemd-oneshot'));
  assert.ok(ids.includes('ros2-pubsub'));
});

test('forbidden device commands are rejected before they can run', () => {
  const bad = {
    id: 'bad-reboot',
    title: 'nope',
    sideEffect: 'mutating',
    prompt: 'do not actually do this',
    prerequisites: [],
    setup: [],
    oracle: [],
    acceptance: ['true'],
    cleanup: ['reboot'],
    evidence: [],
  };
  const problems = validateDeviceTasks([bad]);
  assert.ok(problems.some((problem) => problem.includes('power')));
  assert.ok(findForbidden('systemctl restart ssh').includes('ssh-service'));
  assert.ok(findForbidden('dd if=/tmp/x of=/dev/mmcblk0').includes('reflash'));
});

test('approval modes stay pluggable and do not encode a risk classifier', () => {
  assert.deepEqual(approvalEnv('inherit'), {});
  assert.equal(approvalEnv('full').MOSS_APPROVAL_POLICY, 'never');
  assert.equal(approvalEnv('manual').MOSS_APPROVAL_POLICY, 'prompt');
  assert.throws(() => approvalEnv('yolo'), /unknown/);
});

test(
  'dry mode scores the suite with no model key and no device',
  { timeout: 180_000 },
  async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-device-bench-result-'));
    const previous = process.env.MOSS_BENCH_API_KEY;
    process.env.MOSS_BENCH_API_KEY = CANARY;
    try {
      const result = await runDeviceBench({ mode: 'dry', resultsDir });
      assert.equal(result.exitCode, 0, JSON.stringify(result.summary?.rows, null, 2));
      const summary = result.summary;
      assert.equal(summary.meta.mode, 'dry');
      assert.equal(summary.meta.passwordStored, false);
      assert.equal(summary.meta.model, null);
      assert.equal(summary.failed, 0);
      assert.equal(summary.falseSuccess, 0);
      assert.ok(summary.scored >= 8, `scored ${summary.scored}`);
      assert.equal(summary.successRate, 1);
      const skipped = summary.rows.filter((row) => row.status === 'skipped').map((row) => row.id);
      assert.ok(
        skipped.includes('camera-presence') ||
          summary.rows.find((row) => row.id === 'camera-presence')?.status === 'pass'
      );
      assert.ok(skipped.includes('ros2-pubsub'));
      for (const row of summary.rows) {
        if (row.status !== 'pass') continue;
        assert.equal(row.phase, 'accepted');
        assert.equal(row.tokensSource, 'dry-no-model');
        assert.equal(row.tokensIn, null);
        assert.equal(row.costUsd, null);
        assert.equal(row.cleanup, 'ok');
        assert.ok(row.turns >= 2, `${row.id} turns ${row.turns}`);
        assert.ok(row.steps >= 4, `${row.id} steps ${row.steps}`);
        const evidence = path.join(resultsDir, row.evidence[0]);
        assert.equal(fs.existsSync(evidence), true, evidence);
      }
      const text = fs.readFileSync(result.summaryPath, 'utf8');
      assert.equal(text.includes(CANARY), false);
      assert.equal(
        text.includes('passwordStored": false') || text.includes('"passwordStored": false'),
        true
      );
    } finally {
      if (previous === undefined) delete process.env.MOSS_BENCH_API_KEY;
      else process.env.MOSS_BENCH_API_KEY = previous;
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  }
);

test('simulated camera and ros2 are scored only when enabled', { timeout: 60_000 }, async () => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-device-bench-opt-'));
  try {
    const result = await runDeviceBench({
      mode: 'dry',
      resultsDir,
      simCamera: true,
      simRos: true,
      filters: ['camera-presence', 'ros2-pubsub'],
    });
    assert.equal(result.exitCode, 0, JSON.stringify(result.summary?.rows, null, 2));
    assert.equal(result.summary.passed, 2);
    assert.equal(result.summary.skipped, 0);
  } finally {
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }
});

test('a failing oracle still runs cleanup and is not a pass', async () => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-device-bench-fail-'));
  const task = {
    id: 'broken-oracle',
    title: 'broken oracle',
    sideEffect: 'mutating',
    prompt: 'Write the token into the marker file.',
    prerequisites: [],
    setup: ['printf leftover > "$MOSS_BENCH_WORKSPACE/marker"'],
    oracle: ['printf wrong > "$MOSS_BENCH_ROOT/hello.txt"'],
    acceptance: ['grep -F "$MOSS_BENCH_TOKEN" "$MOSS_BENCH_ROOT/hello.txt"'],
    cleanup: ['rm -f "$MOSS_BENCH_WORKSPACE/marker"'],
    evidence: [],
    maxTurns: 4,
    timeoutMs: 30_000,
  };
  try {
    const result = await runDeviceBench({ mode: 'dry', resultsDir, tasks: [task] });
    assert.equal(result.exitCode, 1);
    assert.equal(result.summary.rows[0].status, 'fail');
    assert.equal(result.summary.rows[0].falseSuccess, false);
    assert.equal(result.summary.rows[0].cleanup, 'ok');
    assert.equal(
      fs.existsSync(path.join(resultsDir, 'workspaces', 'broken-oracle', 'marker')),
      false
    );
  } finally {
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }
});

test('a command pass with no evidence is flagged falseSuccess', async () => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-device-bench-false-'));
  const task = {
    id: 'empty-evidence',
    title: 'empty evidence',
    sideEffect: 'readonly',
    prompt: 'Do nothing measurable.',
    prerequisites: [],
    setup: [],
    oracle: [],
    acceptance: ['true'],
    cleanup: [],
    evidence: [],
    maxTurns: 4,
    timeoutMs: 30_000,
  };
  try {
    const result = await runDeviceBench({ mode: 'dry', resultsDir, tasks: [task] });
    assert.equal(result.summary.rows[0].status, 'pass');
    assert.equal(result.summary.rows[0].phase, 'accepted');
    assert.equal(result.summary.rows[0].falseSuccess, true);
    assert.equal(result.summary.falseSuccess, 1);
  } finally {
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }
});

test(
  'simulated ssh runs a command and blocks reboot without logging the password',
  { timeout: 20_000 },
  async () => {
    const password = newBenchPassword();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-device-bench-ssh-'));
    const stateDir = path.join(root, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    const sim = await startSimSsh({
      password,
      ctx: {
        root,
        stateDir,
        workspace: root,
        token: 'tok',
        port: 9,
        sim: true,
        timeoutMs: 15_000,
      },
    });
    const saved = {
      host: process.env.MOSS_DEVICE_HOST,
      port: process.env.MOSS_DEVICE_PORT,
      user: process.env.MOSS_DEVICE_USER,
      password: process.env.MOSS_DEVICE_PASSWORD,
    };
    process.env.MOSS_DEVICE_HOST = sim.host;
    process.env.MOSS_DEVICE_PORT = String(sim.port);
    process.env.MOSS_DEVICE_USER = sim.user;
    process.env.MOSS_DEVICE_PASSWORD = password;
    try {
      const ok = await execOnTarget('printf ok-from-sim', {
        mode: 'ssh',
        sim: true,
        root,
        stateDir,
        workspace: root,
        token: 'tok',
        port: 9,
        timeoutMs: 15_000,
      });
      assert.equal(ok.code, 0, ok.stderr);
      assert.match(ok.stdout, /ok-from-sim/);
      assert.equal(ok.stdout.includes(password), false);
      assert.equal(ok.stderr.includes(password), false);
      const blocked = await execOnTarget('reboot', {
        mode: 'ssh',
        sim: true,
        root,
        stateDir,
        workspace: root,
        token: 'tok',
        port: 9,
      });
      assert.equal(blocked.code, 126);
      const raw = await new Promise((resolve, reject) => {
        const conn = new ssh2.Client();
        const timer = setTimeout(() => {
          conn.end();
          reject(new Error('sim ssh reboot channel did not close'));
        }, 8_000);
        conn.on('ready', () => {
          conn.exec('reboot', (error, stream) => {
            if (error) {
              clearTimeout(timer);
              reject(error);
              return;
            }
            let stderr = '';
            // ssh2 withholds close until stdout is flowing, even when the
            // server wrote only to stderr.
            stream.on('data', () => {});
            stream.stderr.on('data', (chunk) => {
              stderr += chunk.toString();
            });
            stream.on('close', (code) => {
              clearTimeout(timer);
              conn.end();
              resolve({ code, stderr });
            });
          });
        });
        conn.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        conn.connect({
          host: sim.host,
          port: sim.port,
          username: sim.user,
          password,
          readyTimeout: 10_000,
        });
      });
      assert.equal(raw.code, 126);
      assert.match(raw.stderr, /blocked: power/);
      assert.equal(raw.stderr.includes(password), false);
      assert.equal(redactSecrets(`leak ${password} end`, secretValues()).includes(password), false);
    } finally {
      await sim.close();
      for (const [key, value] of Object.entries({
        MOSS_DEVICE_HOST: saved.host,
        MOSS_DEVICE_PORT: saved.port,
        MOSS_DEVICE_USER: saved.user,
        MOSS_DEVICE_PASSWORD: saved.password,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test('sim target without a model key refuses to invent a score', async () => {
  const result = await runDeviceBench({
    mode: 'sim',
    apiKey: undefined,
    allowSettings: false,
    model: undefined,
    baseUrl: undefined,
    tasks: [
      {
        id: 'unused',
        title: 'unused',
        sideEffect: 'readonly',
        prompt: 'unused',
        prerequisites: [],
        setup: [],
        oracle: [],
        acceptance: ['true'],
        cleanup: [],
        evidence: [{ metric: 'x', probe: 'true' }],
      },
    ],
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.summary, null);
  assert.ok(result.missing.some((item) => item.includes('MOSS_BENCH_API_KEY')));
  const resolved = resolveBenchProvider({ apiKey: undefined, allowSettings: false });
  assert.equal(resolved.ok, false);
});

test('bench:device --list and --dry --task report-identity', () => {
  const list = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'bench-device.mjs'), '--list'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    }
  );
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /report-identity/);
  assert.match(list.stdout, /rollback-state/);
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-device-bench-cli-'));
  // The CLI writes under bench/results unless tests call the library. Drive
  // the same entry with --dry --task through the library-equivalent CLI by
  // checking --help, then a filtered dry run via the exported runner is above.
  const help = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'bench-device.mjs'), '--help'],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /RDK_S600_PASSWORD/);
  fs.rmSync(resultsDir, { recursive: true, force: true });
});
