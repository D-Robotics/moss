#!/usr/bin/env node
/**
 * background-exec — output capture + stop kill + safety gate.
 *
 * The subsystem previously had zero tests. These pin down:
 *  (1) full output capture for a fast-exiting process — 'exit' was used instead
 *      of 'close', so tail output could be lost when the process exited before
 *      the stdout pipe drained;
 *  (2) exec_stop kills a long-running process (SIGTERM → SIGKILL escalation);
 *  (3) exec_background blocks dangerous commands (isCommandDangerous gate).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  execBackgroundTool,
  execLogsTool,
  execStopTool,
  clearBackgroundRegistryForTests,
  getBackgroundProcessSnapshot,
  listBackgroundProcessSnapshots,
  setKillEscalationMsForTests,
} from '../dist/tools/background-exec.js';

const ctx = () => ({ abortSignal: new AbortController().signal });
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-background-exec-'));
const quote = (value) => process.platform === 'win32'
  ? `"${String(value).replaceAll('"', '""')}"`
  : `'${String(value).replaceAll("'", "'\\''")}'`;
const writeScript = (name, source) => {
  const file = path.join(testDir, name);
  fs.writeFileSync(file, source);
  return file;
};
const outputScript = writeScript('output.cjs', 'console.log("line1\\nline2\\nline3")');
const sleepScript = writeScript('sleep.cjs', 'setInterval(() => {}, 1000)');

async function waitForTerminalStatus(id, timeoutMs = 8000) {
  // Poll the snapshot — subscribing to lifecycle events races with fast-exiting
  // processes (the 'close' notification can fire before a post-execute
  // subscription is in place).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = getBackgroundProcessSnapshot(id);
    if (snap && (snap.status === 'exited' || snap.status === 'killed' || snap.status === 'error')) {
      return snap;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

function extractBgId(out) {
  const m = out.match(/bg_\d+/);
  return m ? m[0] : null;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForProcessExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isProcessAlive(pid);
}

// ─── 1. pre-aborted execution fails before spawn/registry ──────────────────
{
  clearBackgroundRegistryForTests();
  const controller = new AbortController();
  controller.abort();
  const out = await execBackgroundTool.execute(
    { command: `${quote(process.execPath)} ${quote(sleepScript)}`, settle_ms: 0 },
    { abortSignal: controller.signal },
  );
  assert.match(out, /abort|cancel/i, 'pre-aborted execution reports cancellation');
  assert.deepEqual(
    listBackgroundProcessSnapshots(),
    [],
    'pre-aborted execution does not spawn or register a process',
  );
}

// ─── 2. full output captured for a fast-exiting process (exit vs close) ─────
{
  clearBackgroundRegistryForTests();
  const out = await execBackgroundTool.execute(
    { command: `${quote(process.execPath)} ${quote(outputScript)}`, settle_ms: 0 },
    ctx(),
  );
  const id = extractBgId(out);
  assert.ok(id, `exec_background returned a bg id: ${out}`);
  const term = await waitForTerminalStatus(id);
  assert.ok(term, 'process reached a terminal status');
  const logs = await execLogsTool.execute({ id, tail: 100 }, ctx());
  assert.ok(/line1/.test(logs), 'line1 captured');
  assert.ok(/line2/.test(logs), 'line2 captured (tail not lost to the exit-before-drain race)');
  assert.ok(/line3/.test(logs), 'line3 captured');
}

// ─── 3. exec_stop kills a long-running process ─────────────────────────────
{
  setKillEscalationMsForTests(200); // speed up SIGTERM → SIGKILL
  clearBackgroundRegistryForTests();
  const out = await execBackgroundTool.execute(
    { command: `${quote(process.execPath)} ${quote(sleepScript)}`, settle_ms: 0 },
    ctx(),
  );
  const id = extractBgId(out);
  assert.ok(id, 'long-running process started');
  const stopResult = await execStopTool.execute({ id }, ctx());
  assert.match(stopResult, /kill|stop|terminat/i, 'exec_stop reports termination');
  const term = await waitForTerminalStatus(id, 3000);
  assert.ok(term, 'long-running process reached terminal status after stop');
  // On POSIX, exec_stop sends SIGTERM→SIGKILL → status 'killed'. On Windows,
  // process termination semantics differ (no Unix signals) → status 'exited'.
  // Both mean the process was successfully terminated by exec_stop.
  assert.ok(
    term.status === 'killed' || term.status === 'exited',
    `process terminated by exec_stop (got status: ${term.status})`,
  );
}

// ─── 4. abort kills the process tree and reaches a terminal state ──────────
{
  setKillEscalationMsForTests(200);
  clearBackgroundRegistryForTests();
  const controller = new AbortController();
  const parentScript = [
    'const { spawn } = require("node:child_process")',
    `const child = spawn(process.execPath, [${JSON.stringify(sleepScript)}], { stdio: "ignore" })`,
    'console.log(child.pid)',
    'setInterval(() => {}, 1000)',
  ].join(';');
  const parentScriptPath = writeScript('parent.cjs', parentScript);
  const command = `${quote(process.execPath)} ${quote(parentScriptPath)}`;
  const out = await execBackgroundTool.execute(
    { command, settle_ms: 50 },
    { abortSignal: controller.signal },
  );
  const id = extractBgId(out);
  assert.ok(id, `background process returned before cancellation: ${out}`);

  let childPid = null;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !childPid) {
    const logs = await execLogsTool.execute({ id, tail: 20 }, ctx());
    const match = logs.match(/(?:^|\n)(\d+)(?:\n|$)/);
    childPid = match ? Number(match[1]) : null;
    if (!childPid) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(childPid, 'child process pid was captured before cancellation');

  controller.abort();
  const term = await waitForTerminalStatus(id, 3000);
  assert.ok(term, 'aborted process reached a terminal registry status');
  assert.equal(term.status, 'killed', `aborted process is observable as killed, got ${term.status}`);
  if (process.platform !== 'win32') {
    assert.equal(
      await waitForProcessExit(childPid, 3000),
      true,
      'abort kills descendants in the detached POSIX process group',
    );
  }
}

// ─── 5. exec_background blocks dangerous commands ──────────────────────────
{
  clearBackgroundRegistryForTests();
  const out = await execBackgroundTool.execute(
    { command: 'rm -rf /', settle_ms: 0 },
    ctx(),
  );
  assert.match(out, /block/i, 'dangerous command is blocked by the safety gate');
}

console.log('  [PASS] background-exec: abort lifecycle, output capture, stop kill, safety gate');
clearBackgroundRegistryForTests();
fs.rmSync(testDir, { recursive: true, force: true });
