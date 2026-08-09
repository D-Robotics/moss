#!/usr/bin/env node
/**
 * exec_wait / waitForBackgroundProcesses — multi-task wait_any / wait_all on
 * background commands (grok-build wait_commands_or_subagents parity).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  execBackgroundTool,
  waitForBackgroundProcesses,
  clearBackgroundRegistryForTests,
  stopBackgroundProcess,
} from '../dist/tools/background-exec.js';

const ctx = () => ({ abortSignal: new AbortController().signal });

async function start(cmd) {
  const out = await execBackgroundTool.execute({ command: cmd, settle_ms: 100 }, ctx());
  const m = String(out).match(/Started (bg_\d+)/);
  if (!m) throw new Error(`could not parse bg id from: ${out}`);
  return m[1];
}

function sleepCommand(ms) {
  return `node test/helpers/background-sleep.mjs ${ms}`;
}

test('wait_all returns completed when every id finishes', async () => {
  clearBackgroundRegistryForTests();
  try {
    const a = await start(sleepCommand(200));
    const b = await start(sleepCommand(350));
    const r = await waitForBackgroundProcesses([a, b], 'wait_all', 5000);
    assert.equal(r.completed, true, 'wait_all satisfied');
    assert.equal(r.aborted, false);
    assert.deepEqual(r.missing, []);
    assert.equal(r.snapshots.length, 2);
    for (const s of r.snapshots) assert.notEqual(s.status, 'running');
  } finally {
    clearBackgroundRegistryForTests();
  }
});

test('wait_any returns completed when the first id finishes', async () => {
  clearBackgroundRegistryForTests();
  try {
    const fast = await start(sleepCommand(150));
    const slow = await start(sleepCommand(5_000)); // still running when fast finishes
    const r = await waitForBackgroundProcesses([fast, slow], 'wait_any', 3000);
    assert.equal(r.completed, true, 'wait_any satisfied by the fast one');
    const slowSnap = r.snapshots.find((s) => s.id === slow);
    assert.ok(slowSnap, 'slow id present in snapshots');
    // Slow may still be running at wait_any resolution — that is the point.
    stopBackgroundProcess(slow);
  } finally {
    clearBackgroundRegistryForTests();
  }
});

test('unknown ids are reported in missing and do not hang the wait', async () => {
  clearBackgroundRegistryForTests();
  try {
    const a = await start(sleepCommand(100));
    const r = await waitForBackgroundProcesses([a, 'bg_nonexistent'], 'wait_all', 3000);
    assert.equal(r.completed, true, 'unknown id treated as done so wait_all resolves');
    assert.deepEqual(r.missing, ['bg_nonexistent']);
  } finally {
    clearBackgroundRegistryForTests();
  }
});

test('wait times out when an id stays running', async () => {
  clearBackgroundRegistryForTests();
  try {
    const long = await start(sleepCommand(8_000));
    const r = await waitForBackgroundProcesses([long], 'wait_all', 500);
    assert.equal(r.completed, false, 'timed out');
    assert.equal(r.aborted, false);
    assert.equal(r.snapshots.length, 1);
    stopBackgroundProcess(long);
  } finally {
    clearBackgroundRegistryForTests();
  }
});

test('abort signal cuts the wait short', async () => {
  clearBackgroundRegistryForTests();
  try {
    const long = await start(sleepCommand(8_000));
    const controller = new AbortController();
    const promise = waitForBackgroundProcesses([long], 'wait_all', 5000, {
      signal: controller.signal,
    });
    controller.abort();
    const r = await promise;
    assert.equal(r.aborted, true, 'aborted flag set');
    stopBackgroundProcess(long);
  } finally {
    clearBackgroundRegistryForTests();
  }
});
