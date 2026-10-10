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
import path from 'node:path';
import { execBackgroundTool, execLogsTool, execStopTool } from '../dist/tools/background-exec.js';
import { execTool } from '../dist/tools/builtin.js';
import { appendTaskEvent, createDraftTask } from '../dist/core/task/task-store.js';
import {
  clearBackgroundRegistryForTests,
  getBackgroundProcessSnapshot,
  listBackgroundProcessSnapshots,
  setKillEscalationMsForTests,
} from '../dist/core/tools/background-process-registry.js';

const ctx = () => ({ abortSignal: new AbortController().signal });
const testDir = fs.mkdtempSync(path.join(process.cwd(), '.moss-background-exec-'));
process.on('exit', () => {
  fs.rmSync(testDir, { recursive: true, force: true });
});
const quote = (value) =>
  process.platform === 'win32'
    ? `"${String(value).replaceAll('"', '""')}"`
    : `'${String(value).replaceAll("'", "'\\''")}'`;
const nodeCommand = (scriptPath) => {
  const relativePath = path.relative(process.cwd(), scriptPath).split(path.sep).join('/');
  return `node ${quote(relativePath)}`;
};
const writeScript = (name, source) => {
  const file = path.join(testDir, name);
  fs.writeFileSync(file, source);
  return file;
};
const sleepScript = writeScript('sleep.cjs', 'setInterval(() => {}, 1000)');
const outputCommand =
  process.platform === 'win32'
    ? 'echo line1&echo line2&echo line3'
    : 'printf "line1\\nline2\\nline3\\n"';
const longRunningCommand =
  process.platform === 'win32' ? 'ping -t 127.0.0.1' : nodeCommand(sleepScript);

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
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (/^\d+ \(.+\) Z /.test(stat)) return false;
    } catch {
      return false;
    }
  }
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
    { command: longRunningCommand, settle_ms: 0 },
    { abortSignal: controller.signal }
  );
  assert.match(out, /abort|cancel/i, 'pre-aborted execution reports cancellation');
  assert.deepEqual(
    listBackgroundProcessSnapshots(),
    [],
    'pre-aborted execution does not spawn or register a process'
  );
}

// ─── 2. full output captured for a fast-exiting process (exit vs close) ─────
{
  clearBackgroundRegistryForTests();
  const out = await execBackgroundTool.execute({ command: outputCommand, settle_ms: 0 }, ctx());
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
    { command: longRunningCommand, settle_ms: 0 },
    ctx()
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
    `process terminated by exec_stop (got status: ${term.status})`
  );
}

// ─── 4. abort kills the process tree and reaches a terminal state ──────────
{
  setKillEscalationMsForTests(200);
  clearBackgroundRegistryForTests();
  const controller = new AbortController();
  let command = longRunningCommand;
  if (process.platform !== 'win32') {
    const parentScript = [
      'const { spawn } = require("node:child_process")',
      `const child = spawn(process.execPath, [${JSON.stringify(sleepScript)}], { stdio: "ignore" })`,
      'console.log(child.pid)',
      'setInterval(() => {}, 1000)',
    ].join(';');
    command = nodeCommand(writeScript('parent.cjs', parentScript));
  }
  const out = await execBackgroundTool.execute(
    { command, settle_ms: 50 },
    { abortSignal: controller.signal }
  );
  const id = extractBgId(out);
  assert.ok(id, `background process returned before cancellation: ${out}`);

  let childPid = null;
  if (process.platform !== 'win32') {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !childPid) {
      const logs = await execLogsTool.execute({ id, tail: 20 }, ctx());
      const match = logs.match(/(?:^|\n)(\d+)(?:\n|$)/);
      childPid = match ? Number(match[1]) : null;
      if (!childPid) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(childPid, 'child process pid was captured before cancellation');
  }

  controller.abort();
  const term = await waitForTerminalStatus(id, 3000);
  assert.ok(term, 'aborted process reached a terminal registry status');
  assert.equal(
    term.status,
    'killed',
    `aborted process is observable as killed, got ${term.status}`
  );
  if (childPid) {
    assert.equal(
      await waitForProcessExit(childPid, 3000),
      true,
      'abort kills descendants in the detached POSIX process group'
    );
  }
}

// ─── 5. exec_background blocks dangerous commands ──────────────────────────
{
  clearBackgroundRegistryForTests();
  const out = await execBackgroundTool.execute({ command: 'rm -rf /', settle_ms: 0 }, ctx());
  assert.match(out, /block/i, 'dangerous command is blocked by the safety gate');
}

// ─── 6. /goal waits only when this run injected goalExecWait ──────────────
{
  clearBackgroundRegistryForTests();
  const ws = fs.mkdtempSync(path.join(process.cwd(), '.moss-goal-exec-wait-'));
  const sleepMs = 2000;
  const script = path.join(ws, 'sleep.cjs');
  fs.writeFileSync(script, `setTimeout(() => process.exit(0), ${sleepMs});\n`);
  const command = `node ${quote(script)}`;
  const { taskId } = await createDraftTask(ws, 'diagnosing on disk is not a goal run');
  await appendTaskEvent(ws, taskId, 'execution_started');
  await appendTaskEvent(ws, taskId, 'verification_started');
  await appendTaskEvent(ws, taskId, 'acceptance_fail', { detail: 'no evidence' });
  const diskCtx = { workspaceDir: ws, abortSignal: new AbortController().signal };
  const goalCtx = { ...diskCtx, goalExecWait: true };

  const idleStarted = Date.now();
  const idle = await execBackgroundTool.execute({ command: `node ${quote(sleepScript)}` }, diskCtx);
  const idleElapsed = Date.now() - idleStarted;
  const idleId = extractBgId(idle);
  assert.match(idle, /Still running after/, 'a diagnosing task on disk does not make exec wait');
  assert.ok(idleElapsed < 1700, `no wait outside /goal, elapsed ${idleElapsed}`);
  if (idleId) await execStopTool.execute({ id: idleId }, diskCtx);

  const goalStarted = Date.now();
  const waited = await execTool.execute({ command, run_in_background: true }, goalCtx);
  const goalElapsed = Date.now() - goalStarted;
  assert.doesNotMatch(waited, /Still running after/, `goal exec waited: ${waited}`);
  assert.match(waited, /exited/, `goal exec reports the exit: ${waited}`);
  assert.ok(goalElapsed >= 1700, `goal exec waited past the settle window, elapsed ${goalElapsed}`);

  const optOutStarted = Date.now();
  const optedOut = await execBackgroundTool.execute(
    { command: `node ${quote(sleepScript)}`, wait: false },
    goalCtx
  );
  const optOutElapsed = Date.now() - optOutStarted;
  const optOutId = extractBgId(optedOut);
  assert.match(optedOut, /Still running after/, `wait:false returns fast: ${optedOut}`);
  assert.ok(
    optOutElapsed < 1700,
    `dev server with wait:false returns fast, elapsed ${optOutElapsed}`
  );
  if (optOutId) await execStopTool.execute({ id: optOutId }, goalCtx);

  const settleStarted = Date.now();
  const settled = await execTool.execute(
    { command: `node ${quote(sleepScript)}`, run_in_background: true, settle_ms: 200 },
    goalCtx
  );
  const settleElapsed = Date.now() - settleStarted;
  const settleId = extractBgId(settled);
  assert.match(settled, /Still running after/, `explicit settle_ms stays backgrounded: ${settled}`);
  assert.ok(settleElapsed < 1000, `settle_ms during a goal returns fast, elapsed ${settleElapsed}`);
  if (settleId) await execStopTool.execute({ id: settleId }, goalCtx);

  const capStarted = Date.now();
  const capped = await execBackgroundTool.execute({ command, timeout_ms: 300 }, goalCtx);
  const capElapsed = Date.now() - capStarted;
  const capId = extractBgId(capped);
  assert.match(capped, /exec_wait/, `timeout tells the model how to await: ${capped}`);
  assert.match(capped, /Still running after/, `timeout still returns a handle: ${capped}`);
  assert.ok(capElapsed < 1000, `timeout_ms bounds the wait, elapsed ${capElapsed}`);
  if (capId) await execStopTool.execute({ id: capId }, goalCtx);
  // Windows can still hold the stopped child's handles on ws for a moment.
  fs.rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

// ─── 7. Esc during a goal wait kills the command immediately ───────────────
{
  setKillEscalationMsForTests(200);
  clearBackgroundRegistryForTests();
  const controller = new AbortController();
  const started = Date.now();
  const command = `node ${quote(sleepScript)}`;
  const pending = execBackgroundTool.execute(
    { command, timeout_ms: 4000 },
    { goalExecWait: true, abortSignal: controller.signal }
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  controller.abort();
  const out = await pending;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `esc stopped the goal wait immediately, elapsed ${elapsed}`);
  assert.doesNotMatch(out, /Still running after/, `esc does not leave the wait running: ${out}`);
  const id = extractBgId(out);
  assert.ok(id, `aborted goal exec names the process: ${out}`);
  const term = await waitForTerminalStatus(id, 3000);
  assert.ok(term, 'aborted goal exec reached a terminal status');
  assert.notEqual(term.status, 'running');
  if (term.pid) {
    assert.equal(isProcessAlive(term.pid), false, 'esc kills the waited process');
  }
}

console.log('  [PASS] background-exec: abort lifecycle, output capture, stop kill, safety gate');
clearBackgroundRegistryForTests();
fs.rmSync(testDir, { recursive: true, force: true });
